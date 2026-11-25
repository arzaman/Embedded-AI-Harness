// Interactive Serial Monitor panel for the testbench dashboard (portal :8080).
// Served by hil-instruments (:8081), loaded by pi/dashboard_panels.py.
// Streams raw bytes + slot status over ONE multiplexed SSE connection per tab
// from /panels/8081/api/serial/stream (backed by the portal's read-only
// monitor_port fan-out; never opens /dev/tty* or asserts DTR/RTS).
// Sends text/hex/control bytes via same-origin POST /api/serial/write.
// Styling reuses the portal classes (h2, .siggen-box); new classes use "ser-".
(function () {
'use strict';
const script = document.currentScript;
const API = script.src.replace(/\/panel\/serial\.js.*$/, '');
const mount = document.getElementById(script.dataset.mount || 'panel-serial');
if (!mount) return;

const MAX_LINES = 5000;
const MAX_RAW_BYTES = 262144;
const MAX_HISTORY = 100;
const MAX_PAUSED_CHUNKS = 500;
const LS_PREFS = 'dash.serial.v1';

const LINE_ENDINGS = {
    lf:   {label: 'LF (\\n)',     val: '\n'},
    crlf: {label: 'CRLF (\\r\\n)', val: '\r\n'},
    cr:   {label: 'CR (\\r)',     val: '\r'},
    none: {label: 'None',         val: ''},
};
const DEFAULT_CHIPS = ['info', 'status', 'counters'];

const prefs = Object.assign({
    viewMode: 'text',
    lineEnding: 'lf',
    sendMode: 'text',
    timestamp: true,
    autoScroll: true,
    wordWrap: true,
    localEcho: true,
    colors: true,
    split: false,
    quickCmds: DEFAULT_CHIPS.slice(),
    history: [],
    lastSlots: [],
}, (() => {
    try { return JSON.parse(localStorage.getItem(LS_PREFS)) || {}; } catch (e) { return {}; }
})());
if (!Array.isArray(prefs.quickCmds) || !prefs.quickCmds.length) prefs.quickCmds = DEFAULT_CHIPS.slice();
if (!Array.isArray(prefs.history)) prefs.history = [];
function savePrefs() {
    try { localStorage.setItem(LS_PREFS, JSON.stringify(prefs)); } catch (e) { /* */ }
}

const css = `
.ser-top { display: flex; justify-content: space-between; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 10px; }
.ser-tabs { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
.ser-tab { display: inline-flex; align-items: center; gap: 6px; background: #0f1a30; color: #9ab;
    border: 1px solid #0f3460; border-radius: 6px; padding: 5px 10px; font-size: 0.85em; cursor: pointer; }
.ser-tab.active { background: #0f3460; color: #00d4ff; border-color: #00d4ff; font-weight: bold; }
.ser-tab .dot { width: 8px; height: 8px; border-radius: 50%; background: #556; flex-shrink: 0; }
.ser-tab .dot.connected { background: #2ecc71; }
.ser-tab .dot.flashing, .ser-tab .dot.reconnecting, .ser-tab .dot.recovering { background: #e67e22; }
.ser-tab .dot.probing { background: #9b59b6; }
.ser-tab .dot.download_mode { background: #f1c40f; }
.ser-tab .dot.flapping { background: #e74c3c; }
.ser-tab .unread { background: #00d4ff; color: #0a0a1a; border-radius: 9px; padding: 0 5px; font-size: 0.78em; font-weight: bold; }
.ser-tab .x { color: #678; margin-left: 2px; font-weight: bold; padding: 0 3px; border-radius: 3px; }
.ser-tab .x:hover { color: #ff6b6b; background: rgba(255,107,107,0.15); }
.ser-top-acts { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.ser-btn { background: #0f3460; color: #cfe; border: 1px solid #2a4070; border-radius: 5px;
    padding: 5px 10px; font-size: 0.84em; font-weight: bold; cursor: pointer; white-space: nowrap; }
.ser-btn:hover { border-color: #00d4ff; color: #fff; }
.ser-btn:disabled { opacity: 0.45; cursor: default; }
.ser-btn.primary { background: #0078d4; border-color: #1a8fe3; color: #fff; }
.ser-btn.primary:hover { background: #1084df; }
.ser-btn.on { background: #00d4ff; color: #0a1426; border-color: #00d4ff; }
.ser-btn.warn { background: #c06010; color: #fff; border-color: #e67e22; }
.ser-btn.danger { background: #9c2530; color: #fff; border-color: #dc3545; }
.ser-grid { display: grid; grid-template-columns: 1fr; gap: 12px; }
.ser-grid.split { grid-template-columns: repeat(auto-fit, minmax(520px, 1fr)); }
.ser-pane { background: #0d1528; border: 1px solid #0f3460; border-radius: 10px; padding: 10px;
    display: flex; flex-direction: column; gap: 8px; min-width: 0; }
.ser-pane.focused { border-color: #1f5a96; }
.ser-row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; font-size: 0.84em; }
.ser-row label { color: #8ab; font-size: 0.92em; white-space: nowrap; }
.ser-row select, .ser-row input[type=text] { background: #0a0a1a; color: #e6eef8;
    border: 1px solid #2a4070; border-radius: 5px; padding: 4px 8px; font-size: 0.95em; font-family: inherit; }
.ser-row select:focus, .ser-row input[type=text]:focus { outline: none; border-color: #00d4ff; }
.ser-pill { display: inline-flex; align-items: center; gap: 5px; padding: 3px 9px; border-radius: 12px;
    font-size: 0.82em; font-weight: bold; background: #16213e; color: #9ab; border: 1px solid #2a4070; }
.ser-pill.connected { background: rgba(46,204,113,0.16); color: #2ecc71; border-color: #2ecc71; }
.ser-pill.flashing, .ser-pill.reconnecting, .ser-pill.recovering {
    background: rgba(230,126,34,0.18); color: #f39c12; border-color: #e67e22; animation: ser-pulse 1.5s infinite; }
.ser-pill.probing { background: rgba(155,89,182,0.2); color: #c39bd3; border-color: #9b59b6; animation: ser-pulse 1.5s infinite; }
.ser-pill.download_mode { background: rgba(241,196,15,0.18); color: #f1c40f; border-color: #f1c40f; }
.ser-pill.flapping { background: rgba(231,76,60,0.2); color: #ff6b6b; border-color: #e74c3c; }
.ser-pill.gpio-no { background: rgba(230,126,34,0.18); color: #f5b041; border-color: #e67e22; }
.ser-pill.gpio-ok { background: rgba(46,204,113,0.12); color: #7dcea0; border-color: #236b43; }
.ser-pill.baud { font-family: monospace; color: #789; border-color: #1c2d50; }
@keyframes ser-pulse { 50% { opacity: 0.55; } }
.ser-alert { display: flex; justify-content: space-between; align-items: center; gap: 8px;
    padding: 6px 10px; border-radius: 6px; font-size: 0.83em; font-weight: bold; }
.ser-alert.amber { background: rgba(241,196,15,0.15); color: #f7dc6f; border: 1px solid #d4ac0d; }
.ser-alert.red { background: rgba(231,76,60,0.18); color: #ff8585; border: 1px solid #e74c3c; }
.ser-alert button { background: transparent; border: none; color: inherit; cursor: pointer; font-weight: bold; padding: 0 4px; }
.ser-sep { width: 1px; height: 20px; background: #1e355e; }
.ser-filter-wrap { display: inline-flex; align-items: center; gap: 5px; flex: 1; min-width: 180px; }
.ser-filter-wrap input { flex: 1; min-width: 110px; font-family: monospace; }
.ser-fchip { background: #101b33; color: #8ab; border: 1px solid #223860; border-radius: 12px;
    padding: 2px 8px; font-size: 0.8em; cursor: pointer; }
.ser-fchip.on { background: #0f3460; color: #00d4ff; border-color: #00d4ff; font-weight: bold; }
.ser-term-wrap { position: relative; }
.ser-term { background: #070912; border: 1px solid #16264a; border-radius: 6px; padding: 8px 10px;
    height: 380px; min-height: 200px; max-height: 75vh; resize: vertical; overflow: auto;
    font-family: 'Consolas', 'Cascadia Mono', 'DejaVu Sans Mono', monospace; font-size: 12.5px; line-height: 1.42; color: #d8e2f0; }
.ser-term.nowrap .ser-ln { white-space: pre; }
.ser-term.wrap .ser-ln { white-space: pre-wrap; word-break: break-word; }
.ser-ln { min-height: 1.42em; }
.ser-ln .ts { color: #54647a; margin-right: 8px; user-select: none; }
.ser-ln .dir-tx { color: #00d4ff; font-weight: bold; margin-right: 5px; }
.ser-ln.tx { color: #7ce8ff; }
.ser-ln.sys { color: #6e88aa; font-style: italic; border-top: 1px dashed #182a4c; margin-top: 3px; padding-top: 2px; }
.ser-ln.lvl-e { color: #ff6b6b; }
.ser-ln.lvl-w { color: #f5b041; }
.ser-ln.lvl-i { color: #58d68d; }
.ser-ln.lvl-d { color: #7f8c9f; }
.ser-ln.ok { color: #2ecc71; }
.ser-ln.evt { color: #5dade2; }
.ser-ln.crit-dl { background: rgba(241,196,15,0.16); color: #f9e79f; border-left: 3px solid #f1c40f; padding-left: 6px; font-weight: bold; }
.ser-ln.crit-br { background: rgba(231,76,60,0.22); color: #ffb3b3; border-left: 3px solid #e74c3c; padding-left: 6px; font-weight: bold; }
.ser-hex { white-space: pre; color: #b8c9e0; }
.ser-hex .off { color: #54647a; }
.ser-hex .hx { color: #90d5ff; }
.ser-hex .hx-tx { color: #f5b041; }
.ser-hex .asc { color: #7dcea0; }
.ser-jump { position: absolute; right: 18px; bottom: 12px; background: #0078d4; color: #fff;
    border: 1px solid #3ca2f0; border-radius: 14px; padding: 4px 12px; font-size: 0.78em; font-weight: bold;
    cursor: pointer; display: none; box-shadow: 0 2px 10px rgba(0,0,0,0.5); }
.ser-jump.show { display: inline-block; }
.ser-send-row { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
.ser-send-in { flex: 1; min-width: 220px; background: #0a0a1a; color: #eef5ff;
    border: 1px solid #2a4070; border-radius: 5px; padding: 7px 10px;
    font-family: 'Consolas', 'DejaVu Sans Mono', monospace; font-size: 0.9em; }
.ser-send-in:focus { outline: none; border-color: #00d4ff; }
.ser-send-in:disabled { opacity: 0.5; }
.ser-chips { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; font-size: 0.8em; }
.ser-chip { display: inline-flex; align-items: center; gap: 4px; background: #10203e; color: #bfe0ff;
    border: 1px solid #224070; border-radius: 12px; padding: 2px 9px; font-family: monospace; cursor: pointer; }
.ser-chip:hover { border-color: #00d4ff; color: #fff; }
.ser-chip .rm { color: #678; margin-left: 2px; font-family: sans-serif; }
.ser-chip .rm:hover { color: #ff6b6b; }
.ser-foot { display: flex; justify-content: space-between; gap: 8px; flex-wrap: wrap; color: #6c7f99; font-size: 0.78em; }
.ser-foot .err { color: #ff6b6b; }
.slot .ser-card-btn { margin-top: 8px; width: 100%; font-family: inherit; background: #0f3460; color: #00d4ff;
    border: 1px solid #2a5588; border-radius: 6px; padding: 6px 10px; font-weight: bold; cursor: pointer; }
.slot .ser-card-btn:hover { background: #164680; border-color: #00d4ff; color: #fff; }
`;
const style = document.createElement('style');
style.textContent = css;
document.head.appendChild(style);

mount.innerHTML = `
<h2>Serial Monitor <span style="color:#8ab;font-size:0.6em">live read-only fan-out &amp; interactive console</span></h2>
<div class="siggen-box">
  <div class="ser-top">
    <div class="ser-tabs" id="ser-tabs"></div>
    <div class="ser-top-acts">
      <button type="button" class="ser-btn primary" id="ser-add">+ Open an additional monitor</button>
      <button type="button" class="ser-btn" id="ser-split" title="Show all open monitors side by side">Split view</button>
    </div>
  </div>
  <div class="ser-grid" id="ser-grid"></div>
</div>`;

const $ = id => document.getElementById(id);
const esc = s => String(s === null || s === undefined ? '' : s)
    .replace(/[&<>"]/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[c]));
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

function fmtTs(ms) {
    const d = new Date(ms);
    const p2 = n => String(n).padStart(2, '0');
    const p3 = n => String(n).padStart(3, '0');
    return `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}.${p3(d.getMilliseconds())}`;
}

function b64ToBytes(b64) {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
}

function classifyLine(text, dir) {
    if (dir === 'tx') return 'tx';
    if (dir === 'sys') return 'sys';
    const clean = text.replace(ANSI_RE, '');
    if (/waiting for download/i.test(clean)) return 'crit-dl';
    if (/brownout detector|guru meditation|backtrace:|abort\(\)|tg[01]wdt|rtcwdt/i.test(clean)) return 'crit-br';
    if (/^E\s*\(\d+\)/.test(clean) || /^ERR(\b|:)/.test(clean)) return 'lvl-e';
    if (/^W\s*\(\d+\)/.test(clean)) return 'lvl-w';
    if (/^I\s*\(\d+\)/.test(clean)) return 'lvl-i';
    if (/^D\s*\(\d+\)/.test(clean) || /^V\s*\(\d+\)/.test(clean)) return 'lvl-d';
    if (/^OK(\b|:)/.test(clean)) return 'ok';
    if (/^EVT(\b|:)/.test(clean)) return 'evt';
    return '';
}

function statusBadgeText(st) {
    if (!st) return 'Connecting…';
    switch (st.conn) {
        case 'connected': return 'Connected';
        case 'probing': return 'Probing DUT…';
        case 'flashing': return st.state === 'flashing' ? 'Flashing…' : 'Flashing / Resetting…';
        case 'download_mode': return 'Download Mode';
        case 'recovering': return 'Recovering…';
        case 'flapping': return 'Boot-looping';
        case 'reconnecting': return 'Reconnecting…';
        case 'absent': return 'Offline';
        default: return st.conn || 'Idle';
    }
}

function slotOptionLabel(s) {
    const bits = [s.label];
    if (s.devnode) bits.push(s.devnode.replace(/^\/dev\//, ''));
    const chip = s.detected_chip || (s.usb_devices && s.usb_devices[0] && s.usb_devices[0].product);
    if (chip) bits.push(chip);
    bits.push(s.running ? 'online' : (s.present ? (s.state || 'present') : 'empty'));
    return bits.join(' · ');
}

let allSlots = [];
let visible = true;
let panes = [];
let activePaneId = null;
let nextPaneId = 1;
let sse = null;
let sseKey = '';
let sseRetryTimer = null;

function createPane(slotLabel) {
    const id = nextPaneId++;
    const p = {
        id,
        slot: slotLabel || '',
        status: null,
        lastConn: null,
        paused: false,
        pendingChunks: [],
        viewMode: prefs.viewMode,
        lineEnding: prefs.lineEnding,
        sendMode: prefs.sendMode,
        timestamp: prefs.timestamp,
        autoScroll: prefs.autoScroll,
        scrollLocked: true,
        wordWrap: prefs.wordWrap,
        localEcho: prefs.localEcho,
        colors: prefs.colors,
        filterText: '',
        filterQuick: 'all',
        lines: [],
        partial: null,
        rawChunks: [],
        rawTotalBytes: 0,
        decoder: new TextDecoder('utf-8', {fatal: false}),
        rxBytes: 0,
        unread: 0,
        backlogLoaded: false,
        alert: null,
        sending: false,
        sendQueue: [],
        histIdx: -1,
        histDraft: '',
        dirtyFull: true,
        dirtyAppendFrom: 0,
        rafId: 0,
        progScroll: false,
        el: null,
    };
    panes.push(p);
    if (activePaneId === null) activePaneId = id;
    buildPaneDom(p);
    renderTabs();
    applyLayout();
    syncSse();
    persistOpenSlots();
    return p;
}

function persistOpenSlots() {
    prefs.lastSlots = panes.map(p => p.slot).filter(Boolean);
    savePrefs();
}

function closePane(id) {
    const idx = panes.findIndex(p => p.id === id);
    if (idx < 0) return;
    const p = panes[idx];
    if (p.rafId) cancelAnimationFrame(p.rafId);
    if (p.el) p.el.remove();
    panes.splice(idx, 1);
    if (!panes.length) {
        activePaneId = null;
        createPane(pickDefaultSlot());
        return;
    }
    if (activePaneId === id) activePaneId = panes[Math.max(0, idx - 1)].id;
    renderTabs();
    applyLayout();
    syncSse();
    persistOpenSlots();
}

function pickDefaultSlot(exclude) {
    const ex = new Set(exclude || []);
    const running = allSlots.find(s => s.present && s.running && !ex.has(s.label));
    if (running) return running.label;
    const present = allSlots.find(s => s.present && !ex.has(s.label));
    if (present) return present.label;
    const any = allSlots.find(s => !ex.has(s.label));
    return any ? any.label : (allSlots[0] ? allSlots[0].label : '');
}

function openOrFocusSlot(slotLabel) {
    if (!slotLabel) return;
    // Ensure panel is visible if hidden in the dashboard bar
    if (mount.style.display === 'none') {
        const chips = document.querySelectorAll('.dash-bar .dash-chip');
        for (const c of chips) {
            if (c.textContent.trim().toLowerCase().includes('serial')) { c.click(); break; }
        }
    }
    let p = panes.find(x => x.slot === slotLabel);
    if (!p) {
        if (panes.length === 1 && !panes[0].slot) {
            setPaneSlot(panes[0], slotLabel);
            p = panes[0];
        } else {
            p = createPane(slotLabel);
        }
    }
    activePaneId = p.id;
    p.unread = 0;
    renderTabs();
    applyLayout();
    mount.scrollIntoView({behavior: 'smooth', block: 'start'});
    if (p.el) {
        const inp = p.el.querySelector('.ser-send-in');
        if (inp && !inp.disabled) inp.focus();
    }
}

function setPaneSlot(p, newSlot) {
    if (p.slot === newSlot) return;
    p.slot = newSlot;
    p.status = null;
    p.lastConn = null;
    p.backlogLoaded = false;
    p.alert = null;
    p.decoder = new TextDecoder('utf-8', {fatal: false});
    clearPaneBuffer(p);
    updatePaneHeader(p);
    renderTabs();
    syncSse();
    persistOpenSlots();
}

function clearPaneBuffer(p) {
    p.lines = [];
    p.partial = null;
    p.rawChunks = [];
    p.rawTotalBytes = 0;
    p.pendingChunks = [];
    p.rxBytes = 0;
    p.alert = null;
    p.dirtyFull = true;
    p.dirtyAppendFrom = 0;
    updateAlertDom(p);
    updatePauseBtn(p);
    scheduleRender(p);
}

function addSystemLine(p, msg, ts) {
    p.lines.push({ts: ts || Date.now(), text: '── ' + msg + ' ──', dir: 'sys', cls: 'sys'});
    trimLines(p);
    scheduleRender(p);
}

function trimLines(p) {
    if (p.lines.length > MAX_LINES) {
        p.lines.splice(0, p.lines.length - MAX_LINES);
        p.dirtyFull = true;
    }
}

function checkCritical(p, text) {
    const clean = text.replace(ANSI_RE, '');
    if (/waiting for download/i.test(clean)) {
        const manual = p.status && p.status.has_gpio && p.status.gpio_wired === false;
        p.alert = {
            kind: 'amber',
            msg: 'ROM Download Mode detected ("waiting for download")' +
                 (manual ? ' — BOOT/EN not wired: release BOOT jumper and press RESET.' :
                           ' — board is waiting for esptool or a watchdog reset.'),
        };
        updateAlertDom(p);
    } else if (/brownout detector/i.test(clean)) {
        p.alert = {
            kind: 'red',
            msg: 'Brownout detector triggered — check power supply / USB cable on ' + (p.slot || 'slot') + '.',
        };
        updateAlertDom(p);
    }
}

function ingestBytes(p, bytes, ts, dir) {
    if (!bytes || !bytes.length) return;
    if (dir === 'rx') p.rxBytes += bytes.length;
    p.rawChunks.push({ts, dir, bytes});
    p.rawTotalBytes += bytes.length;
    while (p.rawTotalBytes > MAX_RAW_BYTES && p.rawChunks.length > 1) {
        p.rawTotalBytes -= p.rawChunks.shift().bytes.length;
        if (p.viewMode === 'hex') p.dirtyFull = true;
    }

    if (dir === 'tx') {
        const txt = new TextDecoder('utf-8', {fatal: false}).decode(bytes).replace(/\r\n/g, '\\r\\n').replace(/\n/g, '\\n').replace(/\r/g, '\\r');
        p.lines.push({ts, text: txt, dir: 'tx', cls: 'tx'});
        trimLines(p);
        scheduleRender(p);
        return;
    }

    const decoded = p.decoder.decode(bytes, {stream: true});
    if (!decoded) return;
    const parts = decoded.split('\n');
    for (let i = 0; i < parts.length; i++) {
        let seg = parts[i];
        const isLast = (i === parts.length - 1);
        // Handle carriage return overwrite / CRLF stripping
        if (seg.endsWith('\r')) seg = seg.slice(0, -1);
        if (seg.includes('\r')) {
            const crParts = seg.split('\r');
            seg = crParts[crParts.length - 1];
        }
        if (p.partial) {
            p.partial.text += seg;
            p.partial.cls = classifyLine(p.partial.text, 'rx');
            p.dirtyFull = true;
            if (!isLast) {
                checkCritical(p, p.partial.text);
                p.partial = null;
            }
        } else if (!isLast) {
            const entry = {ts, text: seg, dir: 'rx', cls: classifyLine(seg, 'rx')};
            p.lines.push(entry);
            checkCritical(p, seg);
        } else if (seg.length > 0) {
            const entry = {ts, text: seg, dir: 'rx', cls: classifyLine(seg, 'rx')};
            p.lines.push(entry);
            p.partial = entry;
            checkCritical(p, seg);
        }
    }
    trimLines(p);
    if (!prefs.split && activePaneId !== p.id) {
        p.unread = Math.min(999, p.unread + Math.max(1, parts.length - 1));
        renderTabs();
    }
    scheduleRender(p);
}

function ingestBacklog(p, lines) {
    if (p.backlogLoaded || p.lines.length > 0) return;
    p.backlogLoaded = true;
    if (!lines || !lines.length) return;
    for (const ln of lines) {
        const ts = ln.ts ? Math.round(ln.ts * 1000) : Date.now();
        const text = String(ln.text || '');
        p.lines.push({ts, text, dir: 'rx', cls: classifyLine(text, 'rx')});
        checkCritical(p, text);
    }
    trimLines(p);
    p.dirtyFull = true;
    scheduleRender(p);
}

function handleSlotStatus(p, st) {
    const prev = p.lastConn;
    p.status = st;
    p.lastConn = st.conn;
    if (prev && prev !== st.conn) {
        if (st.conn === 'connected') {
            addSystemLine(p, 'Connected' + (st.devnode ? ' (' + st.devnode + ')' : ''));
        } else {
            addSystemLine(p, statusBadgeText(st));
        }
    }
    updatePaneHeader(p);
    renderTabs();
}

// ── Single multiplexed SSE stream ─────────────────────────────────────────
function wantedSlotsKey() {
    if (!visible) return '';
    const uniq = Array.from(new Set(panes.map(p => p.slot).filter(Boolean))).sort();
    return uniq.join(',');
}

function closeSse() {
    clearTimeout(sseRetryTimer);
    sseRetryTimer = null;
    if (sse) {
        try { sse.close(); } catch (e) { /* */ }
        sse = null;
    }
    sseKey = '';
}

function syncSse() {
    const key = wantedSlotsKey();
    if (key === sseKey) return;
    closeSse();
    if (!key) return;
    sseKey = key;
    const url = `${API}/api/serial/stream?slots=${encodeURIComponent(key)}&backlog=200`;
    const es = new EventSource(url);
    sse = es;

    es.addEventListener('status', ev => {
        try {
            const st = JSON.parse(ev.data);
            for (const p of panes) {
                if (p.slot === st.slot) handleSlotStatus(p, st);
            }
        } catch (e) { /* */ }
    });

    es.addEventListener('backlog', ev => {
        try {
            const msg = JSON.parse(ev.data);
            for (const p of panes) {
                if (p.slot === msg.slot) ingestBacklog(p, msg.lines);
            }
        } catch (e) { /* */ }
    });

    es.addEventListener('data', ev => {
        try {
            const msg = JSON.parse(ev.data);
            const bytes = b64ToBytes(msg.b64);
            const ts = msg.ts || Date.now();
            for (const p of panes) {
                if (p.slot !== msg.slot) continue;
                if (p.paused) {
                    if (p.pendingChunks.length >= MAX_PAUSED_CHUNKS) p.pendingChunks.shift();
                    p.pendingChunks.push({bytes, ts});
                    updatePauseBtn(p);
                } else {
                    ingestBytes(p, bytes, ts, 'rx');
                }
            }
        } catch (e) { /* */ }
    });

    es.onerror = () => {
        for (const p of panes) {
            if (p.slot && p.status && p.status.conn === 'connected') {
                p.status = Object.assign({}, p.status, {conn: 'reconnecting'});
                updatePaneHeader(p);
            }
        }
        renderTabs();
        if (es.readyState === EventSource.CLOSED && sse === es) {
            sseKey = '';
            sseRetryTimer = setTimeout(syncSse, 2500);
        }
    };
}

// ── Sending commands via same-origin POST /api/serial/write ───────────────
function parseHexInput(str) {
    const clean = str.replace(/0x/gi, '').replace(/[\s,:-]+/g, '');
    if (!clean) return {ok: false, error: 'enter hex bytes, e.g. 01 02 FF'};
    if (!/^[0-9a-fA-F]+$/.test(clean) || clean.length % 2 !== 0) {
        return {ok: false, error: 'invalid hex (must be pairs of 0-9 A-F)'};
    }
    return {ok: true, hex: clean.toLowerCase()};
}

function enqueueWrite(p, payload, echoBytes, echoLabel) {
    if (!p.slot) return;
    p.sendQueue.push({payload, echoBytes, echoLabel});
    drainWriteQueue(p);
}

async function drainWriteQueue(p) {
    if (p.sending || !p.sendQueue.length) return;
    p.sending = true;
    updateSendControls(p);
    const {payload, echoBytes, echoLabel} = p.sendQueue.shift();
    setPaneError(p, '');
    try {
        const r = await fetch('/api/serial/write', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify(payload),
        });
        const j = await r.json();
        if (!j.ok) throw new Error(j.error || ('HTTP ' + r.status));
        if (p.localEcho && echoBytes && echoBytes.length) {
            if (echoLabel) {
                p.rawChunks.push({ts: Date.now(), dir: 'tx', bytes: echoBytes});
                p.rawTotalBytes += echoBytes.length;
                p.lines.push({ts: Date.now(), text: '[' + echoLabel + ']', dir: 'tx', cls: 'tx'});
                trimLines(p);
                scheduleRender(p);
            } else {
                ingestBytes(p, echoBytes, Date.now(), 'tx');
            }
        }
    } catch (e) {
        setPaneError(p, 'Send failed: ' + (e.message || e));
    } finally {
        p.sending = false;
        updateSendControls(p);
        if (p.sendQueue.length) drainWriteQueue(p);
    }
}

function sendFromInput(p, explicitText) {
    const inp = p.el && p.el.querySelector('.ser-send-in');
    const raw = explicitText !== undefined ? explicitText : (inp ? inp.value : '');
    if (explicitText === undefined && raw) {
        if (prefs.history[prefs.history.length - 1] !== raw) {
            prefs.history.push(raw);
            if (prefs.history.length > MAX_HISTORY) prefs.history.shift();
            savePrefs();
        }
        p.histIdx = -1;
        p.histDraft = '';
    }
    if (p.sendMode === 'hex' && explicitText === undefined) {
        const parsed = parseHexInput(raw);
        if (!parsed.ok) { setPaneError(p, parsed.error); return; }
        const bytes = new Uint8Array(parsed.hex.length / 2);
        for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(parsed.hex.substr(i * 2, 2), 16);
        if (inp) inp.value = '';
        enqueueWrite(p, {slot: p.slot, hex: parsed.hex}, bytes);
        return;
    }
    const ending = (LINE_ENDINGS[p.lineEnding] || LINE_ENDINGS.lf).val;
    const text = raw + ending;
    if (!text) return;
    if (explicitText === undefined && inp) inp.value = '';
    const bytes = new TextEncoder().encode(text);
    enqueueWrite(p, {slot: p.slot, text, newline: false}, bytes);
}

function sendControlByte(p, hexByte, label) {
    const b = new Uint8Array([parseInt(hexByte, 16)]);
    enqueueWrite(p, {slot: p.slot, hex: hexByte}, b, label);
}

// ── Filtering & Rendering ─────────────────────────────────────────────────
function buildFilterMatcher(p) {
    const q = (p.filterText || '').trim();
    let re = null, needle = '';
    if (q) {
        const m = q.match(/^\/(.+)\/([gimsuy]*)$/);
        if (m) {
            try { re = new RegExp(m[1], m[2] || 'i'); } catch (e) { needle = q.toLowerCase(); }
        } else {
            needle = q.toLowerCase();
        }
    }
    return line => {
        if (line.dir === 'tx' && !p.localEcho) return false;
        if (p.filterQuick === 'err' && !['lvl-e', 'crit-br', 'crit-dl'].includes(line.cls)) return false;
        if (p.filterQuick === 'warn' && !['lvl-w', 'lvl-e', 'crit-br', 'crit-dl'].includes(line.cls)) return false;
        if (p.filterQuick === 'ok' && !['ok', 'evt', 'lvl-e'].includes(line.cls)) return false;
        if (!q) return true;
        const clean = line.text.replace(ANSI_RE, '');
        return re ? re.test(clean) : clean.toLowerCase().includes(needle);
    };
}

function makeLineNode(p, ln) {
    const div = document.createElement('div');
    const cls = p.colors && ln.cls ? ' ' + ln.cls : (ln.dir === 'tx' ? ' tx' : (ln.dir === 'sys' ? ' sys' : ''));
    div.className = 'ser-ln' + cls;
    if (p.timestamp && ln.dir !== 'sys') {
        const s = document.createElement('span');
        s.className = 'ts';
        s.textContent = '[' + fmtTs(ln.ts) + ']';
        div.appendChild(s);
    }
    if (ln.dir === 'tx') {
        const s = document.createElement('span');
        s.className = 'dir-tx';
        s.textContent = 'TX ›';
        div.appendChild(s);
    }
    div.appendChild(document.createTextNode(ln.text.replace(ANSI_RE, '')));
    return div;
}

function renderHexView(p, term) {
    const frag = document.createDocumentFragment();
    let offset = 0;
    const total = p.rawChunks.reduce((a, c) => a + c.bytes.length, 0);
    // Concatenate recent chunks (up to 64 KB displayed for crisp browser performance)
    const displayCap = 65536;
    let skip = Math.max(0, total - displayCap);
    for (const ch of p.rawChunks) {
        if (skip >= ch.bytes.length) {
            skip -= ch.bytes.length;
            offset += ch.bytes.length;
            continue;
        }
        const slice = skip > 0 ? ch.bytes.subarray(skip) : ch.bytes;
        offset += skip;
        skip = 0;
        for (let i = 0; i < slice.length; i += 16) {
            const row = slice.subarray(i, i + 16);
            const offStr = (offset + i).toString(16).padStart(8, '0');
            let hexA = '', hexB = '', asc = '';
            for (let j = 0; j < 16; j++) {
                if (j < row.length) {
                    const b = row[j];
                    const h = b.toString(16).padStart(2, '0');
                    if (j < 8) hexA += h + ' '; else hexB += h + ' ';
                    asc += (b >= 32 && b <= 126) ? String.fromCharCode(b) : '.';
                } else {
                    if (j < 8) hexA += '   '; else hexB += '   ';
                    asc += ' ';
                }
            }
            const div = document.createElement('div');
            div.className = 'ser-ln ser-hex';
            div.innerHTML =
                (p.timestamp ? `<span class="ts">[${fmtTs(ch.ts)}]</span>` : '') +
                `<span class="off">${offStr}</span>  ` +
                `<span class="${ch.dir === 'tx' ? 'hx-tx' : 'hx'}">${hexA} ${hexB}</span> ` +
                `<span class="asc">|${esc(asc)}|</span>`;
            frag.appendChild(div);
        }
        offset += slice.length;
    }
    term.textContent = '';
    term.appendChild(frag);
}

function scheduleRender(p) {
    if (p.rafId) return;
    p.rafId = requestAnimationFrame(() => {
        p.rafId = 0;
        renderPaneOutput(p);
    });
}

function renderPaneOutput(p) {
    if (!p.el) return;
    const term = p.el.querySelector('.ser-term');
    if (!term) return;
    term.className = 'ser-term ' + (p.wordWrap ? 'wrap' : 'nowrap');

    const match = buildFilterMatcher(p);
    const hasFilter = !!(p.filterText.trim() || p.filterQuick !== 'all');

    if (p.viewMode === 'hex') {
        renderHexView(p, term);
        p.dirtyFull = false;
        p.dirtyAppendFrom = p.lines.length;
    } else if (p.dirtyFull || hasFilter) {
        const frag = document.createDocumentFragment();
        let shown = 0;
        for (const ln of p.lines) {
            if (!match(ln)) continue;
            frag.appendChild(makeLineNode(p, ln));
            shown++;
        }
        term.textContent = '';
        term.appendChild(frag);
        p.dirtyFull = false;
        p.dirtyAppendFrom = p.lines.length;
        const cnt = p.el.querySelector('.ser-fcount');
        if (cnt) cnt.textContent = hasFilter ? `${shown}/${p.lines.length}` : `${p.lines.length} lines`;
    } else {
        const frag = document.createDocumentFragment();
        for (let i = p.dirtyAppendFrom; i < p.lines.length; i++) {
            const ln = p.lines[i];
            if (match(ln)) frag.appendChild(makeLineNode(p, ln));
        }
        term.appendChild(frag);
        while (term.childElementCount > MAX_LINES) term.firstElementChild.remove();
        p.dirtyAppendFrom = p.lines.length;
        const cnt = p.el.querySelector('.ser-fcount');
        if (cnt) cnt.textContent = `${p.lines.length} lines`;
    }

    const stat = p.el.querySelector('.ser-stat');
    if (stat) stat.textContent = `${p.lines.length}/${MAX_LINES} lines · ${(p.rxBytes / 1024).toFixed(1)} KB rx`;

    if (p.autoScroll && p.scrollLocked) {
        p.progScroll = true;
        term.scrollTop = term.scrollHeight;
        requestAnimationFrame(() => { p.progScroll = false; });
    }
}

function downloadLog(p) {
    const match = buildFilterMatcher(p);
    const rows = p.lines.filter(match).map(ln => {
        const ts = p.timestamp ? `[${fmtTs(ln.ts)}] ` : '';
        const dir = ln.dir === 'tx' ? 'TX> ' : '';
        return ts + dir + ln.text.replace(ANSI_RE, '');
    });
    const blob = new Blob([rows.join('\n') + '\n'], {type: 'text/plain;charset=utf-8'});
    const a = document.createElement('a');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    a.href = URL.createObjectURL(blob);
    a.download = `${p.slot || 'serial'}_${stamp}.txt`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

// ── DOM construction & updates ────────────────────────────────────────────
function renderTabs() {
    const bar = $('ser-tabs');
    bar.innerHTML = '';
    for (const p of panes) {
        const t = document.createElement('div');
        t.className = 'ser-tab' + (p.id === activePaneId ? ' active' : '');
        const conn = p.status ? p.status.conn : 'absent';
        t.innerHTML = `<span class="dot ${esc(conn)}"></span><span>${esc(p.slot || 'Select slot')}</span>` +
            (p.unread > 0 ? `<span class="unread">${p.unread}</span>` : '') +
            (panes.length > 1 ? `<span class="x" title="Close monitor">×</span>` : '');
        t.onclick = ev => {
            if (ev.target.classList.contains('x')) { closePane(p.id); return; }
            activePaneId = p.id;
            p.unread = 0;
            renderTabs();
            applyLayout();
        };
        bar.appendChild(t);
    }
    const splitBtn = $('ser-split');
    splitBtn.className = 'ser-btn' + (prefs.split ? ' on' : '');
    splitBtn.disabled = panes.length < 2;
}

function applyLayout() {
    const grid = $('ser-grid');
    grid.className = 'ser-grid' + (prefs.split && panes.length > 1 ? ' split' : '');
    for (const p of panes) {
        if (!p.el) continue;
        const show = prefs.split || p.id === activePaneId;
        p.el.style.display = show ? '' : 'none';
        p.el.classList.toggle('focused', p.id === activePaneId);
    }
}

function updateSlotSelect(p) {
    if (!p.el) return;
    const sel = p.el.querySelector('.ser-slot-sel');
    if (!sel) return;
    const opts = allSlots.length
        ? allSlots.map(s => `<option value="${esc(s.label)}"${s.label === p.slot ? ' selected' : ''}>${esc(slotOptionLabel(s))}</option>`).join('')
        : '<option value="">No slots detected</option>';
    sel.innerHTML = opts;
    if (p.slot && !allSlots.some(s => s.label === p.slot)) {
        sel.insertAdjacentHTML('afterbegin', `<option value="${esc(p.slot)}" selected>${esc(p.slot)}</option>`);
    }
}

function updatePaneHeader(p) {
    if (!p.el) return;
    const badge = p.el.querySelector('.ser-conn-pill');
    const st = p.status;
    if (badge) {
        const cls = st ? st.conn : 'reconnecting';
        badge.className = 'ser-pill ser-conn-pill ' + cls;
        badge.textContent = statusBadgeText(st);
        badge.title = st && st.devnode ? `${st.devnode} · monitor :${st.monitor_port || '-'}` : '';
    }
    const gpio = p.el.querySelector('.ser-gpio-pill');
    if (gpio) {
        if (st && st.has_gpio && st.gpio_wired === false) {
            gpio.style.display = '';
            gpio.className = 'ser-pill ser-gpio-pill gpio-no';
            gpio.textContent = '⚠ BOOT/EN: manual';
            gpio.title = (st.gpio_wired_detail || 'BOOT/EN pins are not wired to this slot') +
                ' — use manual BOOT jumper + RESET button for download mode.';
        } else if (st && st.has_gpio && st.gpio_wired === true) {
            gpio.style.display = '';
            gpio.className = 'ser-pill ser-gpio-pill gpio-ok';
            gpio.textContent = '✓ BOOT/EN wired';
            gpio.title = st.gpio_wired_detail || 'Auto-reset / download mode GPIO verified';
        } else {
            gpio.style.display = 'none';
        }
    }
    updateSendControls(p);
}

function updateSendControls(p) {
    if (!p.el) return;
    const canSend = !!(p.slot && p.status && p.status.conn === 'connected' && !p.sending);
    const inp = p.el.querySelector('.ser-send-in');
    const sendBtn = p.el.querySelector('.ser-send-go');
    const ctrlBtns = p.el.querySelectorAll('.ser-ctrl-btn');
    if (inp) {
        inp.disabled = !p.slot || !(p.status && p.status.conn === 'connected');
        inp.placeholder = p.sendMode === 'hex'
            ? 'Hex bytes to send (e.g. 01 02 FF)...'
            : (canSend ? 'Type a message to send to ' + p.slot + ' (↑/↓ history, Enter to send)...'
                       : (p.slot ? statusBadgeText(p.status) + ' — input disabled' : 'Select a slot'));
    }
    if (sendBtn) {
        sendBtn.disabled = !canSend;
        sendBtn.textContent = p.sending ? 'Sending…' : 'Send';
    }
    ctrlBtns.forEach(b => { b.disabled = !canSend; });
}

function updateAlertDom(p) {
    if (!p.el) return;
    const box = p.el.querySelector('.ser-alert-slot');
    if (!box) return;
    if (!p.alert) { box.innerHTML = ''; return; }
    box.innerHTML = `<div class="ser-alert ${esc(p.alert.kind)}"><span>⚠ ${esc(p.alert.msg)}</span>` +
        `<button type="button" title="Dismiss">×</button></div>`;
    box.querySelector('button').onclick = () => { p.alert = null; updateAlertDom(p); };
}

function updatePauseBtn(p) {
    if (!p.el) return;
    const b = p.el.querySelector('.ser-pause-btn');
    if (!b) return;
    if (p.paused) {
        b.className = 'ser-btn warn ser-pause-btn';
        b.textContent = '▶ Resume' + (p.pendingChunks.length ? ` (+${p.pendingChunks.length})` : '');
    } else {
        b.className = 'ser-btn ser-pause-btn';
        b.textContent = '⏸ Pause';
    }
}

function setPaneError(p, msg) {
    if (!p.el) return;
    const el = p.el.querySelector('.ser-err');
    if (el) { el.textContent = msg || ''; el.className = msg ? 'ser-err err' : 'ser-err'; }
}

function renderQuickChips(p) {
    if (!p.el) return;
    const wrap = p.el.querySelector('.ser-chips');
    if (!wrap) return;
    wrap.innerHTML = '<span style="color:#6c7f99">Quick:</span>';
    for (const cmd of prefs.quickCmds) {
        const chip = document.createElement('span');
        chip.className = 'ser-chip';
        chip.title = 'Click to send "' + cmd + '"';
        chip.innerHTML = `<span>${esc(cmd)}</span><span class="rm" title="Remove">×</span>`;
        chip.onclick = ev => {
            if (ev.target.classList.contains('rm')) {
                prefs.quickCmds = prefs.quickCmds.filter(x => x !== cmd);
                savePrefs();
                panes.forEach(renderQuickChips);
                return;
            }
            if (p.status && p.status.conn === 'connected') sendFromInput(p, cmd);
        };
        wrap.appendChild(chip);
    }
    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'ser-fchip';
    add.textContent = '+ cmd';
    add.title = 'Add a quick command chip';
    add.onclick = () => {
        const v = prompt('Add quick command chip:');
        if (v && v.trim() && !prefs.quickCmds.includes(v.trim())) {
            prefs.quickCmds.push(v.trim());
            savePrefs();
            panes.forEach(renderQuickChips);
        }
    };
    wrap.appendChild(add);
}

function buildPaneDom(p) {
    const div = document.createElement('div');
    div.className = 'ser-pane';
    div.innerHTML = `
      <div class="ser-row">
        <label>Slot</label>
        <select class="ser-slot-sel"></select>
        <button type="button" class="ser-btn ser-refresh" title="Refresh slot list">↻</button>
        <label>View</label>
        <select class="ser-view-sel">
          <option value="text">Text</option>
          <option value="hex">Hex</option>
        </select>
        <label>Line ending</label>
        <select class="ser-eol-sel">
          ${Object.entries(LINE_ENDINGS).map(([k, v]) => `<option value="${k}">${v.label}</option>`).join('')}
        </select>
        <span class="ser-pill baud" title="Managed by bench serial proxy">115200 8N1</span>
        <span class="ser-pill ser-conn-pill reconnecting">Connecting…</span>
        <span class="ser-pill ser-gpio-pill" style="display:none"></span>
      </div>
      <div class="ser-row">
        <button type="button" class="ser-btn ser-pause-btn" title="Pause client display without stopping the bench proxy">⏸ Pause</button>
        <button type="button" class="ser-btn ser-clear-btn" title="Clear terminal buffer">Clear</button>
        <span class="ser-sep"></span>
        <button type="button" class="ser-btn ser-tog-wrap" title="Toggle word wrap">Wrap</button>
        <button type="button" class="ser-btn ser-tog-scroll" title="Toggle auto-scroll">Auto-scroll</button>
        <button type="button" class="ser-btn ser-tog-echo" title="Echo sent commands locally">Echo</button>
        <button type="button" class="ser-btn ser-tog-ts" title="Show timestamps (HH:MM:SS.mmm)">Timestamp</button>
        <button type="button" class="ser-btn ser-tog-col" title="Colorize ESP-IDF &amp; OK/ERR log levels">Colors</button>
        <button type="button" class="ser-btn ser-save-btn" title="Download current log as .txt">Save .txt</button>
        <span class="ser-sep"></span>
        <div class="ser-filter-wrap">
          <input type="text" class="ser-filter-in" placeholder="Filter (text or /regex/)…">
          <button type="button" class="ser-fchip on" data-fq="all">All</button>
          <button type="button" class="ser-fchip" data-fq="err">ERR</button>
          <button type="button" class="ser-fchip" data-fq="warn">WARN</button>
          <button type="button" class="ser-fchip" data-fq="ok">OK/EVT</button>
          <span class="ser-fcount" style="color:#6c7f99;font-family:monospace">0 lines</span>
        </div>
      </div>
      <div class="ser-alert-slot"></div>
      <div class="ser-term-wrap">
        <div class="ser-term wrap"></div>
        <button type="button" class="ser-jump">↓ Jump to bottom</button>
      </div>
      <div class="ser-send-row">
        <input type="text" class="ser-send-in" autocomplete="off" spellcheck="false">
        <select class="ser-smode-sel" title="Input interpretation">
          <option value="text">Send as Text</option>
          <option value="hex">Send as Hex</option>
        </select>
        <button type="button" class="ser-btn primary ser-send-go">Send</button>
        <button type="button" class="ser-btn ser-ctrl-btn" data-hex="03" title="Send Ctrl+C (0x03)">Ctrl+C</button>
        <button type="button" class="ser-btn ser-ctrl-btn" data-hex="04" title="Send Ctrl+D (0x04)">Ctrl+D</button>
      </div>
      <div class="ser-chips"></div>
      <div class="ser-foot"><span class="ser-stat">0 lines</span><span class="ser-err"></span></div>`;

    p.el = div;
    $('ser-grid').appendChild(div);

    const slotSel = div.querySelector('.ser-slot-sel');
    slotSel.onchange = () => setPaneSlot(p, slotSel.value);
    div.querySelector('.ser-refresh').onclick = refreshDevices;

    const viewSel = div.querySelector('.ser-view-sel');
    viewSel.value = p.viewMode;
    viewSel.onchange = () => {
        p.viewMode = prefs.viewMode = viewSel.value;
        savePrefs();
        p.dirtyFull = true;
        scheduleRender(p);
    };

    const eolSel = div.querySelector('.ser-eol-sel');
    eolSel.value = p.lineEnding;
    eolSel.onchange = () => { p.lineEnding = prefs.lineEnding = eolSel.value; savePrefs(); };

    const smodeSel = div.querySelector('.ser-smode-sel');
    smodeSel.value = p.sendMode;
    smodeSel.onchange = () => {
        p.sendMode = prefs.sendMode = smodeSel.value;
        savePrefs();
        updateSendControls(p);
    };

    div.querySelector('.ser-pause-btn').onclick = () => {
        p.paused = !p.paused;
        if (!p.paused && p.pendingChunks.length) {
            const batch = p.pendingChunks.splice(0);
            for (const c of batch) ingestBytes(p, c.bytes, c.ts, 'rx');
        }
        updatePauseBtn(p);
    };
    div.querySelector('.ser-clear-btn').onclick = () => clearPaneBuffer(p);
    div.querySelector('.ser-save-btn').onclick = () => downloadLog(p);

    const bindToggle = (sel, key, onChange) => {
        const b = div.querySelector(sel);
        const paint = () => b.classList.toggle('on', !!p[key]);
        paint();
        b.onclick = () => {
            p[key] = prefs[key] = !p[key];
            savePrefs();
            paint();
            if (onChange) onChange();
        };
    };
    bindToggle('.ser-tog-wrap', 'wordWrap', () => scheduleRender(p));
    bindToggle('.ser-tog-scroll', 'autoScroll', () => {
        if (p.autoScroll) { p.scrollLocked = true; jumpBtn.classList.remove('show'); }
        scheduleRender(p);
    });
    bindToggle('.ser-tog-echo', 'localEcho', () => { p.dirtyFull = true; scheduleRender(p); });
    bindToggle('.ser-tog-ts', 'timestamp', () => { p.dirtyFull = true; scheduleRender(p); });
    bindToggle('.ser-tog-col', 'colors', () => { p.dirtyFull = true; scheduleRender(p); });

    const filterIn = div.querySelector('.ser-filter-in');
    filterIn.oninput = () => { p.filterText = filterIn.value; p.dirtyFull = true; scheduleRender(p); };
    div.querySelectorAll('.ser-fchip[data-fq]').forEach(b => {
        b.onclick = () => {
            p.filterQuick = b.dataset.fq;
            div.querySelectorAll('.ser-fchip[data-fq]').forEach(x => x.classList.toggle('on', x === b));
            p.dirtyFull = true;
            scheduleRender(p);
        };
    });

    const term = div.querySelector('.ser-term');
    const jumpBtn = div.querySelector('.ser-jump');
    term.onscroll = () => {
        if (p.progScroll) return;
        const atBottom = term.scrollHeight - term.scrollTop - term.clientHeight < 28;
        p.scrollLocked = atBottom;
        jumpBtn.classList.toggle('show', p.autoScroll && !atBottom);
    };
    jumpBtn.onclick = () => {
        p.scrollLocked = true;
        jumpBtn.classList.remove('show');
        p.progScroll = true;
        term.scrollTop = term.scrollHeight;
        requestAnimationFrame(() => { p.progScroll = false; });
    };

    const sendIn = div.querySelector('.ser-send-in');
    sendIn.onkeydown = ev => {
        if (ev.key === 'Enter') {
            ev.preventDefault();
            sendFromInput(p);
        } else if (ev.key === 'ArrowUp') {
            if (!prefs.history.length) return;
            ev.preventDefault();
            if (p.histIdx === -1) { p.histDraft = sendIn.value; p.histIdx = prefs.history.length - 1; }
            else if (p.histIdx > 0) p.histIdx--;
            sendIn.value = prefs.history[p.histIdx];
        } else if (ev.key === 'ArrowDown') {
            if (p.histIdx === -1) return;
            ev.preventDefault();
            if (p.histIdx < prefs.history.length - 1) { p.histIdx++; sendIn.value = prefs.history[p.histIdx]; }
            else { p.histIdx = -1; sendIn.value = p.histDraft; }
        }
    };
    div.querySelector('.ser-send-go').onclick = () => sendFromInput(p);
    div.querySelectorAll('.ser-ctrl-btn').forEach(b => {
        b.onclick = () => sendControlByte(p, b.dataset.hex, b.textContent);
    });

    updateSlotSelect(p);
    updatePaneHeader(p);
    renderQuickChips(p);
}

$('ser-add').onclick = () => {
    const open = panes.map(p => p.slot);
    const p = createPane(pickDefaultSlot(open));
    activePaneId = p.id;
    renderTabs();
    applyLayout();
};
$('ser-split').onclick = () => {
    prefs.split = !prefs.split;
    savePrefs();
    renderTabs();
    applyLayout();
};

// ── Slot card button hook & device list sync ──────────────────────────────
function decorateSlotCards(slots) {
    const box = document.getElementById('slots');
    if (!box || !slots) return;
    slots.forEach((s, k) => {
        const card = box.children[k];
        if (!card) return;
        const old = card.querySelector('.ser-card-btn');
        if (old) old.remove();
        if (!s.present || !s.devnode || !s.label || s.is_probe) return;
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'ser-card-btn';
        btn.textContent = 'Open Serial Monitor';
        btn.title = 'Open live read-only Serial Monitor for ' + s.label;
        btn.onclick = () => openOrFocusSlot(s.label);
        const urlBox = card.querySelector('.url-box');
        (urlBox || card).after(btn);
    });
}

function syncSlotList(slots) {
    allSlots = slots || [];
    panes.forEach(updateSlotSelect);
    if (!panes.length) {
        const saved = (prefs.lastSlots || []).filter(lbl => allSlots.some(s => s.label === lbl));
        if (saved.length) saved.forEach(lbl => createPane(lbl));
        else createPane(pickDefaultSlot());
    } else if (panes.length === 1 && !panes[0].slot) {
        const def = pickDefaultSlot();
        if (def) setPaneSlot(panes[0], def);
    }
    decorateSlotCards(allSlots);
}

async function refreshDevices() {
    try {
        const r = await fetch('/api/devices');
        const j = await r.json();
        if (j && Array.isArray(j.slots)) syncSlotList(j.slots);
    } catch (e) { /* */ }
}

(function hookRenderSlots() {
    const orig = window.renderSlots;
    if (typeof orig !== 'function' || orig._ser) return;
    const w = function (slots) { orig.apply(this, arguments); syncSlotList(slots); };
    w._ser = true;
    if (orig._dut) w._dut = true;
    if (orig._la) w._la = true;
    window.renderSlots = w;
})();

mount.addEventListener('dash-panel-visibility', e => {
    visible = !!e.detail.visible;
    if (visible) syncSse(); else closeSse();
});
window.addEventListener('beforeunload', closeSse);

refreshDevices();
})();
