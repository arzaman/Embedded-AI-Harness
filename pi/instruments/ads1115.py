"""ADS1115 16-bit ADC (M5Stack Unit Voltmeter, U087) — isolated bench voltmeter.

TI SBAS444: pointer register 0 = conversion, 1 = config (16 bit, big endian).
Config: bit15 OS (write 1 = start single shot, read 1 = idle), bits14-12 MUX,
bits11-9 PGA, bit8 MODE (1 = single shot), bits7-5 DR, bits4-0 comparator
(0b00011 = disabled).

Unit front end: V+/V- -> resistive divider (x 1/62.82) -> isolated ADS1115
(AIN0-AIN1 differential) behind an I2C isolator and an isolated DC/DC. The
divider feeds AIN0/AIN1 crossed, so the raw code has the opposite sign of the
input: the driver flips it.

Factory calibration lives in an on-board EEPROM (0x53, read only here):
8-byte record per PGA at 0xD0 + pga_bits * 8 = [pga_bits, hope_hi, hope_lo,
actual_hi, actual_lo, xor(bytes 0..4), 0, 0]; factor = hope / actual. Only some
PGAs carry a record; the others use the nearest calibrated one (or 1.0).

Single-shot conversions: every sample is a fresh conversion started by the
driver, so there is no stale-data ambiguity and the bus is quiet when idle.
"""
import threading
import time

try:
    import smbus2  # type: ignore[import-not-found]
except ImportError:  # allows import on non-Pi machines
    smbus2 = None

REG_CONV, REG_CFG = 0x00, 0x01
OS = 0x8000
MUX_P0_N1 = 0x0000
MODE_SINGLE = 0x0100
COMP_OFF = 0x0003
DR_BITS = {8: 0, 16: 1, 32: 2, 64: 3, 128: 4, 250: 5, 475: 6, 860: 7}
# Meter "pga" = gain step exposed to clients (1 = widest usable range).
# ADS1115 PGA bits: 4 = +/-0.512 V, 5 = +/-0.256 V at the ADC input.
PGA_ADC = {1: (4, 0.512), 2: (5, 0.256)}
DIVIDER = 1 / 0.015918958          # M5 reference driver coefficient (~62.82)
INPUT_MAX_V = 36.0                 # unit rating


class ADS1115Error(Exception):
    pass


class U087Meter:
    model = "U087 (ADS1115, isolated)"
    gains = sorted(PGA_ADC)
    rates = sorted(DR_BITS)
    isolated = True

    def __init__(self, bus: int = 1, address: int = 0x49, eeprom: int = 0x53,
                 user_gain: float = 1.0, user_offset_v: float = 0.0,
                 sps: int = 32) -> None:
        if smbus2 is None:
            raise ADS1115Error("smbus2 not installed")
        self.address, self.eeprom = address, eeprom
        self.user_gain, self.user_offset_v = user_gain, user_offset_v
        self._bus = smbus2.SMBus(bus)
        self._lock = threading.RLock()
        self.factory = self._read_factory()
        self.sps, self.pga = sps, 1
        self.configure(sps, 1)

    # Same names as the ADS1110 driver so MeterStream and the server treat
    # both alike.
    @property
    def scale(self) -> float:
        return DIVIDER * self.user_gain

    @property
    def offset_v(self) -> float:
        return self.user_offset_v

    @classmethod
    def probe(cls, bus: int = 1, address: int = 0x49) -> bool:
        if smbus2 is None:
            return False
        try:
            with smbus2.SMBus(bus) as b:
                b.read_i2c_block_data(address, REG_CFG, 2)
            return True
        except OSError:
            return False

    def _read_factory(self) -> dict:
        out = {}
        for bits in range(8):
            try:
                rec = self._bus.read_i2c_block_data(self.eeprom, 0xD0 + bits * 8, 8)
            except OSError:
                return out
            x = rec[0] ^ rec[1] ^ rec[2] ^ rec[3] ^ rec[4]
            hope, actual = (rec[1] << 8) | rec[2], (rec[3] << 8) | rec[4]
            if rec[0] == bits and x == rec[5] and actual:
                out[bits] = hope / actual
        return out

    def factor(self, pga: int | None = None) -> float:
        bits = PGA_ADC[pga or self.pga][0]
        if bits in self.factory:
            return self.factory[bits]
        if self.factory:  # nearest calibrated PGA
            return self.factory[min(self.factory, key=lambda b: abs(b - bits))]
        return 1.0

    def configure(self, sps: int, pga: int) -> None:
        if sps not in DR_BITS or pga not in PGA_ADC:
            raise ADS1115Error(f"sps must be {sorted(DR_BITS)}, pga {sorted(PGA_ADC)}")
        with self._lock:
            self.sps, self.pga = sps, pga

    def _cfg_word(self) -> int:
        return (OS | MUX_P0_N1 | (PGA_ADC[self.pga][0] << 9) | MODE_SINGLE
                | (DR_BITS[self.sps] << 5) | COMP_OFF)

    def _fresh(self, timeout_s: float) -> int:
        """One single-shot conversion; returns the sign-corrected code."""
        w = self._cfg_word()
        self._bus.write_i2c_block_data(self.address, REG_CFG, [w >> 8, w & 0xFF])
        time.sleep(1.0 / self.sps)
        deadline = time.monotonic() + timeout_s
        while True:
            hi, lo = self._bus.read_i2c_block_data(self.address, REG_CFG, 2)
            if hi & 0x80:
                break
            if time.monotonic() > deadline:
                raise ADS1115Error("conversion timeout")
            time.sleep(0.002)
        hi, lo = self._bus.read_i2c_block_data(self.address, REG_CONV, 2)
        code = (hi << 8) | lo
        if code & 0x8000:
            code -= 0x10000
        return -code

    def lsb_v(self) -> float:
        """ADC-input volts per code, factory factor included."""
        return PGA_ADC[self.pga][1] / 32768 * self.factor()

    def max_code(self) -> int:
        return 32767

    def full_scale_v(self, pga: int | None = None) -> float:
        p = pga or self.pga
        return PGA_ADC[p][1] * DIVIDER * self.factor(p) * self.user_gain

    def to_volts(self, code: float) -> float:
        return code * self.lsb_v() * self.scale + self.offset_v

    def read(self, samples: int = 8) -> dict:
        if not 1 <= samples <= 256:
            raise ADS1115Error("samples must be 1..256")
        timeout = 2.0 / self.sps + 0.05
        with self._lock:
            codes = [self._fresh(timeout) for _ in range(samples)]
        mean = sum(codes) / len(codes)
        v_adc = mean * self.lsb_v()
        return {
            "samples": samples, "sps": self.sps, "pga": self.pga,
            "code": round(mean, 2), "code_min": min(codes), "code_max": max(codes),
            "v_adc": round(v_adc, 7),
            "volts": round(v_adc * self.scale + self.offset_v, 5),
            "full_scale_v": round(self.full_scale_v(), 3),
            "ol": max(abs(c) for c in codes) >= self.max_code(),
            "cal": self.cal(),
        }

    def cal(self) -> dict:
        return {"scale": round(self.scale, 5), "offset_v": self.offset_v,
                "factory_factor": round(self.factor(), 6),
                "user_gain": self.user_gain, "user_offset_v": self.user_offset_v}

    def status(self) -> dict:
        return {"model": self.model, "address": f"0x{self.address:02x}",
                "eeprom": f"0x{self.eeprom:02x}", "isolated": True,
                "sps": self.sps, "pga": self.pga, "rates": self.rates,
                "full_scale_v": round(self.full_scale_v(), 3),
                "input_max_v": INPUT_MAX_V,
                "lsb_v": self.lsb_v() * self.scale,
                "ranges": {str(g): round(self.full_scale_v(g), 3) for g in PGA_ADC},
                "factory_cal": {f"pga_bits_{b}": round(f, 6) for b, f in self.factory.items()},
                "cal": self.cal()}
