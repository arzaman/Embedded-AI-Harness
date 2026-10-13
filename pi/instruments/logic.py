"""Logic analyzer (Saleae Logic clone, Cypress FX2) through sigrok-cli.

sigrok-cli writes raw samples (-O binary, 1 byte = D0..D7 per sample) to a
file in tmpfs; edges are extracted afterwards in chunks with numpy. Anything
that makes sigrok wait (CSV/VCD formatting, a 64 KB pipe to a slower reader)
stops it servicing USB and the FX2 overruns ("Device only sent N samples").

On a Pi 3 (USB shared with Ethernet) binary-to-file holds 12 MHz for seconds,
16 MHz only sometimes, 24 MHz never. An overrun is reported ("overrun": true)
and followed by a flush capture (see _flush). CSV/VCD output overrun already at 250 kHz / 8 MHz (CPU).

Timestamps: t0 (first sample) on the Pi clock, estimated while the file grows:
with n bytes on disk the n-th sample was taken at t0 + n/rate, before now, so
t0 <= now - n/rate at every poll; the smallest bound wins.
"""
import glob
import os
import re
import signal
import subprocess
import tempfile
import threading
import time

import numpy as np

DRIVER = "fx2lafw"
RATES = [20_000, 25_000, 50_000, 100_000, 200_000, 250_000, 500_000,
         1_000_000, 2_000_000, 3_000_000, 4_000_000, 6_000_000, 8_000_000,
         12_000_000, 16_000_000, 24_000_000]
MAX_RELIABLE_RATE = 12_000_000   # Pi 3: 16 MHz sometimes overruns, 24 MHz always
MAX_DURATION_MS = 60_000
MAX_STORED_EDGES = 2_000_000      # per channel, for stats
LAST_EDGES = 20_000               # per channel kept in .last for the dashboard
MAX_SAMPLES = 200_000_000         # 1 byte each, in tmpfs (Pi 3: 1 GB RAM)
TMP_FILE = "/tmp/hil-logic.bin"
CHUNK = 1 << 22
CHANNELS = [f"D{i}" for i in range(8)]   # D0 = probe "CH1" on the clone
# VID:PID an fx2lafw device can show: Saleae Logic clone (kept after the
# firmware upload), sigrok's own fx2lafw ID, a bare unprogrammed FX2LP.
FX2_IDS = {("0925", "3881"), ("1d50", "608c"), ("04b4", "8613")}


TRIGGER_CONDS = {"0", "1", "r", "f", "e"}
ARM_TIMEOUT_S = 15        # sigrok start + FX2 firmware upload on first open
MAX_RESULT_WAIT_S = 120
MAX_JOBS = 20
MAX_CYCLES = 10_000


class LogicError(Exception):
    pass


def chan_index(c) -> int:
    s = str(c).strip().upper()
    if s.startswith("CH"):
        i = int(s[2:]) - 1
    elif s.startswith("D"):
        i = int(s[1:])
    else:
        i = int(s)
    if not 0 <= i < 8:
        raise LogicError(f"bad channel {c!r} (D0..D7 or CH1..CH8)")
    return i


def parse_trigger(spec) -> dict:
    """"CH1=r,CH2=0" or {"CH1": "r"} -> {0: "r", 1: "0"} (ANDed conditions)."""
    if not spec:
        return {}
    if isinstance(spec, str):
        items = []
        for part in spec.replace(";", ",").split(","):
            if part.strip():
                ch, sep, cond = part.partition("=")
                if not sep:
                    raise LogicError(f"bad trigger {part!r}: use CH1=r (0 1 r f e)")
                items.append((ch, cond))
    elif isinstance(spec, dict):
        items = list(spec.items())
    else:
        raise LogicError("trigger: string 'CH1=r,CH2=0' or object {\"CH1\": \"r\"}")
    out = {}
    for ch, cond in items:
        cond = str(cond).strip().lower()
        cond = {"rise": "r", "rising": "r", "fall": "f", "falling": "f", "edge": "e",
                "low": "0", "high": "1"}.get(cond, cond)
        if cond not in TRIGGER_CONDS:
            raise LogicError(f"bad trigger condition {cond!r} (0 1 r f e)")
        out[chan_index(ch)] = cond
    if sum(c in "rfe" for c in out.values()) > 1:
        raise LogicError("at most one edge condition (r/f/e) per trigger; others must be levels")
    return out


def format_trigger(trig: dict) -> str | None:
    return ",".join(f"CH{i + 1}={c}" for i, c in sorted(trig.items())) or None


def _match(a, prev, trig):
    """Index of the first sample in `a` meeting every condition, or None.
    `prev` is the sample before a[0] (None at the very start: no edge there)."""
    ok = np.ones(a.size, bool)
    for i, c in trig.items():
        b = (a >> i) & 1
        if c in "01":
            ok &= b == int(c)
            continue
        pb = np.empty_like(b)
        pb[1:] = b[:-1]
        pb[0] = b[0] if prev is None else (int(prev) >> i) & 1
        ok &= {"r": (pb == 0) & (b == 1), "f": (pb == 1) & (b == 0), "e": pb != b}[c]
    h = np.flatnonzero(ok)
    return int(h[0]) if h.size else None


def parse_rate(v) -> int:
    if isinstance(v, (int, float)):
        r = int(v)
    else:
        m = re.fullmatch(r"\s*([\d.]+)\s*([kKmM]?)(?:hz|Hz|HZ)?\s*", str(v))
        if not m:
            raise LogicError(f"bad samplerate {v!r}")
        r = int(float(m.group(1)) * {"": 1, "k": 1e3, "m": 1e6}[m.group(2).lower()])
    if r not in RATES:
        raise LogicError(f"samplerate {r} not supported; use one of {RATES}")
    return r


def fmt_rate(r: int) -> str:
    return f"{r // 1_000_000}m" if r % 1_000_000 == 0 else f"{r // 1000}k"


def _sh(cmd, timeout=15) -> str:
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        return r.stdout + r.stderr
    except (OSError, subprocess.TimeoutExpired) as e:
        return f"error: {e}"


def _read(path):
    try:
        with open(path) as f:
            return f.read().strip()
    except OSError:
        return None


class LogicAnalyzer:
    def __init__(self, labels: dict | None = None):
        self.labels = dict(labels or {})
        self.lock = threading.Lock()
        self.last = None          # last capture result (dashboard)
        self._key = None          # (busnum, devnum) the details below belong to
        self._details = {}        # sigrok scan/show/open-log facts for that device
        self._versions = None
        self.started = time.time()
        self.busy_client = None   # who holds the analyzer right now
        self.busy_since = None
        self.captures = 0
        self.overruns = 0
        self.job = None           # latest capture job (arm/result)
        self.jobs = {}            # id -> job, the last MAX_JOBS
        self._next_id = 0

    # ---------- device identity ----------
    @staticmethod
    def usb_device():
        """The analyzer in sysfs (cheap, no USB traffic), or None."""
        for d in glob.glob("/sys/bus/usb/devices/*"):
            vid, pid = _read(d + "/idVendor"), _read(d + "/idProduct")
            if vid and (vid, pid) in FX2_IDS:
                busnum, devpath = int(_read(d + "/busnum")), _read(d + "/devpath")
                speed = _read(d + "/speed")
                return {"vid_pid": f"{vid}:{pid}", "manufacturer": _read(d + "/manufacturer"),
                        "product": _read(d + "/product"), "serial": _read(d + "/serial"),
                        "bcd_device": _read(d + "/bcdDevice"), "usb_version": _read(d + "/version"),
                        "speed_mbps": int(speed) if speed and speed.isdigit() else None,
                        "max_power": _read(d + "/bMaxPower"), "busnum": busnum,
                        "devnum": int(_read(d + "/devnum")), "sysfs": os.path.basename(d),
                        # same notation as the portal's slot usb_prefix ("0:1.2")
                        "usb_prefix": f"{busnum - 1}:{devpath}"}
        return None

    def _probe(self, usb):
        """sigrok facts about the device: scan line, supported options, and
        what the driver logs when it opens it (FX2 chip revision, firmware).
        Opening touches the USB, so only once per plug-in and never while
        capturing."""
        conn = f"{DRIVER}:conn={usb['busnum']}.{usb['devnum']}"
        det = {}
        out = _sh(["sigrok-cli", "-d", conn, "--scan"])
        det["scan"] = next((ln.strip() for ln in out.splitlines() if ln.strip().startswith(DRIVER)), None)
        m = re.search(r" - (.+?)(?: \[S/N: (.*?)\])? with (\d+) channels", det["scan"] or "")
        if m:
            det["model"], det["sigrok_serial"], det["channel_count"] = m.group(1), m.group(2), int(m.group(3))
        out = _sh(["sigrok-cli", "-d", conn, "--show"])
        rates = []
        for v, u in re.findall(r"^\s+([\d.]+) (kHz|MHz)\b", out, re.M):
            rates.append(int(float(v) * (1e3 if u == "kHz" else 1e6)))
        det["device_samplerates"] = rates
        m = re.search(r"Supported triggers: (.*)", out)
        det["triggers"] = m.group(1).split() if m else []
        det["continuous"] = "continuous" in out
        out = _sh(["sigrok-cli", "-d", conn, "--config", "samplerate=20k", "--samples", "64",
                   "-O", "binary", "-o", "/dev/null", "-l", "5"])
        m = re.search(r"firmware (\d+\.\d+)", out)
        det["fx2lafw_version"] = m.group(1) if m else None
        m = re.search(r"REVID=(\d+), it's a (.+?)\.?$", out, re.M)
        if m:
            det["fx2_revid"], det["fx2_chip"] = int(m.group(1)), m.group(2)
        det["firmware_uploaded"] = "Firmware upload was not needed" not in out
        m = re.search(r"\((logical)\) / (usb/\S+) \(physical\)", out)
        det["physical"] = m.group(2) if m else None
        det["probed_at"] = time.time()
        return det

    def versions(self) -> dict:
        if self._versions is None:
            out = _sh(["sigrok-cli", "--version"])
            v = {"sigrok_cli": None, "libsigrok": None}
            m = re.search(r"sigrok-cli (\S+)", out)
            v["sigrok_cli"] = m.group(1) if m else None
            m = re.search(r"libsigrok (\S+?)/", out)
            v["libsigrok"] = m.group(1) if m else None
            v["fx2lafw_package"] = _sh(["dpkg-query", "-W", "-f", "${Version}",
                                        "sigrok-firmware-fx2lafw"]).strip() or None
            self._versions = v
        return self._versions

    def scan(self):
        """Scan line for the present device (None if unplugged); refreshes the
        cached details after a (re)plug, unless a capture holds the device."""
        usb = self.usb_device()
        if usb is None:
            self._key, self._details = None, {}
            return None, None
        key = (usb["busnum"], usb["devnum"])
        if key != self._key and self.lock.acquire(blocking=False):
            try:
                self._details = self._probe(usb)
                self._key = key
            finally:
                self.lock.release()
        return usb, self._details

    def status(self) -> dict:
        usb, det = self.scan()
        last = None
        if self.last:
            L = self.last
            last = {"at_epoch_ms": L["captured_at_epoch_ms"], "client": L.get("client"),
                    "samplerate": L["samplerate"],
                    "duration_s": L["duration_s"], "samples": L["samples"], "overrun": L["overrun"],
                    "channels": [{k: c.get(k) for k in ("channel", "probe", "label", "static",
                                                         "initial_level", "frequency_hz", "duty_pct",
                                                         "edge_count")} for c in L["channels"]]}
        return {"present": usb is not None, "device": (det or {}).get("scan"),
                "busy": self.lock.locked(), "busy_client": self.busy_client,
                "job": ({**self._job_info(self.job), "done": self.job["done"].is_set(),
                         "error": self.job["error"]} if self.job else None),
                "busy_since_epoch_ms": round(self.busy_since * 1000) if self.busy_client else None,
                "channels": self._chan_info(range(8)),
                "samplerates": RATES, "max_reliable_samplerate": MAX_RELIABLE_RATE,
                "max_duration_ms": MAX_DURATION_MS,
                "usb": usb, "details": det or None, "versions": self.versions(),
                "service": {"since_epoch_ms": round(self.started * 1000), "captures": self.captures,
                            "overruns": self.overruns, "last": last}}

    def _chan_info(self, idx):
        return [{"channel": CHANNELS[i], "probe": f"CH{i + 1}",
                 "label": self.labels.get(CHANNELS[i])} for i in idx]

    # ---------- capture ----------
    def capture(self, **kw) -> dict:
        """Blocking capture: arm, wait for the end, return the result.
        Arguments as arm()."""
        job = self._start(**kw)
        job["done"].wait()
        return self._job_result(job)

    def arm(self, **kw) -> dict:
        """Start a capture and return as soon as samples are flowing, so the
        caller can stimulate the DUT knowing nothing is missed. Fetch the
        outcome with result(). Arguments:
          samplerate, duration_ms, channels, labels, max_edges, client, cycles
          trigger     "CH1=r,CH2=0" or {"CH1": "r"}: 0 1 r(ising) f(alling) e(dge),
                      ANDed. With a trigger, duration_ms is the window after it.
          pre_ms      window kept before the trigger (default 100)
          timeout_ms  how long to wait for the trigger (default 10000);
                      no trigger is a result (triggered: false), not an error."""
        job = self._start(**kw)
        if not job["armed"].wait(ARM_TIMEOUT_S) and not job["done"].is_set():
            raise LogicError("timeout waiting for samples (analyzer did not start)")
        if job["done"].is_set() and job["error"]:
            raise LogicError(job["error"])
        return self._job_info(job)

    def result(self, job_id=None, wait_s=30.0) -> dict:
        """Result of an armed capture (the latest one by default). Waits up to
        wait_s; still running -> {"done": False, ...}."""
        job = self.jobs.get(int(job_id)) if job_id not in (None, "") else self.job
        if job is None:
            raise KeyError(f"no capture {job_id}" if job_id not in (None, "") else "no capture yet")
        if not job["done"].wait(max(0.0, min(float(wait_s), MAX_RESULT_WAIT_S))):
            return {"done": False, **self._job_info(job)}
        return {"done": True, **self._job_result(job)}

    def state(self, channels=None, window_ms=20, samplerate="100k", client=None) -> dict:
        """Level of each channel now: a short capture. A toggling line also
        gets frequency/duty (use a window longer than its period)."""
        window_ms = int(window_ms)
        res = self.capture(samplerate=samplerate, duration_ms=window_ms, channels=channels,
                           max_edges=0, client=client or "state", keep_last=False)
        levels = {}
        for c in res["channels"]:
            s = {"level": c["final_level"], "stable": c["static"], "label": c["label"],
                 "edges": c["edge_count"]}
            for k in ("frequency_hz", "duty_pct"):
                if k in c:
                    s[k] = c[k]
            levels[c["probe"]] = s
        return {"levels": levels, "window_ms": window_ms, "samplerate": res["samplerate"],
                "at_epoch_ms": res["t0_epoch_ms"]}

    def _start(self, samplerate="1m", duration_ms=1000, channels=None, labels=None,
               max_edges=200, client=None, trigger=None, pre_ms=100, timeout_ms=10_000,
               cycles=0, keep_last=True) -> dict:
        """Validate, take the analyzer, run the capture in a thread.
        keep_last=False (level readings) leaves /api/logic/last to real captures.
        `client` names the caller (dashboard, pytest, mcp...): the dashboard
        card shows captures made by others, and who holds the analyzer."""
        rate = parse_rate(samplerate)
        duration_ms = int(duration_ms)
        if not 1 <= duration_ms <= MAX_DURATION_MS:
            raise LogicError(f"duration_ms must be 1..{MAX_DURATION_MS}")
        idx = self._channels(channels)
        trig = parse_trigger(trigger)
        p = {"rate": rate, "duration_ms": duration_ms, "labels": labels or {},
             "cycles": max(0, min(int(cycles or 0), MAX_CYCLES))}
        if trig:
            pre_ms, timeout_ms = int(pre_ms), int(timeout_ms)
            if not 0 <= pre_ms <= MAX_DURATION_MS or not 1 <= timeout_ms <= MAX_DURATION_MS:
                raise LogicError(f"pre_ms 0..{MAX_DURATION_MS}, timeout_ms 1..{MAX_DURATION_MS}")
            if rate * (timeout_ms + duration_ms) // 1000 > MAX_SAMPLES:
                raise LogicError(f"timeout_ms + duration_ms too long at this samplerate "
                                 f"(max {MAX_SAMPLES * 1000 // rate} ms)")
            idx = sorted(set(idx) | set(trig))
            p.update(trig=trig, pre_ms=pre_ms, timeout_ms=timeout_ms)
        elif rate * duration_ms // 1000 > MAX_SAMPLES:
            raise LogicError(f"{rate * duration_ms // 1000} samples > {MAX_SAMPLES}: lower "
                             f"samplerate or duration (max {MAX_SAMPLES * 1000 // rate} ms at this rate)")
        p["idx"] = idx
        if not self.lock.acquire(blocking=False):
            raise LogicError(f"busy: another capture is running ({self.busy_client or 'unknown'})")
        self.busy_client = client or "api"
        self.busy_since = time.time()
        self._next_id += 1
        job = {"id": self._next_id, "client": self.busy_client, "trigger": format_trigger(trig),
               "armed": threading.Event(), "armed_epoch_ms": None, "done": threading.Event(),
               "result": None, "error": None, "error_code": None, "max_edges": int(max_edges),
               "timeout_ms": p.get("timeout_ms"), "started_epoch_ms": round(self.busy_since * 1000),
               "keep_last": keep_last}
        self.job = job
        self.jobs[job["id"]] = job
        for k in sorted(self.jobs)[:-MAX_JOBS]:
            del self.jobs[k]
        threading.Thread(target=self._job_run, args=(job, p), daemon=True).start()
        return job

    def _job_run(self, job, p):
        # The kept copy (/api/logic/last, dashboard) gets up to LAST_EDGES
        # edges whatever the caller asked for; the caller gets its max_edges.
        keep = max(job["max_edges"], LAST_EDGES)

        def armed(t0):
            job["armed_epoch_ms"] = round(t0 * 1000, 3)
            job["armed"].set()

        run = self._run_trig if "trig" in p else self._run
        try:
            try:
                res = run(p, keep, armed)
            except LogicError as e:
                # First open after plug-in uploads the FX2 firmware and can fail
                # while the device re-enumerates: retry once.
                if "no samples" not in str(e):
                    raise
                time.sleep(2.0)
                res = run(p, keep, armed)
            self.captures += 1
            if res["overrun"]:
                self.overruns += 1
                self._flush()
            res["client"] = job["client"]
            res["capture_id"] = job["id"]
            if job["keep_last"]:
                self.last = res
            job["result"] = res
        except LogicError as e:
            job["error"] = str(e)
        except Exception as e:  # noqa: BLE001 - a thread must not die silently
            job["error"] = f"internal error: {e!r}"
        finally:
            self.busy_client = None
            self.lock.release()
            job["done"].set()

    @staticmethod
    def _job_info(job) -> dict:
        return {"capture_id": job["id"], "client": job["client"], "trigger": job["trigger"],
                "armed": job["armed"].is_set(), "armed_epoch_ms": job["armed_epoch_ms"],
                "timeout_ms": job["timeout_ms"], "started_epoch_ms": job["started_epoch_ms"]}

    def _job_result(self, job) -> dict:
        if job["error"]:
            raise LogicError(job["error"])
        return _trim(job["result"], job["max_edges"])

    def _flush(self):
        """After an overrun the FX2 still holds stale USB blocks: the next
        capture would show ~5-15 ms of old data after each edge (seen at
        100 kHz after a 24 MHz overrun). A short throw-away capture drains them."""
        try:
            subprocess.run(["sigrok-cli", "-d", DRIVER, "--config", "samplerate=20k",
                            "--samples", "4000", "-O", "binary", "-o", "/dev/null"],
                           capture_output=True, timeout=15)
        except (OSError, subprocess.TimeoutExpired):
            pass

    def _channels(self, channels):
        if channels is None:
            return list(range(8))
        return sorted({chan_index(c) for c in channels})

    @staticmethod
    def _spawn(rate, nsamples):
        try:
            os.unlink(TMP_FILE)
        except FileNotFoundError:
            pass
        cmd = ["sigrok-cli", "-d", DRIVER, "--config", f"samplerate={fmt_rate(rate)}",
               "--samples", str(nsamples), "-O", "binary", "-o", TMP_FILE]
        # stderr to a file, not a pipe: a long capture must not block on it
        err = tempfile.TemporaryFile()
        return subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=err), err

    @staticmethod
    def _stderr(err) -> str:
        err.seek(0)
        out = err.read().decode(errors="replace").strip()
        err.close()
        return out

    def _run(self, p, max_edges, armed):
        rate, duration_ms = p["rate"], p["duration_ms"]
        nsamples = rate * duration_ms // 1000
        t_start = time.time()
        proc, errf = self._spawn(rate, nsamples)
        # t0 bound: whenever the file has grown to n bytes, the n-th sample was
        # taken at t0 + n/rate, before now  ->  t0 <= now - n/rate.
        t0_bound = None
        deadline = t_start + duration_ms / 1000 + 20
        while proc.poll() is None:
            if time.time() > deadline:
                proc.kill()
                raise LogicError("timeout waiting for samples")
            try:
                size = os.stat(TMP_FILE).st_size
            except FileNotFoundError:
                size = 0
            if size:
                b = time.time() - size / rate
                t0_bound = b if t0_bound is None else min(t0_bound, b)
                if armed:
                    armed(t0_bound)
                    armed = None
            time.sleep(0.002)
        err = self._stderr(errf)
        try:
            data = np.memmap(TMP_FILE, np.uint8, mode="r")
        except (FileNotFoundError, ValueError):
            data = np.zeros(0, np.uint8)
        try:
            return self._analyze(data, rate, nsamples, p["idx"], p["labels"], max_edges,
                                 err, t0_bound if t0_bound is not None else t_start, t_start,
                                 p["cycles"])
        finally:
            del data
            try:
                os.unlink(TMP_FILE)
            except FileNotFoundError:
                pass

    def _run_trig(self, p, max_edges, armed):
        """Software trigger: sigrok streams to the file from the start (so
        "armed" is exact: samples are on disk), new blocks are searched for the
        condition while the file grows; once the post-trigger window is in,
        sigrok is stopped. sigrok's own trigger was not used: it writes nothing
        until it fires, so nobody could tell when it starts listening."""
        rate, trig = p["rate"], p["trig"]
        wait = rate * p["timeout_ms"] // 1000        # samples searched for the trigger
        post = rate * p["duration_ms"] // 1000
        pre = rate * p["pre_ms"] // 1000
        t_start = time.time()
        proc, errf = self._spawn(rate, wait + post)
        t0_bound = None
        deadline = t_start + (p["timeout_ms"] + p["duration_ms"]) / 1000 + 20
        scanned, prev, T = 0, None, None
        fd = None
        try:
            while True:
                running = proc.poll() is None
                try:
                    size = os.stat(TMP_FILE).st_size
                except FileNotFoundError:
                    size = 0
                if size:
                    b = time.time() - size / rate
                    t0_bound = b if t0_bound is None else min(t0_bound, b)
                    if armed:
                        armed(t0_bound)
                        armed = None
                    if fd is None:
                        fd = os.open(TMP_FILE, os.O_RDONLY)
                    while T is None and scanned < min(size, wait):
                        n = min(size, wait) - scanned
                        a = np.frombuffer(os.pread(fd, min(n, CHUNK), scanned), np.uint8)
                        if not a.size:
                            break
                        h = _match(a, prev, trig)
                        if h is not None:
                            T = scanned + h
                        prev = a[-1]
                        scanned += a.size
                    if T is not None and size >= T + post:
                        break
                    if T is None and scanned >= wait:
                        break
                if not running:
                    break
                if time.time() > deadline:
                    proc.kill()
                    raise LogicError("timeout waiting for samples")
                time.sleep(0.002)
        finally:
            if fd is not None:
                os.close(fd)
            if proc.poll() is None:
                proc.send_signal(signal.SIGINT)   # sigrok-cli stops the session cleanly
                try:
                    proc.wait(5)
                except subprocess.TimeoutExpired:
                    proc.kill()
                    proc.wait()
        err = self._stderr(errf)
        try:
            data = np.memmap(TMP_FILE, np.uint8, mode="r")
        except (FileNotFoundError, ValueError):
            data = np.zeros(0, np.uint8)
        try:
            if data.size == 0:
                raise LogicError(f"no samples from sigrok-cli: {err or 'unknown error'}")
            t0 = t0_bound if t0_bound is not None else t_start
            needed = T + post if T is not None else wait
            start = max(0, T - pre) if T is not None else 0
            end = min(data.size, needed)
            # Stopping sigrok early (SIGINT) also prints "only sent N samples":
            # an overrun only if the data ended before what was needed.
            res = self._analyze(data[start:end], rate, needed - start, p["idx"], p["labels"],
                                max_edges, err if data.size < needed else "",
                                t0 + start / rate, t_start, p["cycles"])
            info = {"spec": format_trigger(trig), "triggered": T is not None,
                    "timeout_ms": p["timeout_ms"], "pre_ms": p["pre_ms"],
                    "armed_epoch_ms": round(t0 * 1000, 3)}
            if T is not None:
                at, before = int(data[T]), int(data[T - 1]) if T else None
                info.update({
                    "trigger_s": (T - start) / rate,          # in this capture's time base
                    "after_arm_s": T / rate,                  # how long it took to happen
                    "trigger_epoch_ms": round((t0 + T / rate) * 1000, 3),
                    "levels": {f"CH{i + 1}": (at >> i) & 1 for i in range(8)},
                    "levels_before": ({f"CH{i + 1}": (before >> i) & 1 for i in range(8)}
                                      if before is not None else None)})
            else:
                info["waited_s"] = (end - start) / rate
            res["triggered"] = T is not None
            res["trigger"] = info
            return res
        finally:
            del data
            try:
                os.unlink(TMP_FILE)
            except FileNotFoundError:
                pass

    def _analyze(self, data, rate, nsamples, idx, labels, max_edges, err, t0, t_start,
                 cycles=0):
        mask = 0
        for i in idx:
            mask |= 1 << i
        pos = {i: [] for i in idx}
        lev = {i: [] for i in idx}
        stored = {i: 0 for i in idx}
        counts = {i: 0 for i in idx}
        first = None
        prev = None
        last_byte = None
        n = 0
        for off in range(0, data.size, CHUNK):
            a = np.asarray(data[off:off + CHUNK])
            if first is None:
                first = int(a[0])
                prev = a[0]
            shifted = np.empty_like(a)
            shifted[0] = prev
            shifted[1:] = a[:-1]
            x = (a ^ shifted) & mask
            hit = np.flatnonzero(x)
            if hit.size:
                xh, ah = x[hit], a[hit]
                for i in idx:
                    sel = np.flatnonzero(xh & (1 << i))
                    if not sel.size:
                        continue
                    counts[i] += sel.size
                    room = MAX_STORED_EDGES - stored[i]
                    if room > 0:
                        sel = sel[:room]
                        pos[i].append(hit[sel].astype(np.int64) + n)
                        lev[i].append(((ah[sel] >> i) & 1).astype(np.uint8))
                        stored[i] += sel.size
            prev = a[-1]
            last_byte = int(a[-1])
            n += a.size
        if n == 0:
            raise LogicError(f"no samples from sigrok-cli: {err or 'unknown error'}")

        chans = []
        for i, info in zip(idx, self._chan_info(idx)):
            if labels.get(info["channel"]) or labels.get(info["probe"]):
                info["label"] = labels.get(info["channel"]) or labels.get(info["probe"])
            P = np.concatenate(pos[i]) if pos[i] else np.zeros(0, np.int64)
            L = np.concatenate(lev[i]) if lev[i] else np.zeros(0, np.uint8)
            info.update(_stats(P, L, rate, n, (first >> i) & 1, (last_byte >> i) & 1, cycles))
            info["edge_count"] = counts[i]
            info["edges_stats_truncated"] = counts[i] > stored[i]
            k = min(len(P), max(0, max_edges))
            info["edges"] = [[round(float(p) / rate, 9), int(v)] for p, v in zip(P[:k], L[:k])]
            info["edges_truncated"] = counts[i] > k
            chans.append(info)

        short = re.search(r"only sent (\d+) samples", err)
        return {"samplerate": rate, "samples_requested": nsamples, "samples": n,
                "duration_s": n / rate, "truncated": n < nsamples,
                "overrun": bool(short), "sigrok_stderr": err or None,
                "t0_epoch_ms": round(t0 * 1000, 3),
                "t0_note": "Pi clock, upper bound from capture file growth (few ms)",
                "captured_at_epoch_ms": round(t_start * 1000, 3),
                "warning": "; ".join(w for w in (
                    f"overrun: USB stopped after {n / rate:.3f} s, data up to there is valid"
                    if short else None,
                    f"samplerate above {MAX_RELIABLE_RATE} Hz is not reliable on a Pi 3"
                    if rate > MAX_RELIABLE_RATE else None) if w) or None,
                "channels": chans}


def _cycles(rise, fall, rate, limit) -> list:
    """Per-cycle [t_rise_s, high_s, period_s, duty_pct], rising edge to rising
    edge: what a time-proportional (slow PWM) output did in each window."""
    k = min(rise.size - 1, limit)
    if k <= 0:
        return []
    r0, r1 = rise[:k], rise[1:k + 1]
    j = np.searchsorted(fall, r0)
    f = np.where(j < fall.size, fall[np.minimum(j, fall.size - 1)], r1) if fall.size else r1
    f = np.minimum(f, r1)      # no fall inside the period -> high all along
    hi, per = f - r0, r1 - r0
    return [[round(float(a) / rate, 9), round(float(h) / rate, 9), round(float(q) / rate, 9),
             round(100.0 * float(h) / float(q), 4)] for a, h, q in zip(r0, hi, per)]


def _stats(P, L, rate, n, level0, level_end, cycles=0) -> dict:
    """Frequency / duty from edge positions (samples) and new levels."""
    out = {"initial_level": int(level0), "final_level": int(level_end)}
    if P.size == 0:
        out["static"] = True
        return out
    out["static"] = False
    rise, fall = P[L == 1], P[L == 0]
    out["rising"], out["falling"] = int(rise.size), int(fall.size)
    per = np.diff(rise) if rise.size >= 2 else np.diff(fall)
    if per.size:
        pm = float(per.mean())
        out["period_s"] = {"mean": pm / rate, "min": float(per.min()) / rate,
                           "max": float(per.max()) / rate,
                           "std": float(per.std()) / rate, "n": int(per.size)}
        out["frequency_hz"] = rate / pm
    j = np.searchsorted(fall, rise)
    ok = j < fall.size
    high = fall[j[ok]] - rise[ok]
    j = np.searchsorted(rise, fall)
    ok = j < rise.size
    low = rise[j[ok]] - fall[ok]
    if high.size:
        out["high_s"] = {"mean": float(high.mean()) / rate, "min": float(high.min()) / rate,
                         "max": float(high.max()) / rate, "n": int(high.size)}
    if low.size:
        out["low_s"] = {"mean": float(low.mean()) / rate, "min": float(low.min()) / rate,
                        "max": float(low.max()) / rate, "n": int(low.size)}
    if high.size and low.size:
        out["duty_pct"] = 100.0 * float(high.mean()) / float(high.mean() + low.mean())
    if cycles:
        out["cycles"] = _cycles(rise, fall, rate, cycles)
        out["cycles_fields"] = ["t_rise_s", "high_s", "period_s", "duty_pct"]
    return out


def _trim(res: dict, max_edges: int) -> dict:
    """Copy of a capture result with at most max_edges listed per channel."""
    out = dict(res)
    chans = []
    for c in res["channels"]:
        c = dict(c)
        if len(c["edges"]) > max_edges:
            c["edges"] = c["edges"][:max(0, max_edges)]
        c["edges_truncated"] = c["edge_count"] > len(c["edges"])
        chans.append(c)
    out["channels"] = chans
    return out
