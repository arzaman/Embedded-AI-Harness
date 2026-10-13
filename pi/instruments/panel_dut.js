// DUT details for the testbench dashboard (portal :8080).
// Served by hil-instruments (:8081), loaded by pi/dashboard_panels.py. It has
// no card of its own: it enriches the portal's USB slot cards that hold an
// ESP32 (native USB or USB-UART bridge) with what the USB descriptors say
// (always) and what the ROM bootloader says (chip, flash, partitions,
// firmware: read on request, it reboots the DUT; cached per device).
// The panel-bar chip "DUT details" switches the enrichment on/off.
(function () {
'use strict';
const script = document.currentScript;
const API = script.src.replace(/\/panel\/dut\.js.*$/, '');
const mount = document.getElementById(script.dataset.mount || 'panel-dut');
if (!mount) return;
mount.style.margin = '0';

const css = `
.slot .dut-x { margin-top: 4px; }
.slot .dut-x div { margin: 2px 0; }
.slot .dut-x .k { color: #8ab; }
.slot .dut-x .d { color: #667; }
.slot .dut-x .h { color: #8ab; font-size: 0.78em; text-transform: uppercase; letter-spacing: 0.05em; margin-top: 8px;
    border-top: 1px solid #0f3460; padding-top: 6px; display: flex; justify-content: space-between; }
.slot .dut-x .h .d { text-transform: none; letter-spacing: 0; }
.slot .dut-x .parts { display: grid; grid-template-columns: auto auto auto 1fr; gap: 0 10px; }
.slot .dut-x .parts span:nth-child(4n) { color: #8ab; }
.slot .dut-x .fw { color: #2ecc71; }
.slot .dut-x button { margin-top: 8px; width: 100%; font-family: inherit; background: #0f3460; color: #cfe; border: 1px solid #2a4070; border-radius: 6px;
    padding: 6px 10px; font-weight: bold; cursor: pointer; }
.slot .dut-x button:hover { border-color: #00d4ff; }
.slot .dut-x button:disabled { opacity: 0.6; cursor: default; }
.slot .dut-x .err { color: #ff6b6b; }
.slot .dut-x .warn { color: #e67e22; }
`;
const style = document.createElement('style');
style.textContent = css;
document.head.appendChild(style);

let status = null, lastSlots = null, enabled = true, busy = null, lastErr = {};
const esc = s => String(s === null || s === undefined ? '' : s).replace(/[&<>"]/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[c]));
const row = (k, v, d) => '<div><span class="k">' + k + ':</span> <span>' + v + '</span>' + (d ? ' <span class="d">' + d + '</span>' : '') + '</div>';
const FLASH_MFR = {'0xc8': 'GigaDevice', '0xef': 'Winbond', '0x20': 'XMC / Micron', '0x68': 'Boya', '0x5e': 'Zbit',
    '0x9d': 'ISSI', '0xc2': 'Macronix', '0x0b': 'XTX', '0x85': 'Puya', '0xa1': 'Fudan'};
function size(n) { return n >= 1048576 ? (n / 1048576) + 'M' : n >= 1024 ? (n / 1024) + 'K' : n + 'B'; }
function ago(ms) {
    const s = (Date.now() - ms) / 1000;
    return s < 90 ? Math.round(s) + ' s ago' : s < 5400 ? Math.round(s / 60) + ' min ago' : s < 129600 ? Math.round(s / 3600) + ' h ago' : Math.round(s / 86400) + ' d ago';
}
function speedTxt(m) {
    return m === 480 ? 'High-Speed 480 Mb/s' : m === 12 ? 'Full-Speed 12 Mb/s' : m === 1.5 ? 'Low-Speed 1.5 Mb/s' : m ? m + ' Mb/s' : '—';
}

function usbHtml(u) {
    const ifs = u.interfaces.map(i => esc(i.kind) + (i.tty.length ? ' → ' + i.tty.map(esc).join(',') : '') +
        (i.driver ? '' : i.kind === 'vendor' && u.vid_pid === '303a:1001' ? ' (JTAG, OpenOCD)' : ' (no driver)')).join(' · ');
    const isMac = /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/i.test(u.serial || '');
    return '<div class="h"><span>USB</span></div>' +
        (isMac ? row('MAC', esc(u.serial.toLowerCase()), 'USB serial number') : row('Serial', esc(u.serial || '—'))) +
        row('ID', esc(u.vid_pid), esc(u.manufacturer || u.vendor) + ' · bcdDevice ' + esc(u.bcd_device)) +
        row('Product', esc(u.product || '—')) +
        row('Link', 'USB ' + esc(u.usb_version) + ' ' + speedTxt(u.speed_mbps), esc(u.max_power || '')) +
        row('Port', esc(u.sysfs) + ' (' + esc(u.usb_prefix) + ')') +
        row('Interfaces', ifs || '—');
}
function probeHtml(p, u) {
    const f = p.flash || {}, mfr = FLASH_MFR[f.manufacturer];
    let h = '<div class="h"><span>Chip</span><span class="d">bootloader read ' + ago(p.read_at_epoch_ms) + '</span></div>' +
        row('Chip', esc(p.description || p.chip)) +
        row('Features', (p.features || []).map(esc).join(', ') || '—') +
        row('Crystal', p.crystal_mhz ? p.crystal_mhz + ' MHz' : '—') +
        row('MAC', esc(p.mac || '—'), u && u.serial && p.mac && u.serial.toLowerCase() === p.mac ? 'eFuse, = USB serial' : 'eFuse') +
        row('Flash', esc(f.size || '?'), (mfr || 'mfr ' + esc(f.manufacturer)) + ' · JEDEC ' + esc(f.jedec_id));
    const parts = p.partitions || [];
    if (parts.length) {
        h += '<div class="h"><span>Partitions</span><span class="d">' + parts.length + ' · table @0x8000</span></div><div class="parts">' +
            parts.map(q => '<span>' + esc(q.label) + '</span><span>' + esc(q.type) + '/' + esc(q.subtype) + '</span><span>0x' +
                q.offset.toString(16) + '</span><span>' + size(q.size) + (q.encrypted ? ' enc' : '') + '</span>').join('') + '</div>';
    }
    const apps = parts.filter(q => q.type === 'app');
    if (apps.length) {
        h += '<div class="h"><span>Firmware</span><span class="d">esp_app_desc in flash</span></div>';
        for (const q of apps) {
            const a = q.app || {};
            if (a.empty) { h += row(esc(q.label), '<span class="d">empty</span>'); continue; }
            if (!a.project) { h += row(esc(q.label), '<span class="d">image without app descriptor</span>'); continue; }
            const built = (a.date || a.time) ? esc((a.date + ' ' + a.time).trim()) : 'reproducible build (no date)';
            h += row(esc(q.label), '<span class="fw">' + esc(a.project) + ' ' + esc(a.version) + '</span>', 'IDF ' + esc(a.idf)) +
                row('Built', built, 'ELF ' + esc((a.elf_sha256 || '').slice(0, 12)) + '…');
        }
        if (p.has_otadata && apps.length > 1) h += '<div class="d">OTA layout: the running slot is chosen by otadata (not read)</div>';
    }
    return h;
}
function slotHtml(s, u) {
    const key = u ? u.key : null;
    const p = key && status.probes ? status.probes[key] : null;
    let h = u ? usbHtml(u) : '';
    if (p) h += probeHtml(p, u);
    const working = busy === s.label || status.busy_slot === s.label;
    const label = working ? 'Reading… the DUT is rebooting' : (p ? '↻ Re-read chip & firmware' : 'Read chip & firmware');
    h += '<button type="button" data-dut-slot="' + esc(s.label) + '"' + (working || status.busy_slot ? ' disabled' : '') +
        ' title="Enters the ROM bootloader with esptool: REBOOTS the DUT (its outputs reset), then resumes the app">' + label + '</button>';
    if (lastErr[s.label]) h += '<div class="err">' + esc(lastErr[s.label]) + '</div>';
    else if (!p && !working) h += '<div class="d" style="margin-top:4px">reboots the DUT · ~5 s · result kept per device</div>';
    return h;
}

function decorate() {
    const box = document.getElementById('slots');
    if (!box || !lastSlots || !status) return;
    lastSlots.forEach((s, k) => {
        const card = box.children[k];
        if (!card) return;
        const old = card.querySelector('.dut-x');
        if (old) old.remove();
        if (!enabled || !s.devnode || !s.present) return;
        const tty = s.devnode.split('/').pop();
        const u = (status.usb || []).find(x => x.ttys.includes(tty));
        if (!u) return;
        const div = document.createElement('div');
        div.className = 'slot-info dut-x';          // portal font/colours, like the rows above
        div.innerHTML = slotHtml(s, u);
        const info = card.querySelector('.slot-info');
        (info || card).after(div);
        const b = div.querySelector('button[data-dut-slot]');
        if (b) b.onclick = () => probe(s.label);
    });
}
async function probe(label) {
    if (!confirm('Read chip & firmware of ' + label + '?\n\nesptool puts the ESP32 in its ROM bootloader: the DUT REBOOTS ' +
        '(firmware restarts, outputs such as the DAC go back to their power-on state). Takes ~5 s.')) return;
    busy = label; lastErr[label] = null; decorate();
    try {
        const r = await fetch(API + '/api/dut/probe', {method: 'POST', headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({slot: label})});
        const j = await r.json();
        if (!j.ok) lastErr[label] = 'probe failed: ' + (j.error || r.status);
        else if (j.proxy && !j.proxy.running) lastErr[label] = 'read OK, but the serial proxy did not come back: ' + (j.proxy.error || '');
    } catch (e) { lastErr[label] = 'probe failed: ' + e.message; }
    busy = null;
    await refresh();
}
async function refresh() {
    try {
        const r = await fetch(API + '/api/dut/status');
        const j = await r.json();
        if (j.ok) { status = j; decorate(); }
    } catch (e) { /* service down: cards stay stock */ }
}

// Wrap the portal's renderSlots (it redraws every card every 5 s).
(function hook() {
    const orig = window.renderSlots;
    if (typeof orig !== 'function' || orig._dut) return;
    const w = function (slots) { orig.apply(this, arguments); lastSlots = slots; decorate(); };
    w._dut = true;
    if (orig._la) w._la = true;
    window.renderSlots = w;
})();
mount.addEventListener('dash-panel-visibility', e => { enabled = !!e.detail.visible; decorate(); });
setInterval(refresh, 5000);
fetch('/api/devices').then(r => r.json()).then(j => { if (!lastSlots && j.slots) lastSlots = j.slots; return refresh(); }).catch(() => {});
})();
