#!/bin/bash
# Install/update the HIL instruments service. Independent of pi/install.sh:
# touches nothing the upstream portal owns. Idempotent.
set -e
SRC="$(cd "$(dirname "$0")" && pwd)"
DEST=/usr/local/lib/hil-instruments

python3 -c "import smbus2" 2>/dev/null || \
    pip3 install smbus2 --break-system-packages
raspi-config nonint do_i2c 0 2>/dev/null || true
# Logic analyzer: sigrok-cli + FX2 firmware, numpy for edge extraction.
dpkg -s sigrok-cli sigrok-firmware-fx2lafw python3-numpy >/dev/null 2>&1 || \
    apt-get install -y sigrok-cli sigrok-firmware-fx2lafw python3-numpy

mkdir -p "$DEST"
cp "$SRC/ads1110.py" "$SRC/ads1115.py" "$SRC/gp8413.py" "$SRC/servos8.py" "$SRC/meter_stream.py" "$SRC/logic.py" "$SRC/dut.py" \
   "$SRC/dut_probe.py" "$SRC/serial_hub.py" "$SRC/instruments_server.py" "$SRC/panel_meter.js" \
   "$SRC/panel_logic.js" "$SRC/panel_dut.js" "$SRC/panel_dac.js" "$SRC/panel_io.js" "$SRC/panel_serial.js" "$DEST/"
cp "$SRC/hil-instruments.service" /etc/systemd/system/
systemctl daemon-reload
systemctl enable hil-instruments >/dev/null
systemctl restart hil-instruments
sleep 1
curl -s http://localhost:8081/api/info && echo
