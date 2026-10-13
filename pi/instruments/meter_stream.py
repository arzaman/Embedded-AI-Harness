"""Continuous voltmeter acquisition for live clients (dashboard panel).

A background thread reads every conversion into a ring buffer, timestamped
with the Pi wall clock (epoch ms) so traces line up with other bench captures
(logic analyzer, serial log). It runs only while somebody polls: a client
that stops calling poll() lets the thread exit after IDLE_STOP_S, so the I2C
bus is quiet when nobody is watching.

Autorange steps the PGA one notch at a time with hysteresis: down when a
sample is above 95 % of full scale, up when it would still sit below 80 %
of the next (smaller) range. The first conversion after a gain change is discarded.
"""
import collections
import threading
import time

from ads1110 import PGA_BITS, ADS1110Error

BUFFER = 240 * 60 * 15      # 15 min at the fastest rate
IDLE_STOP_S = 15.0
MAX_BATCH = 4000
GAINS = sorted(PGA_BITS)    # 1, 2, 4, 8


class MeterStream:
    def __init__(self, meter) -> None:
        self.meter = meter
        self.autorange = False
        self._buf = collections.deque(maxlen=BUFFER)  # (seq, t_ms, volts, ol)
        self._seq = 0
        self._cond = threading.Condition()
        self._thread = None
        self._last_poll = 0.0
        self._error = None
        self._discard = False

    @property
    def running(self) -> bool:
        return self._thread is not None and self._thread.is_alive()

    def poll(self, since: int, limit: int = MAX_BATCH) -> dict:
        self._last_poll = time.monotonic()
        if not self.running:
            self._error = None
            self._thread = threading.Thread(target=self._run, daemon=True,
                                            name="meter-stream")
            self._thread.start()
        with self._cond:
            if since > self._seq:      # client from before a service restart
                since = 0
            new = [s for s in self._buf if s[0] > since][-limit:]
            seq = self._seq
        m = self.meter
        return {"seq": seq, "running": self.running, "error": self._error,
                "autorange": self.autorange, "sps": m.sps, "pga": m.pga,
                "range_v": round(m.full_scale_v(), 3), "lsb_v": m.lsb_v() * m.scale,
                "samples": [[t, v, ol] for _, t, v, ol in new]}

    def _step_gain(self, code: int) -> bool:
        m = self.meter
        i = GAINS.index(m.pga)
        full = m.max_code()
        if abs(code) >= 0.95 * full and i > 0:
            m.configure(m.sps, GAINS[i - 1])
            return True
        if i + 1 < len(GAINS) and abs(code) * GAINS[i + 1] / m.pga < 0.8 * full:
            m.configure(m.sps, GAINS[i + 1])
            return True
        return False

    def _run(self) -> None:
        m = self.meter
        self._discard = True
        while time.monotonic() - self._last_poll < IDLE_STOP_S:
            try:
                with m._lock:
                    code = m._fresh(3.0 / m.sps + 0.05)
                    t_ms = int(time.time() * 1000)
                    if self._discard:      # may predate a config change
                        self._discard = False
                        continue
                    if self.autorange and self._step_gain(code):
                        self._discard = True
                        continue
                    ol = abs(code) >= m.max_code()
                    volts = round(m.to_volts(code), 6)
                with self._cond:
                    self._seq += 1
                    self._buf.append((self._seq, t_ms, volts, int(ol)))
                self._error = None
                time.sleep(0.7 / m.sps)    # leave the bus to /read and /config
            except (ADS1110Error, OSError) as e:
                self._error = str(e)
                time.sleep(0.5)

    def reconfigured(self) -> None:
        """Call after an external configure(): drop the conversion in flight."""
        self._discard = True
