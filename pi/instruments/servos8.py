"""M5Stack Unit 8Servos v1 (U165, STM32F030) as an 8-channel bench I/O unit.

Register map (M5Unit-8Servo reference driver, firmware 0x01):
  0x00+ch  mode: 0 DI, 1 DO, 2 ADC, 3 servo, 4 RGB, 5 PWM
  0x10+ch  DO level (0/1)          0x20+ch  DI level (read)
  0x40+ch*2 ADC 12 bit, little endian
  0x90+ch  PWM duty 0..100 % (fixed ~1 kHz)
  0xFE     firmware version        0xFF     I2C address (stored in flash!)
An open DI reads 1 (measured on FW 0x01; the same pin in ADC mode floats at
~1.7 V): do not rely on it, drive the input. 3.3 V logic, not 5 V tolerant.

Firmware quirk (FW 0x01): a multi-byte READ does not auto-increment — it
returns the first register repeated — while multi-byte writes do. Byte
registers are therefore read one at a time; the 16-bit ADC registers read
fine as 2 bytes.

The unit keeps its configuration in RAM: a power glitch or reset brings every
channel back to DI. The driver remembers what it set and compares it with the
mode registers on every access; a mismatch is counted as a unit reset and the
configuration (modes, DO levels, PWM duty) is written again.
"""
import threading
import time

try:
    import smbus2  # type: ignore[import-not-found]
except ImportError:  # allows import on non-Pi machines
    smbus2 = None

REG_MODE, REG_DO, REG_DI, REG_ADC12, REG_PWM = 0x00, 0x10, 0x20, 0x40, 0x90
REG_FW, REG_ADDR = 0xFE, 0xFF
MODES = {"DI": 0, "DO": 1, "ADC": 2, "PWM": 5}
MODE_NAMES = {v: k for k, v in MODES.items()} | {3: "SERVO", 4: "RGB"}
CHANNELS = 8


class BenchIOError(Exception):
    pass


class Servos8IO:
    model = "8Servos v1 (U165)"

    def __init__(self, bus: int = 1, address: int = 0x25, modes: dict | None = None) -> None:
        if smbus2 is None:
            raise BenchIOError("smbus2 not installed")
        self.address = address
        self._bus = smbus2.SMBus(bus)
        self._lock = threading.RLock()
        self.fw = self._bus.read_byte_data(address, REG_FW)
        self.modes = ["DI"] * CHANNELS
        self.do = [0] * CHANNELS
        self.duty = [0] * CHANNELS
        self.resets = 0
        self.last_reset_epoch_ms = None
        for ch, m in (modes or {}).items():
            self.modes[self._ch(ch)] = self._mode(m)
        self._apply_all()

    @classmethod
    def probe(cls, bus: int = 1, address: int = 0x25) -> bool:
        if smbus2 is None:
            return False
        try:
            with smbus2.SMBus(bus) as b:
                b.read_byte_data(address, REG_FW)
            return True
        except OSError:
            return False

    @staticmethod
    def _ch(ch) -> int:
        c = int(str(ch).upper().removeprefix("IO"))
        if not 0 <= c < CHANNELS:
            raise BenchIOError(f"channel must be 0..{CHANNELS - 1} (or IO0..IO7), got {ch}")
        return c

    @staticmethod
    def _mode(m) -> str:
        m = str(m).upper()
        if m not in MODES:
            raise BenchIOError(f"mode must be one of {list(MODES)}, got {m}")
        return m

    # ── low level ────────────────────────────────────────────────────
    def _unit(self, c: int) -> tuple:
        """(mode register value, static level or None) actually used on the unit.
        PWM 0 % / 100 % run as DO 0 / 1: the unit's PWM at 0 % still emits a
        ~7.5 us pulse every period (measured, FW 0x01)."""
        m = self.modes[c]
        if m == "PWM" and self.duty[c] in (0, 100):
            return MODES["DO"], 1 if self.duty[c] == 100 else 0
        if m == "DO":
            return MODES["DO"], self.do[c]
        return MODES[m], None

    def _apply(self, c: int) -> None:
        code, level = self._unit(c)
        if level is not None:   # static level first: no glitch when switching mode
            self._bus.write_byte_data(self.address, REG_DO + c, level)
        elif self.modes[c] == "PWM":
            self._bus.write_byte_data(self.address, REG_PWM + c, self.duty[c])
        self._bus.write_byte_data(self.address, REG_MODE + c, code)
        if level is not None:
            self._bus.write_byte_data(self.address, REG_DO + c, level)
        elif self.modes[c] == "PWM":
            self._bus.write_byte_data(self.address, REG_PWM + c, self.duty[c])

    def _apply_all(self) -> None:
        with self._lock:
            for c in range(CHANNELS):
                self._apply(c)

    def _regs(self, base: int) -> list:
        return [self._bus.read_byte_data(self.address, base + c) for c in range(CHANNELS)]

    def _check(self) -> bool:
        """Re-apply the configuration if the unit lost it. True if it had."""
        regs = self._regs(REG_MODE)
        if regs == [self._unit(c)[0] for c in range(CHANNELS)]:
            return False
        self.resets += 1
        self.last_reset_epoch_ms = int(time.time() * 1000)
        self._apply_all()
        return True

    # ── API ──────────────────────────────────────────────────────────
    def set_mode(self, ch, mode, level: int = 0) -> dict:
        c, m = self._ch(ch), self._mode(mode)
        with self._lock:
            self._check()
            self.modes[c] = m
            if m == "DO":
                self.do[c] = 1 if level else 0
            if m != "PWM":
                self.duty[c] = 0
            self._apply(c)
        return self.status()

    def write(self, ch, level) -> dict:
        c = self._ch(ch)
        with self._lock:
            self._check()
            if self.modes[c] != "DO":
                raise BenchIOError(f"IO{c} is {self.modes[c]}, not DO (set mode first)")
            self.do[c] = 1 if level else 0
            self._bus.write_byte_data(self.address, REG_DO + c, self.do[c])
        return {"channel": c, "level": self.do[c]}

    def write_many(self, levels: dict) -> dict:
        """Set several DO channels in ONE I2C transaction (the unit auto-increments
        on writes): the outputs change within one bus transfer instead of one HTTP
        call each. Channels between them that are not listed keep their state."""
        if not levels:
            raise BenchIOError("levels required, e.g. {\"IO0\": 1, \"IO1\": 0}")
        want = {self._ch(k): 1 if int(v) else 0 for k, v in levels.items()}
        with self._lock:
            self._check()
            bad = [f"IO{c} is {self.modes[c]}" for c in want if self.modes[c] != "DO"]
            if bad:
                raise BenchIOError(", ".join(bad) + " (set DO first)")
            lo, hi = min(want), max(want)
            for c, v in want.items():
                self.do[c] = v
            block = []
            for c in range(lo, hi + 1):   # unlisted channels: rewrite their own level
                code, level = self._unit(c)
                block.append(level if level is not None else 0)
            if hi > lo and any(self._unit(c)[1] is None for c in range(lo, hi + 1)):
                # a PWM/DI/ADC channel sits in between: avoid touching its DO register
                for c, v in sorted(want.items()):
                    self._bus.write_byte_data(self.address, REG_DO + c, v)
                atomic = False
            elif hi == lo:
                self._bus.write_byte_data(self.address, REG_DO + lo, block[0])
                atomic = True
            else:
                self._bus.write_i2c_block_data(self.address, REG_DO + lo, block)
                atomic = True
        return {"levels": {f"IO{c}": self.do[c] for c in sorted(want)}, "atomic": atomic}

    def pwm(self, ch, duty) -> dict:
        c = self._ch(ch)
        d = int(round(float(duty)))
        if not 0 <= d <= 100:
            raise BenchIOError(f"duty must be 0..100 %, got {duty}")
        with self._lock:
            self._check()
            self.modes[c], self.duty[c] = "PWM", d
            self._apply(c)
        return {"channel": c, "mode": "PWM", "duty_pct": d, "frequency_hz": 1000,
                "note": "unit PWM ~993 Hz measured; 0 % / 100 % driven as a static level"}

    def read(self) -> dict:
        """Level of every channel: DI read from the unit, DO/PWM as commanded,
        ADC in counts (0..4095) and volts (3.3 V reference)."""
        with self._lock:
            lost = self._check()
            di = self._regs(REG_DI)
            chans = []
            for c in range(CHANNELS):
                m = self.modes[c]
                e = {"channel": c, "name": f"IO{c}", "mode": m}
                if m == "DI":
                    e["level"] = 1 if di[c] else 0
                elif m == "DO":
                    e["level"] = self.do[c]
                elif m == "PWM":
                    e["duty_pct"] = self.duty[c]
                elif m == "ADC":
                    lo, hi = self._bus.read_i2c_block_data(self.address, REG_ADC12 + 2 * c, 2)
                    e["adc"] = (hi << 8) | lo
                    e["volts"] = round(e["adc"] * 3.3 / 4095, 4)
                chans.append(e)
        return {"t_epoch_ms": int(time.time() * 1000), "channels": chans,
                "reset_detected": lost}

    def status(self) -> dict:
        with self._lock:
            regs = self._regs(REG_MODE)
        return {"model": self.model, "address": f"0x{self.address:02x}",
                "firmware": f"0x{self.fw:02x}", "modes": self.modes,
                "unit_modes": [MODE_NAMES.get(r, str(r)) for r in regs],
                "in_sync": regs == [self._unit(c)[0] for c in range(CHANNELS)],
                "do": self.do, "duty_pct": self.duty, "pwm_hz": 1000,
                "resets": self.resets, "last_reset_epoch_ms": self.last_reset_epoch_ms,
                "levels": "3.3 V logic; an open DI reads 1"}
