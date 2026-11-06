"""GP8413 dual 15-bit I2C DAC (M5Stack Unit DAC2, U012-B) — bench DC source.

Protocol, from the GP8413 datasheet and the DFRobot_GP8XXX reference driver:
  reg 0x01 <- 0x11 selects 0-10 V (0x00 would select 0-5 V, both channels)
  reg 0x02 <- [lo, hi]  VOUT0;  reg 0x04 <- [lo, hi]  VOUT1
  the 15-bit code is sent left-aligned (code << 1), low byte first.
The chip is write-only, so the driver keeps the last state it wrote.

Only the 0-10 V range is used: on the unit measured the 0-5 V range was not
repeatable (gain 1.00..1.05 between runs) and clipped at ~5.1 V, while the
10 V range repeats within a few mV. A lower ceiling is set with max_v.
Measured: the output moves every 8 codes (12-bit effective, 2.44 mV steps).

The service sets the range and both outputs to 0 V when it starts (known
state). Optional per-channel correction from a calibration against the bench
voltmeter: code = (volts - offset_v) / gain, so the requested volts are what
the output really gives.
"""
import threading

try:
    import smbus2  # type: ignore[import-not-found]
except ImportError:  # allows import on non-Pi machines
    smbus2 = None

REG_RANGE = 0x01
REG_CH = {0: 0x02, 1: 0x04}
RANGE_10V = 0x11
RANGE_V = 10.0
CODE_MAX = 0x7FFF
STEP_V = RANGE_V / 4096          # measured effective resolution


class GP8413Error(Exception):
    pass


class GP8413:
    def __init__(self, bus: int = 1, address: int = 0x59, cal: dict | None = None,
                 max_v: float | None = None) -> None:
        if smbus2 is None:
            raise GP8413Error("smbus2 not installed")
        self.address = address
        # cal: {"0": {"gain": 0.9979, "offset_v": 0.0166}, "1": {...}}
        self.cal = {ch: {"gain": 1.0, "offset_v": 0.0, **(cal or {}).get(str(ch), {})}
                    for ch in (0, 1)}
        self.max_v = RANGE_V if max_v is None else min(float(max_v), RANGE_V)
        self._bus = smbus2.SMBus(bus)
        self._lock = threading.Lock()
        self.volts = [None, None]
        self.codes = [None, None]

    @classmethod
    def probe(cls, bus: int = 1, address: int = 0x59) -> bool:
        if smbus2 is None:
            return False
        try:
            with smbus2.SMBus(bus) as b:
                b.write_quick(address)
            return True
        except OSError:
            return False

    def init(self) -> None:
        """10 V range, both outputs 0 V."""
        with self._lock:
            self._bus.write_byte_data(self.address, REG_RANGE, RANGE_10V)
            for ch in (0, 1):
                self._write_code(ch, 0)
                self.volts[ch] = 0.0

    def set_voltage(self, channel: int, volts: float) -> int:
        if channel not in REG_CH:
            raise GP8413Error(f"channel must be 0 or 1, got {channel}")
        if not 0.0 <= volts <= self.max_v:
            raise GP8413Error(f"volts must be 0..{self.max_v:g}, got {volts}")
        c = self.cal[channel]
        target = (volts - c["offset_v"]) / c["gain"] if volts > 0 else 0.0
        code = max(0, min(CODE_MAX, round(target / RANGE_V * CODE_MAX)))
        with self._lock:
            self._write_code(channel, code)
            self.volts[channel] = volts
        return code

    def _write_code(self, channel: int, code: int) -> None:
        word = (code & CODE_MAX) << 1
        self._bus.write_i2c_block_data(self.address, REG_CH[channel],
                                       [word & 0xFF, (word >> 8) & 0xFF])
        self.codes[channel] = code

    def status(self) -> dict:
        return {"model": "DAC2 (GP8413)", "address": f"0x{self.address:02x}",
                "range_v": RANGE_V, "max_v": self.max_v,
                "volts": self.volts, "codes": self.codes, "code_max": CODE_MAX,
                "step_v": STEP_V,
                "cal": {str(k): v for k, v in self.cal.items()}}
