"""ADS1110 16-bit ADC (M5Stack Unit ADC v1.1, U013-V11) — bench voltmeter.

TI SBAS276A: one-byte config write; a read returns [out_hi, out_lo, config].
Config: bit7 ST/DRDY, bit4 SC (0 = continuous), bits3-2 DR, bits1-0 PGA.
Internal 2.048 V reference, FS = +/-2.048 V / PGA at VIN+.

Unit ADC v1.1 front end: VIN -> 510k/100k divider -> LM358 follower -> VIN+,
VIN- tied to GND. Single-ended and NOT isolated: the measured point must share
ground with the Pi. Nominal input scale 6.1; calibrate per unit.
"""
import threading
import time

try:
    import smbus2  # type: ignore[import-not-found]
except ImportError:  # allows import on non-Pi machines
    smbus2 = None

ST_DRDY = 0x80
DR_BITS = {240: 0, 60: 1, 30: 2, 15: 3}
MIN_CODE = {240: 2048, 60: 8192, 30: 16384, 15: 32768}  # datasheet Table 1
PGA_BITS = {1: 0, 2: 1, 4: 2, 8: 3}
VREF = 2.048
NOMINAL_SCALE = (510 + 100) / 100


class ADS1110Error(Exception):
    pass


class ADS1110:
    def __init__(self, bus: int = 1, address: int = 0x48,
                 scale: float = NOMINAL_SCALE, offset_v: float = 0.0) -> None:
        if smbus2 is None:
            raise ADS1110Error("smbus2 not installed")
        self.address = address
        self.scale = scale
        self.offset_v = offset_v
        self._bus = smbus2.SMBus(bus)
        self._lock = threading.RLock()  # stream thread re-enters via configure()
        self.sps, self.pga = 15, 1
        self.configure(self.sps, self.pga)

    @classmethod
    def probe(cls, bus: int = 1, address: int = 0x48) -> bool:
        if smbus2 is None:
            return False
        try:
            with smbus2.SMBus(bus) as b:
                b.read_byte(address)
            return True
        except OSError:
            return False

    def configure(self, sps: int, pga: int) -> None:
        if sps not in DR_BITS or pga not in PGA_BITS:
            raise ADS1110Error(f"sps must be {sorted(DR_BITS)}, pga {sorted(PGA_BITS)}")
        with self._lock:
            self._bus.write_byte(self.address, (DR_BITS[sps] << 2) | PGA_BITS[pga])
            self.sps, self.pga = sps, pga

    def _raw(self):
        msg = smbus2.i2c_msg.read(self.address, 3)
        self._bus.i2c_rdwr(msg)
        b = list(msg)
        code = (b[0] << 8) | b[1]
        if code & 0x8000:
            code -= 0x10000
        return code, b[2]

    def _fresh(self, timeout_s: float) -> int:
        deadline = time.monotonic() + timeout_s
        while time.monotonic() < deadline:
            code, cfg = self._raw()
            if not cfg & ST_DRDY:
                return code
            time.sleep(0.005)
        raise ADS1110Error("conversion timeout")

    def lsb_v(self) -> float:
        """ADC-input volts per code at the current rate and gain."""
        return VREF / (MIN_CODE[self.sps] * self.pga)

    def max_code(self) -> int:
        return MIN_CODE[self.sps] - 1

    def full_scale_v(self, pga: int | None = None) -> float:
        """Calibrated input full scale (front-end divider included)."""
        return VREF / (pga or self.pga) * self.scale

    def to_volts(self, code: float) -> float:
        return code * self.lsb_v() * self.scale + self.offset_v

    def read(self, samples: int = 8) -> dict:
        if not 1 <= samples <= 256:
            raise ADS1110Error("samples must be 1..256")
        timeout = 3.0 / self.sps + 0.05
        with self._lock:
            self._fresh(timeout)  # may predate the call: discard
            codes = [self._fresh(timeout) for _ in range(samples)]
        lsb = self.lsb_v()
        mean = sum(codes) / len(codes)
        v_adc = mean * lsb
        return {
            "samples": samples, "sps": self.sps, "pga": self.pga,
            "code": round(mean, 2), "code_min": min(codes), "code_max": max(codes),
            "v_adc": round(v_adc, 6),
            "volts": round(v_adc * self.scale + self.offset_v, 5),
            "full_scale_v": round(self.full_scale_v(), 3),
            "cal": {"scale": self.scale, "offset_v": self.offset_v},
        }

    def status(self) -> dict:
        return {"address": f"0x{self.address:02x}", "sps": self.sps, "pga": self.pga,
                "full_scale_v": round(self.full_scale_v(), 3),
                "lsb_v": self.lsb_v() * self.scale,
                "ranges": {str(g): round(self.full_scale_v(g), 3) for g in PGA_BITS},
                "cal": {"scale": self.scale, "offset_v": self.offset_v}}
