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
  GET  /api/dac/status    bench DAC range, outputs, calibration
  POST /api/dac/set       {"channel": 0, "volts": 2.5}  or {"volts": [1.0, 2.0]}
  POST /api/dac/off       both outputs 0 V
  GET  /api/io/status     bench I/O unit: modes, DO levels, PWM duty, resets seen
  GET  /api/io/read       level of every channel (DI read now, DO/PWM as commanded)
  POST /api/io/mode       {"channel": "IO0", "mode": "DI"|"DO"|"PWM"|"ADC", "level": 0}
  POST /api/io/write      {"channel": "IO0", "level": 1}      (channel in DO)
                          {"levels": {"IO0": 1, "IO1": 0}}    several DO at once (one I2C write)
  POST /api/io/pwm        {"channel": "IO0", "duty_pct": 50}  (~1 kHz, sets mode PWM)
  GET  /panel/<name>.js   dashboard panels (loaded by the portal, see
                          pi/dashboard_panels.py)

Voltmeter backends (config "meter_backend"):
  "u087"    M5Stack Unit Voltmeter (ADS1115 + EEPROM calibration), isolated,
            differential V+/V-, +/-32 V (default)
  "ads1110" M5Stack Unit ADC v1.1, single-ended, not isolated
Bench DAC = M5Stack Unit DAC2 (GP8413), 2 x 0-10 V (optional lower ceiling dac_max_v).
Bench I/O = M5Stack Unit 8Servos v1: 8 channels DI/DO/PWM/ADC, 3.3 V.
Logic analyzer = Saleae Logic clone (FX2, sigrok fx2lafw), probes CH1..CH8 = D0..D7.

Config (optional): /etc/rfc2217/instruments.json
  {"port": 8081, "i2c_bus": 1, "logic_labels": {"D0": "LED"},
   "meter_backend": "u087", "meter_address": 73, "meter_eeprom": 83,
   "meter_user_gain": 1.0, "meter_user_offset_v": 0.0, "meter_sps": 32,
   (ads1110: "meter_address": 72, "meter_scale": 6.1, "meter_offset_v": 0.0)
   "dac_address": 89, "dac_max_v": null,
   "dac_cal": {"0": {"gain": 1.0, "offset_v": 0.0}},
   "io_address": 37, "io_modes": {"IO0": "DI"}}
An instrument that is absent is reported as such and retried on demand.
"""
import http.server
import json
import os
import socketserver
import sys
from urllib.parse import parse_qs, urlparse

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from ads1110 import ADS1110, ADS1110Error, NOMINAL_SCALE  # noqa: E402
from ads1115 import U087Meter, ADS1115Error  # noqa: E402
from gp8413 import GP8413, GP8413Error  # noqa: E402
from servos8 import Servos8IO, BenchIOError  # noqa: E402
from meter_stream import MeterStream  # noqa: E402
from logic import LogicAnalyzer, LogicError  # noqa: E402
from dut import DutProber  # noqa: E402

VERSION = "0.6.0"
HERE = os.path.dirname(os.path.abspath(__file__))
PANELS = {"/panel/meter.js": "panel_meter.js", "/panel/logic.js": "panel_logic.js",
          "/panel/dut.js": "panel_dut.js", "/panel/dac.js": "panel_dac.js",
          "/panel/io.js": "panel_io.js"}
CONFIG_PATH = "/etc/rfc2217/instruments.json"
DEFAULTS = {"port": 8081, "i2c_bus": 1, "logic_labels": {},
            "meter_backend": "u087", "meter_eeprom": 0x53,
            "meter_user_gain": 1.0, "meter_user_offset_v": 0.0, "meter_sps": 32,
            "meter_scale": NOMINAL_SCALE, "meter_offset_v": 0.0,
            "dac_address": 0x59, "dac_max_v": None, "dac_cal": {},
            "io_address": 0x25, "io_modes": {}}
METER_ADDR = {"u087": 0x49, "ads1110": 0x48}
METER_ERRORS = (ADS1110Error, ADS1115Error, OSError)


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
    backend = CFG["meter_backend"]
    addr = CFG.get("meter_address", METER_ADDR.get(backend, 0))
    try:
        if backend == "u087":
            if not U087Meter.probe(CFG["i2c_bus"], addr):
                raise ADS1115Error(f"U087 voltmeter: no ACK at 0x{addr:02x} "
                                   f"on i2c-{CFG['i2c_bus']}")
            METER = U087Meter(CFG["i2c_bus"], addr, CFG["meter_eeprom"],
                              CFG["meter_user_gain"], CFG["meter_user_offset_v"],
                              CFG["meter_sps"])
        elif backend == "ads1110":
            if not ADS1110.probe(CFG["i2c_bus"], addr):
                raise ADS1110Error(f"ADS1110 voltmeter: no ACK at 0x{addr:02x} "
                                   f"on i2c-{CFG['i2c_bus']}")
            METER = ADS1110(CFG["i2c_bus"], addr, CFG["meter_scale"], CFG["meter_offset_v"])
        else:
            raise ADS1110Error(f"unknown meter_backend {backend!r}")
        STREAM = MeterStream(METER)
        METER_ERROR = None
    except METER_ERRORS as e:
        METER, METER_ERROR = None, str(e)


DAC = DAC_ERROR = None
IO = IO_ERROR = None


def init_dac() -> None:
    global DAC, DAC_ERROR
    try:
        if not GP8413.probe(CFG["i2c_bus"], CFG["dac_address"]):
            raise GP8413Error(f"DAC2: no ACK at 0x{CFG['dac_address']:02x} "
                              f"on i2c-{CFG['i2c_bus']}")
        dac = GP8413(CFG["i2c_bus"], CFG["dac_address"], CFG["dac_cal"], CFG["dac_max_v"])
        dac.init()                                  # 10 V range, both outputs 0 V
        DAC, DAC_ERROR = dac, None
    except (GP8413Error, OSError) as e:
        DAC, DAC_ERROR = None, str(e)


def init_io() -> None:
    global IO, IO_ERROR
    try:
        if not Servos8IO.probe(CFG["i2c_bus"], CFG["io_address"]):
            raise BenchIOError(f"8Servos: no ACK at 0x{CFG['io_address']:02x} "
                               f"on i2c-{CFG['i2c_bus']}")
        IO, IO_ERROR = Servos8IO(CFG["i2c_bus"], CFG["io_address"], CFG["io_modes"]), None
    except (BenchIOError, OSError) as e:
        IO, IO_ERROR = None, str(e)


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
                                                  "backend": CFG["meter_backend"],
                                                  "model": getattr(METER, "model", None),
                                                  "error": METER_ERROR},
                                        "dac": {"present": DAC is not None, "error": DAC_ERROR},
                                        "io": {"present": IO is not None, "error": IO_ERROR},
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
        elif url.path in ("/api/dac/status", "/api/io/status", "/api/io/read"):
            self._bench(url.path, {})
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
                             "/api/logic/arm", "/api/dut/probe", *BENCH_POST):
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
        if self.path in BENCH_POST:
            self._bench(self.path, body)
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
        except (ADS1110Error, ADS1115Error, ValueError) as e:
            self._send({"ok": False, "error": str(e)}, 400)
        except OSError as e:
            self._send({"ok": False, "error": f"i2c: {e}"}, 502)

    def _bench(self, path: str, body: dict) -> None:
        """DAC and I/O unit endpoints."""
        global DAC, IO
        kind = path.split("/")[2]
        if kind == "dac" and DAC is None:
            init_dac()
        if kind == "io" and IO is None:
            init_io()
        dev, err = (DAC, DAC_ERROR) if kind == "dac" else (IO, IO_ERROR)
        if dev is None:
            self._send({"ok": False, "error": f"{kind} unavailable: {err}"}, 503)
            return
        try:
            if path == "/api/dac/set":
                v = body.get("volts")
                if isinstance(v, list):
                    codes = [dev.set_voltage(ch, float(x)) for ch, x in enumerate(v[:2])
                             if x is not None]
                else:
                    codes = [dev.set_voltage(int(body.get("channel", 0)), float(v))]
                self._send({"ok": True, **dev.status(), "written_codes": codes})
            elif path == "/api/dac/off":
                for ch in (0, 1):
                    dev.set_voltage(ch, 0.0)
                self._send({"ok": True, **dev.status()})
            elif path == "/api/io/read":
                self._send({"ok": True, **dev.read()})
            elif path == "/api/io/mode":
                self._send({"ok": True, **dev.set_mode(body.get("channel"), body.get("mode"),
                                                        int(body.get("level", 0)))})
            elif path == "/api/io/write":
                if "levels" in body:
                    self._send({"ok": True, **dev.write_many(body["levels"])})
                else:
                    self._send({"ok": True, **dev.write(body.get("channel"),
                                                         int(body.get("level")))})
            elif path == "/api/io/pwm":
                self._send({"ok": True, **dev.pwm(body.get("channel"), body.get("duty_pct"))})
            else:  # status
                self._send({"ok": True, **dev.status()})
        except (GP8413Error, BenchIOError, ValueError, TypeError) as e:
            self._send({"ok": False, "error": str(e)}, 400)
        except OSError as e:
            # Unit unplugged or bus error: drop it, the next call probes again.
            if kind == "dac":
                DAC = None
            else:
                IO = None
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


BENCH_POST = ("/api/dac/set", "/api/dac/off",
              "/api/io/mode", "/api/io/write", "/api/io/pwm")


class Server(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True
    request_queue_size = 64      # dashboard polling + scripts: default 5 resets connections


def main() -> None:
    init_meter()
    init_dac()
    init_io()
    meter = f"ok ({METER.model})" if METER else METER_ERROR
    print(f"hil-instruments {VERSION} on :{CFG['port']} meter={meter} "
          f"dac={'ok' if DAC else DAC_ERROR} io={'ok' if IO else IO_ERROR}", flush=True)
    Server(("0.0.0.0", CFG["port"]), Handler).serve_forever()


if __name__ == "__main__":
    main()
