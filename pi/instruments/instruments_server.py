#!/usr/bin/env python3
"""HIL instruments service — measurement hardware wired to the Pi.

Runs beside the upstream portal on its own port. Same conventions as the
portal: JSON over HTTP, every response carries "ok". CORS is open so the
portal dashboard (:8080) can host our panels.

  GET  /api/info          service + detected instruments
  GET  /api/meter/status  voltmeter config and calibration
  POST /api/meter/read    {"samples": 8}            -> volts (calibrated)
  POST /api/meter/config  {"sps": 15|30|60|240, "pga": 1|2|4|8, "autorange": bool}
  GET  /api/meter/stream?since=<seq>   continuous samples [[epoch_ms, volts, ol]]
                          (starts acquisition; stops 15 s after the last poll)
  GET  /api/logic/status  logic analyzer presence, channels, samplerates
  POST /api/logic/capture {"samplerate": "1m", "duration_ms": 1000,
                           "channels": ["D0"], "labels": {"D0": "LED"}, "max_edges": 200,
                           "client": "pytest"}   (client: shown on the dashboard)
                          -> per channel edges [t_s, level], frequency, duty;
                             t0_epoch_ms = first sample on the Pi clock
  POST /api/logic/capture {..., "trigger": "CH1=r,CH2=0", "pre_ms": 100, "timeout_ms": 10000,
                           "cycles": 100}
                          trigger conditions 0 1 r f e (ANDed): waits for it, keeps pre_ms
                          before and duration_ms after; "triggered": false if it never came
                          (not an error). cycles: per-cycle [t_rise, high, period, duty]
  POST /api/logic/arm     same body; returns as soon as samples are flowing (armed),
                          stimulate the DUT, then:
  GET  /api/logic/result?id=<capture_id>&wait_s=30   result of an armed capture
                          (latest if no id; 202 + "done": false while still running)
  GET  /api/logic/state?channels=CH1,CH2&window_ms=20   level of each channel now
  GET  /api/logic/last    last capture result (same shape)
  GET  /api/dut/status    ESP32 USB devices (sysfs) + cached chip/flash/firmware probes
  POST /api/dut/probe     {"slot": "SLOT1"} -> chip, flash, partitions, app descriptors
                          (ROM bootloader session: REBOOTS the DUT)
  GET  /panel/meter.js    dashboard panel (loaded by the portal, see
                          pi/dashboard_panels.py)

Voltmeter = M5Stack Unit ADC v1.1 (ADS1110) on the Pi I2C bus. Single-ended,
not isolated: measures against the bench ground.
Logic analyzer = Saleae Logic clone (FX2, sigrok fx2lafw), probes CH1..CH8 = D0..D7.

Config (optional): /etc/rfc2217/instruments.json
  {"port": 8081, "i2c_bus": 1, "meter_address": 72,
   "meter_scale": 6.1, "meter_offset_v": 0.0, "logic_labels": {"D0": "LED"}}
"""
import http.server
import json
import os
import socketserver
import sys
from urllib.parse import parse_qs, urlparse

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from ads1110 import ADS1110, ADS1110Error, NOMINAL_SCALE  # noqa: E402
from meter_stream import MeterStream  # noqa: E402
from logic import LogicAnalyzer, LogicError  # noqa: E402
from dut import DutProber  # noqa: E402

VERSION = "0.5.0"
HERE = os.path.dirname(os.path.abspath(__file__))
PANELS = {"/panel/meter.js": "panel_meter.js", "/panel/logic.js": "panel_logic.js",
          "/panel/dut.js": "panel_dut.js"}
CONFIG_PATH = "/etc/rfc2217/instruments.json"
DEFAULTS = {"port": 8081, "i2c_bus": 1, "meter_address": 0x48,
            "meter_scale": NOMINAL_SCALE, "meter_offset_v": 0.0, "logic_labels": {}}


def load_config() -> dict:
    cfg = dict(DEFAULTS)
    try:
        with open(CONFIG_PATH) as f:
            cfg.update(json.load(f))
    except FileNotFoundError:
        pass
    return cfg


CFG = load_config()
METER = None
METER_ERROR = None
STREAM = None
LOGIC = LogicAnalyzer(CFG["logic_labels"])
DUT = DutProber()


def init_meter() -> None:
    global METER, METER_ERROR, STREAM
    try:
        if not ADS1110.probe(CFG["i2c_bus"], CFG["meter_address"]):
            raise ADS1110Error(f"no ACK at 0x{CFG['meter_address']:02x} "
                               f"on i2c-{CFG['i2c_bus']}")
        METER = ADS1110(CFG["i2c_bus"], CFG["meter_address"],
                        CFG["meter_scale"], CFG["meter_offset_v"])
        STREAM = MeterStream(METER)
        METER_ERROR = None
    except (ADS1110Error, OSError) as e:
        METER, METER_ERROR = None, str(e)


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        pass

    def end_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def _send(self, obj: dict, code: int = 200) -> None:
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _send_file(self, name: str, ctype: str) -> None:
        with open(os.path.join(HERE, name), "rb") as f:
            body = f.read()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _body(self) -> dict:
        n = int(self.headers.get("Content-Length") or 0)
        return json.loads(self.rfile.read(n)) if n else {}

    def _meter(self):
        if METER is None:
            init_meter()  # hot-plug: retry on demand
        if METER is None:
            self._send({"ok": False, "error": f"meter unavailable: {METER_ERROR}"}, 503)
        return METER

    def do_GET(self):
        url = urlparse(self.path)
        if url.path in PANELS:
            self._send_file(PANELS[url.path], "application/javascript")
        elif url.path == "/api/meter/stream":
            if self._meter():
                qs = parse_qs(url.query)
                try:
                    since = int(qs.get("since", ["0"])[0])
                except ValueError:
                    since = 0
                self._send({"ok": True, **STREAM.poll(since)})
        elif self.path == "/api/info":
            self._send({"ok": True, "service": "hil-instruments", "version": VERSION,
                        "instruments": {"meter": {"present": METER is not None,
                                                  "error": METER_ERROR},
                                        "logic": {"present": LOGIC.usb_device() is not None}}})
        elif self.path == "/api/logic/status":
            self._send({"ok": True, **LOGIC.status()})
        elif self.path == "/api/dut/status":
            self._send({"ok": True, **DUT.status()})
        elif url.path in ("/api/logic/result", "/api/logic/state"):
            self._logic_get(url.path, {k: v[0] for k, v in parse_qs(url.query).items()})
        elif self.path == "/api/logic/last":
            if LOGIC.last:
                self._send({"ok": True, **LOGIC.last})
            else:
                self._send({"ok": False, "error": "no capture yet"}, 404)
        elif self.path == "/api/meter/status":
            meter = self._meter()
            if meter:
                self._send({"ok": True, **meter.status(),
                            "autorange": STREAM.autorange,
                            "streaming": STREAM.running})
        else:
            self._send({"ok": False, "error": "not found"}, 404)

    def do_POST(self):
        if self.path not in ("/api/meter/read", "/api/meter/config", "/api/logic/capture",
                             "/api/logic/arm", "/api/dut/probe"):
            self._send({"ok": False, "error": "not found"}, 404)
            return
        try:
            body = self._body()
        except ValueError as e:
            self._send({"ok": False, "error": f"bad json: {e}"}, 400)
            return
        if self.path in ("/api/logic/capture", "/api/logic/arm"):
            self._logic_capture(body, arm=self.path.endswith("/arm"))
            return
        if self.path == "/api/dut/probe":
            self._dut_probe(body)
            return
        meter = self._meter()
        if not meter:
            return
        try:
            if self.path == "/api/meter/read":
                self._send({"ok": True, **meter.read(int(body.get("samples", 8)))})
            else:
                # An explicit gain means the caller wants that range: a script
                # must not have it changed under it by a dashboard's autorange.
                if "autorange" in body or "pga" in body:
                    STREAM.autorange = bool(body.get("autorange", False))
                if "sps" in body or "pga" in body:
                    meter.configure(int(body.get("sps", meter.sps)),
                                    int(body.get("pga", meter.pga)))
                    STREAM.reconfigured()
                self._send({"ok": True, **meter.status(),
                            "autorange": STREAM.autorange})
        except (ADS1110Error, ValueError) as e:
            self._send({"ok": False, "error": str(e)}, 400)
        except OSError as e:
            self._send({"ok": False, "error": f"i2c: {e}"}, 502)

    def _dut_probe(self, body: dict) -> None:
        try:
            if not body.get("slot"):
                raise ValueError("slot required, e.g. {\"slot\": \"SLOT1\"}")
            res = DUT.probe(str(body["slot"]))
            self._send(res, 200 if res.get("ok") else 502)
        except RuntimeError as e:
            self._send({"ok": False, "error": str(e)}, 409)
        except ValueError as e:
            self._send({"ok": False, "error": str(e)}, 400)
        except OSError as e:
            self._send({"ok": False, "error": f"portal: {e}"}, 502)

    def _logic_capture(self, body: dict, arm: bool = False) -> None:
        args = {k: body[k] for k in ("samplerate", "duration_ms", "channels", "labels",
                                     "max_edges", "client", "trigger", "pre_ms", "timeout_ms",
                                     "cycles") if k in body}
        self._logic_call(LOGIC.arm if arm else LOGIC.capture, args)

    def _logic_get(self, path: str, qs: dict) -> None:
        if path == "/api/logic/result":
            self._logic_call(LOGIC.result, {"job_id": qs.get("id"),
                                            "wait_s": qs.get("wait_s", "30")})
        else:
            args = {k: qs[k] for k in ("window_ms", "samplerate", "client") if k in qs}
            if qs.get("channels"):
                args["channels"] = qs["channels"].split(",")
            self._logic_call(LOGIC.state, args)

    def _logic_call(self, fn, args: dict) -> None:
        try:
            res = fn(**args)
            self._send({"ok": True, **res}, 202 if res.get("done") is False else 200)
        except LogicError as e:
            code = 409 if str(e).startswith("busy") else 400
            if str(e).startswith(("no samples", "timeout", "internal")):
                code = 502
            self._send({"ok": False, "error": str(e)}, code)
        except KeyError as e:
            self._send({"ok": False, "error": str(e.args[0])}, 404)
        except (ValueError, TypeError) as e:
            self._send({"ok": False, "error": str(e)}, 400)


class Server(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def main() -> None:
    init_meter()
    print(f"hil-instruments {VERSION} on :{CFG['port']} meter="
          f"{'ok' if METER else METER_ERROR}", flush=True)
    Server(("0.0.0.0", CFG["port"]), Handler).serve_forever()


if __name__ == "__main__":
    main()
