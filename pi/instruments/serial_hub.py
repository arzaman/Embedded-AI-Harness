"""Live read-only serial fan-out hub for the web Serial Monitor panel.

Connects on demand to each watched slot's plain read-only monitor_port
(exposed by plain_rfc2217_server.py on tcp_port + 1000) and streams raw bytes
plus slot lifecycle status over a single multiplexed Server-Sent Events (SSE)
response per browser tab.

Design guarantees:
  * Never opens /dev/tty* directly and never connects to RFC2217 tcp_port:
    cannot steal bytes, block esptool, or assert DTR/RTS.
  * At most ONE TCP connection per watched slot to 127.0.0.1:<monitor_port>,
    shared across any number of browser tabs.
  * Bounded per-subscriber queues drop oldest chunks for slow/paused browsers
    so the proxy's fan-out thread is never stalled.
  * Automatically tracks flash / reset / DUT probe / hotplug / re-enumeration
    and reconnects as soon as the proxy comes back.
"""
import base64
import collections
import json
import socket
import threading
import time
import urllib.parse
import urllib.request

DEFAULT_PORTAL = "http://127.0.0.1:8080"
SUB_QUEUE_MAX = 512
KEEPALIVE_S = 15.0
IDLE_GRACE_S = 15.0
DEVICE_CACHE_S = 0.8


class _Subscriber:
    """Bounded per-SSE-client event queue."""

    def __init__(self, maxlen: int = SUB_QUEUE_MAX):
        self.queue: collections.deque = collections.deque(maxlen=maxlen)
        self.cond = threading.Condition()
        self.closed = False
        self.dropped = 0

    def push(self, event: str, payload: dict) -> None:
        with self.cond:
            if self.closed:
                return
            if len(self.queue) == self.queue.maxlen:
                self.dropped += 1
            self.queue.append((event, payload))
            self.cond.notify()

    def pop(self, timeout: float):
        with self.cond:
            if not self.queue and not self.closed:
                self.cond.wait(timeout=timeout)
            if self.closed:
                return None
            if not self.queue:
                return ("_ping", None)
            return self.queue.popleft()

    def close(self) -> None:
        with self.cond:
            self.closed = True
            self.cond.notify_all()


class _SlotTap:
    """Single shared TCP reader for one slot's monitor_port."""

    def __init__(self, hub: "SerialHub", label: str):
        self.hub = hub
        self.label = label
        self.lock = threading.Lock()
        self.subs: set[_Subscriber] = set()
        self.last_empty = 0.0
        self.connected = False
        self.last_status: dict | None = None
        self.stop_ev = threading.Event()
        self.thread: threading.Thread | None = None

    def add(self, sub: _Subscriber) -> dict | None:
        with self.lock:
            self.subs.add(sub)
            self.last_empty = 0.0
            if self.thread is None or not self.thread.is_alive():
                self.stop_ev.clear()
                self.thread = threading.Thread(
                    target=self._run, name=f"serial-tap-{self.label}", daemon=True
                )
                self.thread.start()
            return dict(self.last_status) if self.last_status else None

    def remove(self, sub: _Subscriber) -> None:
        with self.lock:
            self.subs.discard(sub)
            if not self.subs:
                self.last_empty = time.monotonic()

    def _broadcast(self, event: str, payload: dict) -> None:
        with self.lock:
            targets = list(self.subs)
        for sub in targets:
            sub.push(event, payload)

    def _should_retire(self) -> bool:
        with self.lock:
            if self.subs:
                return False
            return self.last_empty > 0 and (time.monotonic() - self.last_empty) >= self.hub.idle_grace_s

    def _publish_status(self, info: dict | None, connected: bool) -> dict:
        status = self.hub._build_status(self.label, info, connected)
        if status != self.last_status:
            self.last_status = status
            self._broadcast("status", status)
        return status

    def _run(self) -> None:
        while not self.stop_ev.is_set():
            if self._should_retire():
                break
            info = self.hub.get_slot_info(self.label)
            probing = self.hub.is_probing(self.label)
            mport = info.get("monitor_port") if info else None
            running = bool(info and info.get("running") and mport) and not probing

            if not running:
                self.connected = False
                self._publish_status(info, False)
                self.stop_ev.wait(0.4)
                continue

            sock = None
            try:
                sock = socket.create_connection((self.hub.monitor_host, int(mport)), timeout=2.0)
                sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
                sock.settimeout(0.5)
            except OSError:
                self.connected = False
                self._publish_status(self.hub.get_slot_info(self.label, force=True), False)
                self.stop_ev.wait(0.5)
                continue

            self.connected = True
            self._publish_status(info, True)
            last_check = time.monotonic()
            try:
                while not self.stop_ev.is_set():
                    if self._should_retire():
                        return
                    try:
                        chunk = sock.recv(4096)
                    except socket.timeout:
                        now = time.monotonic()
                        if now - last_check >= 1.0:
                            last_check = now
                            cur = self.hub.get_slot_info(self.label)
                            if self.hub.is_probing(self.label) or not (cur and cur.get("running")):
                                break
                            self._publish_status(cur, True)
                        continue
                    except OSError:
                        break
                    if not chunk:
                        break
                    self._broadcast("data", {
                        "slot": self.label,
                        "ts": round(time.time() * 1000),
                        "b64": base64.b64encode(chunk).decode("ascii"),
                    })
                    now = time.monotonic()
                    if now - last_check >= 1.0:
                        last_check = now
                        self._publish_status(self.hub.get_slot_info(self.label), True)
            finally:
                try:
                    sock.close()
                except OSError:
                    pass
                self.connected = False

            if not self._should_retire():
                self._publish_status(self.hub.get_slot_info(self.label, force=True), False)
                self.stop_ev.wait(0.4)


class SerialHub:
    """Multiplexed read-only serial streaming hub backed by portal monitor ports."""

    def __init__(self, portal_url: str = DEFAULT_PORTAL, dut_prober=None,
                 monitor_host: str = "127.0.0.1", keepalive_s: float = KEEPALIVE_S,
                 idle_grace_s: float = IDLE_GRACE_S):
        self.portal_url = portal_url.rstrip("/")
        self.dut_prober = dut_prober
        self.monitor_host = monitor_host
        self.keepalive_s = keepalive_s
        self.idle_grace_s = idle_grace_s
        self._taps_lock = threading.Lock()
        self._taps: dict[str, _SlotTap] = {}
        self._dev_lock = threading.Lock()
        self._dev_cache: dict[str, dict] = {}
        self._dev_ts = 0.0

    def is_probing(self, label: str) -> bool:
        return bool(self.dut_prober and getattr(self.dut_prober, "busy_slot", None) == label)

    def get_slot_info(self, label: str, force: bool = False) -> dict | None:
        now = time.monotonic()
        with self._dev_lock:
            if not force and (now - self._dev_ts) < DEVICE_CACHE_S and self._dev_cache:
                return self._dev_cache.get(label)
        try:
            with urllib.request.urlopen(f"{self.portal_url}/api/devices", timeout=2.0) as r:
                data = json.loads(r.read())
            by_label = {s["label"]: s for s in data.get("slots", []) if s.get("label")}
            with self._dev_lock:
                self._dev_cache = by_label
                self._dev_ts = time.monotonic()
            return by_label.get(label)
        except OSError:
            with self._dev_lock:
                return self._dev_cache.get(label)

    def _fetch_backlog(self, label: str, lines: int) -> list[dict]:
        if lines <= 0:
            return []
        try:
            q = urllib.parse.urlencode({"slot": label, "lines": min(lines, 500), "since": 0})
            with urllib.request.urlopen(f"{self.portal_url}/api/serial/output?{q}", timeout=2.0) as r:
                data = json.loads(r.read())
            if data.get("ok"):
                return data.get("lines") or []
        except (OSError, ValueError):
            pass
        return []

    def _build_status(self, label: str, info: dict | None, connected: bool) -> dict:
        if self.is_probing(label):
            conn = "probing"
        elif not info or not info.get("present"):
            conn = "absent"
        else:
            st = info.get("state") or ""
            if st in ("flashing", "resetting"):
                conn = "flashing"
            elif st in ("download_mode", "recovering", "flapping"):
                conn = st
            elif connected and info.get("running"):
                conn = "connected"
            else:
                conn = "reconnecting"

        info = info or {}
        return {
            "slot": label,
            "conn": conn,
            "state": info.get("state") or "absent",
            "present": bool(info.get("present")),
            "running": bool(info.get("running")),
            "devnode": info.get("devnode"),
            "tcp_port": info.get("tcp_port"),
            "monitor_port": info.get("monitor_port"),
            "detected_chip": info.get("detected_chip"),
            "usb_devices": info.get("usb_devices") or [],
            "has_gpio": bool(info.get("has_gpio")),
            "gpio_wired": info.get("gpio_wired"),
            "gpio_wired_detail": info.get("gpio_wired_detail"),
            "last_error": info.get("last_error"),
        }

    def _tap_for(self, label: str) -> _SlotTap:
        with self._taps_lock:
            tap = self._taps.get(label)
            if tap is None:
                tap = _SlotTap(self, label)
                self._taps[label] = tap
            return tap

    def stream_sse(self, slot_labels: list[str], backlog: int = 200,
                   is_disconnected=None):
        """Yield SSE-encoded byte chunks for the requested slot labels."""
        clean = []
        for s in slot_labels:
            s = s.strip()
            if s and s not in clean:
                clean.append(s)
        clean = clean[:8]
        if not clean:
            return

        sub = _Subscriber()
        taps = [self._tap_for(lbl) for lbl in clean]
        # Force a fresh snapshot so newly attached browsers see current status immediately.
        self.get_slot_info(clean[0], force=True)
        try:
            for lbl, tap in zip(clean, taps):
                cur = tap.add(sub)
                if cur is None:
                    cur = self._build_status(lbl, self.get_slot_info(lbl), tap.connected)
                sub.push("status", cur)
                if backlog > 0:
                    hist = self._fetch_backlog(lbl, backlog)
                    if hist:
                        sub.push("backlog", {"slot": lbl, "lines": hist})

            yield b"retry: 2000\n\n"
            last_send = time.monotonic()
            poll_s = min(1.0, self.keepalive_s)
            while True:
                if is_disconnected and is_disconnected():
                    break
                item = sub.pop(timeout=poll_s)
                if item is None:
                    break
                ev, payload = item
                if ev == "_ping":
                    if is_disconnected and is_disconnected():
                        break
                    if (time.monotonic() - last_send) >= self.keepalive_s:
                        last_send = time.monotonic()
                        yield b": ping\n\n"
                else:
                    last_send = time.monotonic()
                    body = json.dumps(payload, separators=(",", ":"))
                    yield f"event: {ev}\ndata: {body}\n\n".encode("utf-8")
        finally:
            sub.close()
            for tap in taps:
                tap.remove(sub)

    def shutdown(self) -> None:
        with self._taps_lock:
            taps = list(self._taps.values())
        for tap in taps:
            tap.stop_ev.set()
