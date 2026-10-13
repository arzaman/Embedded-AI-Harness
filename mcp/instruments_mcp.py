#!/usr/bin/env python3
"""MCP server for the HIL instruments service — zero dependencies.

Companion to testbench_mcp.py (left untouched). Thin stdio proxy:
  * meter_*, logic_* -> instruments service (INSTRUMENTS_URL, default :8081)
  * dut_console   -> one console command on a DUT through the portal's serial
                     API (TESTBENCH_URL), returning the OK/ERR reply line.

Run: TESTBENCH_URL=http://<bench>:8080 INSTRUMENTS_URL=http://<bench>:8081 \
     DUT_SLOT=<slot label> python3 instruments_mcp.py
DUT_SLOT (optional): slot used by dut_console / dut_probe when none is given.
"""
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

PORTAL = os.environ.get("TESTBENCH_URL", "http://localhost:8080").rstrip("/")
INSTR = os.environ.get("INSTRUMENTS_URL", "").rstrip("/") or \
    PORTAL.rsplit(":", 1)[0] + ":8081"
DUT_SLOT = os.environ.get("DUT_SLOT", "").strip()

S_INT = {"type": "integer"}
S_NUM = {"type": "number"}
S_STR = {"type": "string"}

TRIGGER_PROPS = {
    "trigger": dict(**S_STR, description="wait for a condition before keeping data: 'CH1=r' "
                    "(r rising, f falling, e any edge, 0/1 level), comma = AND, e.g. 'CH1=r,CH2=0' "
                    "(one edge at most). With a trigger, duration_ms is the window AFTER it."),
    "pre_ms": dict(**S_INT, default=100, description="window kept before the trigger"),
    "timeout_ms": dict(**S_INT, default=10000, minimum=1, maximum=60000,
                       description="how long to wait for the trigger; if it never comes the "
                                   "result has triggered=false (not an error)"),
    "cycles": dict(**S_INT, description="list up to N cycles per channel as [t_rise_s, high_s, "
                                        "period_s, duty_pct] (time-proportional / slow PWM check)"),
}

SPECS = [
    dict(name="instruments_info", method="GET", path="/api/info",
         desc="HIL instruments service version and which instruments are present."),
    dict(name="meter_read", method="POST", path="/api/meter/read",
         desc="Bench voltmeter (Unit ADC v1.1 / ADS1110 on the Pi): measure DC volts at its input, "
              "averaged over `samples` fresh conversions (15 sps -> ~70 ms each). Single-ended, "
              "referenced to bench GND, 0..~12 V at PGA 1. Returns calibrated `volts` plus raw codes.",
         props={"samples": dict(**S_INT, default=8, minimum=1, maximum=256)}, timeout=60),
    dict(name="meter_config", method="POST", path="/api/meter/config",
         desc="Voltmeter data rate / gain. sps 15 = 16 bit (default), 240 = 12 bit. "
              "PGA >1 shrinks full scale (~12.5 V / PGA). autorange=true lets the live stream "
              "(dashboard multimeter) pick the PGA; an explicit pga turns autorange off.",
         props={"sps": dict(**S_INT, enum=[15, 30, 60, 240]), "pga": dict(**S_INT, enum=[1, 2, 4, 8]),
                "autorange": {"type": "boolean"}}),
    dict(name="meter_status", method="GET", path="/api/meter/status",
         desc="Voltmeter address, sps, pga, ranges, autorange and calibration (scale, offset)."),
    dict(name="logic_status", method="GET", path="/api/logic/status",
         desc="Logic analyzer (Saleae Logic clone, sigrok fx2lafw) on the Pi: present, busy, "
              "channels (probe CH1..CH8 = D0..D7, labels), supported samplerates."),
    dict(name="logic_capture", method="POST", path="/api/logic/capture",
         desc="Capture digital signals (blocking) and return per channel: edges [[t_s, new_level], ...] "
              "(t from first sample), frequency_hz, duty_pct, period/high/low stats, or "
              "static level. t0_epoch_ms = first sample on the Pi clock (aligns with meter "
              "stream timestamps, few ms). Pi 3: up to 12 MHz reliable (16 MHz may overrun); "
              "samples = rate*duration <= 200M. 3.3 V logic, common GND with the DUT. "
              "With `trigger`: returns triggered, trigger.{trigger_s, after_arm_s, trigger_epoch_ms, "
              "levels, levels_before} (all 8 channels at the trigger sample). To catch an event "
              "you cause yourself (console command), use logic_arm + logic_result instead.",
         props={"samplerate": dict(**S_STR, default="1m",
                                   description="e.g. '100k', '1m', '12m' (or Hz as integer)"),
                "duration_ms": dict(**S_INT, default=1000, minimum=1, maximum=60000),
                "channels": {"type": "array", "items": S_STR,
                             "description": "e.g. ['CH1'] or ['D0','D1']; default all 8"},
                "labels": {"type": "object", "description": "e.g. {'D0': 'LED'}"},
                "max_edges": dict(**S_INT, default=200,
                                  description="edges listed per channel (stats use all)"),
                **TRIGGER_PROPS},
         timeout=200),
    dict(name="logic_arm", method="POST", path="/api/logic/arm",
         desc="Start a capture (same arguments as logic_capture, usually with a trigger) and "
              "return as soon as the analyzer is sampling (armed, capture_id). Then stimulate the "
              "DUT (a console command, a button...) and call logic_result: nothing that happens "
              "after the arm is missed. Typical: logic_arm trigger='CH1=r' timeout_ms=5000 -> "
              "dut_console -> logic_result.",
         props={"samplerate": dict(**S_STR, default="1m"),
                "duration_ms": dict(**S_INT, default=1000, minimum=1, maximum=60000),
                "channels": {"type": "array", "items": S_STR},
                "labels": {"type": "object"},
                "max_edges": dict(**S_INT, default=200), **TRIGGER_PROPS},
         timeout=60),
    dict(name="logic_result", method="GET", path="/api/logic/result",
         desc="Result of an armed capture (logic_arm), same shape as logic_capture. Waits up to "
              "wait_s; if still running returns done=false (call again).",
         props={"id": dict(**S_INT, description="capture_id from logic_arm (default: latest)"),
                "wait_s": dict(**S_NUM, default=30, maximum=120)},
         timeout=150),
    dict(name="logic_state", method="GET", path="/api/logic/state",
         desc="Is each GPIO high or low right now? Short capture (~0.1 s total) -> per channel "
              "level, stable (no edge in the window), and frequency/duty if it is toggling. "
              "For a slow output (time-proportional, blink) make window_ms longer than its period.",
         props={"channels": {"type": "array", "items": S_STR, "description": "default all 8"},
                "window_ms": dict(**S_INT, default=20, minimum=1, maximum=60000)},
         timeout=90),
    dict(name="dut_info", method="GET", path="/api/dut/status",
         desc="ESP32 DUTs on the bench USB (sysfs, no traffic to the device): VID:PID, product, "
              "serial (= MAC on native USB-Serial/JTAG), speed, port, interfaces/tty; plus the "
              "cached result of the last dut_probe per device (chip, flash, partitions, firmware)."),
    dict(name="dut_probe", method="POST", path="/api/dut/probe",
         desc="Read a DUT's identity from its ROM bootloader (esptool, one session): chip model/"
              "revision/features, crystal, MAC, flash JEDEC id and size, partition table and the "
              "esp_app_desc of every app partition (project, version, IDF, ELF SHA-256). "
              "REBOOTS the DUT (outputs back to their power-on state); the serial proxy is restored.",
         props={"slot": dict(**S_STR, description="slot label; default $DUT_SLOT")}, timeout=120),
    dict(name="dut_console", method="CONSOLE", path="/api/serial/write",
         desc="Send one line to a DUT console (e.g. 'info') and return "
              "the first reply line starting with OK/ERR (or with `expect` if given).",
         props={"slot": dict(**S_STR, description="slot label; default $DUT_SLOT"), "command": S_STR,
                "expect": dict(**S_STR, description="reply prefix to wait for, e.g. 'OK dac'"),
                "timeout": dict(**S_NUM, default=5)},
         required=["command"]),
]
SPEC_BY_NAME = {s["name"]: s for s in SPECS}


def _req(url, method="GET", body=None, timeout=30):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method,
                                 headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        try:
            return json.loads(e.read())
        except ValueError:
            return {"ok": False, "error": f"HTTP {e.code}"}
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": "%s: %s" % (type(e).__name__, e)}


def _serial_lines(slot, since):
    q = urllib.parse.urlencode({"slot": slot, "lines": 200, "since": since})
    return _req(f"{PORTAL}/api/serial/output?{q}").get("lines") or []


def dut_console(slot="", command="", expect=None, timeout=5):
    tail = _serial_lines(slot, 0)
    since = tail[-1]["ts"] if tail else 0
    w = _req(f"{PORTAL}/api/serial/write", "POST", {"slot": slot, "text": command})
    if not w.get("ok"):
        return {"ok": False, "error": "serial write failed", "detail": w}
    prefixes = (expect,) if expect else ("OK", "ERR")
    deadline = time.time() + float(timeout)
    while time.time() < deadline:
        for ln in _serial_lines(slot, since):
            if ln["ts"] <= since:
                continue
            text = ln.get("text", "")
            if text.startswith(prefixes):
                return {"ok": text.startswith("OK"), "reply": text, "ts": ln["ts"]}
        time.sleep(0.2)
    return {"ok": False, "error": f"no reply to '{command}' within {timeout}s"}


def _call(spec, args):
    args = {k: v for k, v in args.items() if v is not None}
    if spec["name"] in ("dut_console", "dut_probe"):
        args.setdefault("slot", DUT_SLOT)
        if not args["slot"]:
            return {"ok": False, "error": "slot required (or set DUT_SLOT for the MCP server)"}
    if spec["method"] == "CONSOLE":
        return dut_console(**args)
    if spec["name"] in ("logic_capture", "logic_arm", "logic_state"):
        args.setdefault("client", "mcp")   # the dashboard card shows who captured
    url = INSTR + spec["path"]
    if spec["method"] == "GET":
        if args:
            q = {k: ",".join(v) if isinstance(v, list) else v for k, v in args.items()}
            url += "?" + urllib.parse.urlencode(q)
        return _req(url, timeout=spec.get("timeout", 30))
    return _req(url, "POST", args, timeout=spec.get("timeout", 30))


class _RpcError(Exception):
    def __init__(self, code, message):
        self.code, self.message = code, message


def _tool_defs():
    return [{"name": s["name"], "description": s["desc"],
             "inputSchema": {"type": "object", "properties": s.get("props", {}),
                             "required": s.get("required", [])}}
            for s in SPECS]


def _handle(req):
    m = req.get("method")
    if m == "initialize":
        pv = (req.get("params") or {}).get("protocolVersion") or "2025-06-18"
        return {"protocolVersion": pv, "capabilities": {"tools": {}},
                "serverInfo": {"name": "hil-instruments", "version": "0.5.0"}}
    if m == "tools/list":
        return {"tools": _tool_defs()}
    if m == "tools/call":
        params = req.get("params") or {}
        spec = SPEC_BY_NAME.get(params.get("name"))
        if not spec:
            return {"content": [{"type": "text", "text": json.dumps(
                {"error": "unknown tool " + str(params.get("name")) })}], "isError": True}
        result = _call(spec, params.get("arguments") or {})
        return {"content": [{"type": "text", "text": json.dumps(result, indent=2, default=str)}]}
    if m == "ping":
        return {}
    raise _RpcError(-32601, "method not found: " + str(m))


def main():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except ValueError:
            continue
        if req.get("id") is None:
            continue
        try:
            resp = {"jsonrpc": "2.0", "id": req["id"], "result": _handle(req)}
        except _RpcError as e:
            resp = {"jsonrpc": "2.0", "id": req["id"],
                    "error": {"code": e.code, "message": e.message}}
        except Exception as e:  # noqa: BLE001
            resp = {"jsonrpc": "2.0", "id": req["id"],
                    "error": {"code": -32000, "message": "%s: %s" % (type(e).__name__, e)}}
        sys.stdout.write(json.dumps(resp) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
