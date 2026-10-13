#!/usr/bin/env python3
"""Read an ESP32's identity in one ROM-bootloader session; print JSON.

    dut_probe.py /dev/ttyACM0

Chip (model, revision, features, crystal, MAC), flash (JEDEC id, detected
size), partition table and, for every app partition, the esp_app_desc_t the
build embedded (project, version, IDF, compile time, ELF SHA-256).

The chip is reset into the bootloader to do this and left with a watchdog
reset: on the ESP32-S3 USB-Serial/JTAG an RTS "hard reset" does not resample
the strapping pins and the chip stays in download mode (TRM S3 §33.4), which
is why this runs as one session instead of several esptool commands.
Run in its own process: the caller (instruments service) must have stopped
the portal's RFC2217 proxy for the port first.
"""
import contextlib
import io
import json
import struct
import sys

from esptool.cmds import detect_chip, detect_flash_size

PART_TABLE = 0x8000
PART_LEN = 0xC00
TYPES = {0: "app", 1: "data"}
APP_SUB = {0x00: "factory", 0x20: "test", **{0x10 + i: f"ota_{i}" for i in range(16)}}
DATA_SUB = {0x00: "ota", 0x01: "phy", 0x02: "nvs", 0x03: "coredump", 0x04: "nvs_keys",
            0x05: "efuse", 0x06: "undefined", 0x80: "esphttpd", 0x81: "fat", 0x82: "spiffs",
            0x83: "littlefs"}
APP_DESC_MAGIC = 0xABCD5432


def cstr(b: bytes) -> str:
    return b.split(b"\0", 1)[0].decode(errors="replace")


def partitions(raw: bytes) -> list:
    out = []
    for i in range(0, len(raw), 32):
        e = raw[i:i + 32]
        magic = struct.unpack_from("<H", e)[0]
        if magic != 0x50AA:          # 0xEBEB = MD5 entry, 0xFFFF = end
            break
        ptype, sub, off, size = struct.unpack_from("<BBII", e, 2)
        out.append({"label": cstr(e[12:28]), "type": TYPES.get(ptype, ptype),
                    "subtype": (APP_SUB if ptype == 0 else DATA_SUB).get(sub, f"0x{sub:02x}"),
                    "offset": off, "size": size,
                    "encrypted": bool(struct.unpack_from("<I", e, 28)[0] & 1)})
    return out


def app_desc(raw: bytes):
    # image header (24 B) + first segment header (8 B), then esp_app_desc_t
    if not raw or raw[0] != 0xE9:
        return {"empty": True}
    d = raw[32:32 + 256]
    if struct.unpack_from("<I", d)[0] != APP_DESC_MAGIC:
        return {"image": True, "app_desc": False}
    return {"secure_version": struct.unpack_from("<I", d, 4)[0],
            "version": cstr(d[16:48]), "project": cstr(d[48:80]),
            "time": cstr(d[80:96]), "date": cstr(d[96:112]), "idf": cstr(d[112:144]),
            "elf_sha256": d[144:176].hex()}


def main(port: str) -> dict:
    res = {"port": port}
    log = io.StringIO()
    with contextlib.redirect_stdout(log):
        esp = detect_chip(port, connect_attempts=5)
        try:
            res["chip"] = esp.CHIP_NAME
            res["description"] = esp.get_chip_description()
            res["features"] = esp.get_chip_features()
            res["crystal_mhz"] = esp.get_crystal_freq()
            res["mac"] = ":".join(f"{b:02x}" for b in esp.read_mac())
            esp = esp.run_stub()
            fid = esp.flash_id()
            res["flash"] = {"jedec_id": f"0x{fid:06x}", "manufacturer": f"0x{fid & 0xff:02x}",
                            "device": f"0x{(fid >> 8) & 0xff:02x}{(fid >> 16) & 0xff:02x}",
                            "size": detect_flash_size(esp)}
            parts = partitions(esp.read_flash(PART_TABLE, PART_LEN))
            res["partitions"] = parts
            for p in parts:
                if p["type"] == "app" and not p["encrypted"]:
                    p["app"] = app_desc(esp.read_flash(p["offset"], 32 + 256))
            otadata = next((p for p in parts if p["type"] == "data" and p["subtype"] == "ota"), None)
            res["has_otadata"] = otadata is not None
        finally:
            # Watchdog reset: the only reset that boots the app again on an
            # S3 USB-Serial/JTAG (an RTS hard reset leaves it in download mode).
            try:
                esp.watchdog_reset()
            except Exception:  # noqa: BLE001 - chips without it: plain hard reset
                esp.hard_reset()
            esp._port.close()
    res["esptool_log"] = log.getvalue()[-2000:]
    return res


if __name__ == "__main__":
    try:
        print(json.dumps({"ok": True, **main(sys.argv[1])}))
    except Exception as e:  # noqa: BLE001
        print(json.dumps({"ok": False, "error": f"{type(e).__name__}: {e}"}))
        sys.exit(1)
