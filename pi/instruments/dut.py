"""DUT identity for the dashboard slot cards.

Two levels, very different in cost:

* USB (sysfs): VID:PID, strings (the ESP32-S3/C3/C6 USB-Serial/JTAG serial
  number *is* the MAC), speed, power, port, interfaces with their drivers and
  tty nodes. Free, no traffic to the device: polled.
* ROM bootloader (dut_probe.py, esptool API): chip, revision, features,
  crystal, MAC, flash JEDEC id and size, partition table, the esp_app_desc of
  every app partition. Resets the DUT, so only on request, and the result is
  cached per device (USB serial) with the time it was read.

The probe needs the serial port: the portal's RFC2217 proxy for the slot is
stopped first. After the watchdog reset a native-USB chip re-enumerates (often
on a new ttyACM) and the portal's hotplug restarts the proxy by itself; a
USB-UART bridge does not re-enumerate, so the proxy is started explicitly on
the node the device has in sysfs.
"""
import glob
import json
import os
import subprocess
import sys
import threading
import time
import urllib.request

PORTAL = "http://127.0.0.1:8080"
HERE = os.path.dirname(os.path.abspath(__file__))
CACHE_FILE = "/var/lib/hil-instruments/dut-cache.json"
VENDORS = {"303a": "Espressif", "10c4": "Silicon Labs", "1a86": "WCH",
           "0403": "FTDI", "067b": "Prolific"}
IFACE_CLASS = {"02": "CDC control", "0a": "CDC data", "ff": "vendor", "03": "HID", "08": "mass storage"}


def _read(path):
    try:
        with open(path) as f:
            return f.read().strip()
    except OSError:
        return None


def _portal(path, body=None, timeout=10):
    req = urllib.request.Request(PORTAL + path, method="POST" if body is not None else "GET",
                                 data=json.dumps(body).encode() if body is not None else None,
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read())


def usb_devices() -> list:
    """ESP32-capable USB devices (native USB or a known USB-UART bridge)."""
    out = []
    for d in sorted(glob.glob("/sys/bus/usb/devices/*")):
        name = os.path.basename(d)
        if ":" in name or name.startswith("usb"):
            continue
        vid, pid = _read(d + "/idVendor"), _read(d + "/idProduct")
        if vid not in VENDORS:
            continue
        ifaces = []
        for i in sorted(glob.glob(f"{d}/{name}:*")):
            drv = os.path.basename(os.readlink(i + "/driver")) if os.path.islink(i + "/driver") else None
            cls = _read(i + "/bInterfaceClass")
            ifaces.append({"interface": os.path.basename(i).split(":", 1)[1], "class": cls,
                           "kind": IFACE_CLASS.get(cls, cls), "driver": drv,
                           "tty": sorted(os.listdir(i + "/tty")) if os.path.isdir(i + "/tty")
                           else [os.path.basename(t) for t in glob.glob(i + "/ttyUSB*")]})
        busnum, devpath = int(_read(d + "/busnum")), _read(d + "/devpath")
        speed = _read(d + "/speed")
        out.append({"sysfs": name, "usb_prefix": f"{busnum - 1}:{devpath}",
                    "vid_pid": f"{vid}:{pid}", "vendor": VENDORS[vid],
                    "manufacturer": _read(d + "/manufacturer"), "product": _read(d + "/product"),
                    "serial": _read(d + "/serial"), "bcd_device": _read(d + "/bcdDevice"),
                    "usb_version": (_read(d + "/version") or "").strip(),
                    "speed_mbps": float(speed) if speed else None,
                    "max_power": _read(d + "/bMaxPower"), "interfaces": ifaces,
                    "ttys": sorted({t for i in ifaces for t in i["tty"]})})
    return out


def device_key(usb: dict) -> str:
    return usb.get("serial") or usb["sysfs"]


class DutProber:
    def __init__(self):
        self.lock = threading.Lock()
        self.busy_slot = None
        try:
            with open(CACHE_FILE) as f:
                self.cache = json.load(f)
        except (OSError, ValueError):
            self.cache = {}

    def status(self) -> dict:
        devs = usb_devices()
        for u in devs:
            u["key"] = device_key(u)
        return {"usb": devs, "probes": self.cache, "busy_slot": self.busy_slot}

    def _save(self):
        os.makedirs(os.path.dirname(CACHE_FILE), exist_ok=True)
        tmp = CACHE_FILE + ".tmp"
        with open(tmp, "w") as f:
            json.dump(self.cache, f, indent=1)
        os.replace(tmp, CACHE_FILE)

    def probe(self, slot_label: str) -> dict:
        if not self.lock.acquire(blocking=False):
            raise RuntimeError(f"busy: probing {self.busy_slot}")
        self.busy_slot = slot_label
        try:
            return self._probe(slot_label)
        finally:
            self.busy_slot = None
            self.lock.release()

    def _slot(self, label):
        for s in _portal("/api/devices")["slots"]:
            if s.get("label") == label:
                return s
        raise ValueError(f"no slot {label!r}")

    def _probe(self, label):
        slot = self._slot(label)
        devnode = slot.get("devnode")
        if not devnode or not slot.get("present"):
            raise ValueError(f"{label}: no device present")
        tty = os.path.basename(devnode)
        usb = next((u for u in usb_devices() if tty in u["ttys"]), None)
        if usb is None:
            raise ValueError(f"{label}: {devnode} is not an ESP32 USB device")
        key, slot_key = device_key(usb), slot["slot_key"]
        t0 = time.time()
        _portal("/api/stop", {"slot_key": slot_key})
        time.sleep(0.5)
        try:
            r = subprocess.run([sys.executable, os.path.join(HERE, "dut_probe.py"), devnode],
                               capture_output=True, text=True, timeout=90)
            try:
                res = json.loads(r.stdout.strip().splitlines()[-1])
            except (ValueError, IndexError):
                res = {"ok": False, "error": (r.stderr or r.stdout or "no output").strip()[-500:]}
        finally:
            proxy = self._restore(slot_key, label, key)
        res["proxy"] = proxy
        res["duration_s"] = round(time.time() - t0, 1)
        if res.get("ok"):
            res["read_at_epoch_ms"] = round(time.time() * 1000)
            res["slot"] = label
            res.pop("esptool_log", None)
            self.cache[key] = res
            self._save()
        return res

    def _restore(self, slot_key, label, key, wait_s=15.0):
        """Wait for the hotplug restart; start the proxy ourselves if it does not come."""
        deadline = time.time() + wait_s
        while time.time() < deadline:
            time.sleep(1.0)
            try:
                s = self._slot(label)
            except (OSError, ValueError):
                continue
            if s.get("running"):
                return {"running": True, "devnode": s.get("devnode"), "by": "hotplug"}
        usb = next((u for u in usb_devices() if device_key(u) == key), None)
        if not usb or not usb["ttys"]:
            return {"running": False, "error": "device did not come back on USB"}
        dev = "/dev/" + usb["ttys"][0]
        try:
            r = _portal("/api/start", {"slot_key": slot_key, "devnode": dev})
            return {"running": bool(r.get("running")), "devnode": dev, "by": "explicit start"}
        except OSError as e:
            return {"running": False, "devnode": dev, "error": str(e)}
