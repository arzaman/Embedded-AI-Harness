// Multimeter panel for the testbench dashboard (portal :8080).
// Served by hil-instruments (:8081) and loaded by pi/dashboard_panels.py,
// which creates the mount <div> and tells us when the card is shown/hidden.
// Styling reuses the portal's own classes (h2, .siggen-box, .siggen-row);
// everything new is prefixed "mm-".
(function () {
'use strict';
const script = document.currentScript;
const API = script.src.replace(/\/panel\/meter\.js.*$/, '');   // same-origin via the portal proxy
const mount = document.getElementById(script.dataset.mount || 'panel-meter');
if (!mount) return;

const POLL_MS = 250;
const WINDOWS = [10, 30, 60, 300, 900];          // chart span, seconds
const AVGS = [1, 4, 16, 64];
const RATES = [15, 30, 60, 240];
const BUF_MAX = 240 * 900;
const LS_KEY = 'dash.meter';

// ── persisted UI settings ─────────────────────────────────────────────
const prefs = Object.assign(
    {win: 30, avg: 4, yauto: true, ymin: 0, ymax: 12, lo: '', hi: '', lim: false},
    (() => { try { return JSON.parse(localStorage.getItem(LS_KEY)) || {}; } catch (e) { return {}; } })());
function savePrefs() { try { localStorage.setItem(LS_KEY, JSON.stringify(prefs)); } catch (e) { /* */ } }

// ── DOM ───────────────────────────────────────────────────────────────
const css = `
.mm-top { display: grid; grid-template-columns: minmax(320px, 1.4fr) minmax(260px, 1fr); gap: 16px; margin-bottom: 14px; }
@media (max-width: 760px) { .mm-top { grid-template-columns: 1fr; } }
.mm-lcd { background: #0a0a1a; border: 1px solid #0f3460; border-radius: 10px; padding: 12px 16px; }
.mm-ann { display: flex; gap: 6px; flex-wrap: wrap; font-size: 0.72em; font-weight: bold; min-height: 20px; }
.mm-ann span { padding: 2px 8px; border-radius: 10px; background: #16213e; color: #445; border: 1px solid #0f3460; }
.mm-ann span.on { color: #1a1a2e; background: #00d4ff; border-color: #00d4ff; }
.mm-ann span.warn { color: #fff; background: #e67e22; border-color: #e67e22; }
.mm-ann span.bad { color: #fff; background: #e74c3c; border-color: #e74c3c; }
.mm-ann span.good { color: #1a1a2e; background: #2ecc71; border-color: #2ecc71; }
.mm-val { font-family: 'Consolas', 'DejaVu Sans Mono', monospace; font-size: 3.6em; line-height: 1.15;
    color: #00d4ff; text-align: right; letter-spacing: 0.02em; white-space: nowrap; overflow: hidden; }
.mm-val.hold { color: #f0a030; }
.mm-val.ol { color: #e74c3c; }
.mm-val.stale { color: #445; }
.mm-unit { font-size: 0.45em; color: #8ab; margin-left: 8px; }
.mm-sub { display: flex; justify-content: space-between; color: #8ab; font-family: monospace; font-size: 0.85em; min-height: 1.2em; }
.mm-bar { position: relative; height: 10px; border-radius: 5px; background: #16213e; margin-top: 8px; overflow: hidden; }
.mm-bar-fill { position: absolute; top: 0; bottom: 0; left: 50%; background: #00d4ff; transition: all 0.15s; }
.mm-bar-zero { position: absolute; left: 50%; top: -2px; width: 1px; height: 14px; background: #556; }
.mm-bar-scale { display: flex; justify-content: space-between; color: #556; font-size: 0.7em; font-family: monospace; }
.mm-stats { display: grid; grid-template-columns: auto 1fr; gap: 4px 14px; align-content: start;
    background: #0a0a1a; border: 1px solid #0f3460; border-radius: 10px; padding: 12px 16px; font-size: 0.9em; }
.mm-stats .k { color: #8ab; }
.mm-stats .v { color: #e0e0e0; font-family: monospace; text-align: right; }
.mm-stats .full { grid-column: 1 / -1; display: flex; justify-content: space-between; align-items: center;
    margin-top: 4px; color: #666; font-size: 0.85em; }
.mm .siggen-row button { background: #0f3460; color: #cfe; border: 1px solid #2a4070; font-weight: bold; }
.mm .siggen-row button.on { background: #00d4ff; color: #1a1a2e; border-color: #00d4ff; }
.mm .siggen-row button.run { background: #28a745; color: #fff; border-color: #28a745; }
.mm .siggen-row button.stop { background: #dc3545; color: #fff; border-color: #dc3545; }
.mm .siggen-row button.rec { background: #dc3545; color: #fff; border-color: #dc3545; animation: mm-blink 1s steps(2) infinite; }
@keyframes mm-blink { 50% { opacity: 0.55; } }
.mm .siggen-row label { min-width: auto; }
.mm .siggen-row input[type="number"] { width: 90px; }
.mm-sep { width: 1px; align-self: stretch; background: #0f3460; margin: 0 4px; }
.mm-seg { display: inline-flex; }
.mm-seg button { border-radius: 0 !important; margin-left: -1px; }
.mm-seg button:first-child { border-radius: 4px 0 0 4px !important; }
.mm-seg button:last-child { border-radius: 0 4px 4px 0 !important; }
.mm-chart-wrap { position: relative; height: 260px; background: #0a0a1a; border: 1px solid #0f3460; border-radius: 10px; }
.mm-chart-wrap canvas { position: absolute; inset: 0; width: 100%; height: 100%; cursor: crosshair; }
.mm-tip { position: absolute; pointer-events: none; background: #16213e; border: 1px solid #00d4ff; color: #e0e0e0;
    font-family: monospace; font-size: 0.78em; padding: 3px 7px; border-radius: 4px; display: none; white-space: nowrap; }
.mm-foot { color: #666; font-size: 0.78em; margin-top: 8px; display: flex; justify-content: space-between; flex-wrap: wrap; gap: 8px; }
.mm-foot .err { color: #ff6b6b; }
`;
const style = document.createElement('style');
style.textContent = css;
document.head.appendChild(style);

const seg = (cls, items, fmt) => '<span class="mm-seg" id="' + cls + '">' +
    items.map(x => '<button type="button" data-v="' + x + '">' + fmt(x) + '</button>').join('') + '</span>';
const fmtWin = s => s < 60 ? s + 's' : (s / 60) + 'm';

mount.innerHTML = `
<h2>Multimeter <span style="color:#8ab;font-size:0.6em">DC V</span></h2>
<div class="siggen-box mm">
  <div class="mm-top">
    <div class="mm-lcd">
      <div class="mm-ann">
        <span id="mm-a-run">RUN</span><span id="mm-a-hold">HOLD</span><span id="mm-a-auto">AUTO</span>
        <span id="mm-a-rel">REL</span><span id="mm-a-range" class="on">—</span><span id="mm-a-rate" class="on">—</span>
        <span id="mm-a-avg" class="on">—</span><span id="mm-a-lim">LIMIT</span><span id="mm-a-rec">REC</span><span id="mm-a-ol">OL</span>
      </div>
      <div class="mm-val stale" id="mm-val">-.----<span class="mm-unit">V</span></div>
      <div class="mm-sub"><span id="mm-sub-l"></span><span id="mm-sub-r"></span></div>
      <div class="mm-bar"><div class="mm-bar-zero"></div><div class="mm-bar-fill" id="mm-bar"></div></div>
      <div class="mm-bar-scale"><span id="mm-bar-lo"></span><span>0</span><span id="mm-bar-hi"></span></div>
    </div>
    <div class="mm-stats">
      <span class="k">Min</span><span class="v" id="mm-s-min">—</span>
      <span class="k">Max</span><span class="v" id="mm-s-max">—</span>
      <span class="k">Avg</span><span class="v" id="mm-s-avg">—</span>
      <span class="k">Std dev σ</span><span class="v" id="mm-s-sd">—</span>
      <span class="k">Peak-peak</span><span class="v" id="mm-s-pp">—</span>
      <span class="k">Samples</span><span class="v" id="mm-s-n">0</span>
      <span class="k">Limit fails</span><span class="v" id="mm-s-fail">—</span>
      <div class="full"><span id="mm-s-since">since —</span>
        <button type="button" id="mm-reset" style="background:#0f3460;color:#aaa;border:1px solid #333;padding:3px 10px;border-radius:4px;cursor:pointer">Reset stats</button></div>
    </div>
  </div>
  <div class="siggen-row">
    <button type="button" id="mm-run" class="run">Run</button>
    <button type="button" id="mm-hold">Hold</button>
    <button type="button" id="mm-rel" title="Zero the display on the current value">REL Δ</button>
    <span class="mm-sep"></span>
    <label>Range</label><select id="mm-range"><option value="auto">Auto</option></select>
    <label>Rate</label><select id="mm-rate">${RATES.map(r => '<option value="' + r + '">' + r + ' SPS</option>').join('')}</select>
    <label>Avg</label>${seg('mm-avg', AVGS, x => '×' + x)}
  </div>
  <div class="siggen-row">
    <label><input type="checkbox" id="mm-lim"> Limits</label>
    <label>LO</label><input type="number" id="mm-lo" step="0.001" placeholder="V">
    <label>HI</label><input type="number" id="mm-hi" step="0.001" placeholder="V">
    <span class="mm-sep"></span>
    <button type="button" id="mm-rec" title="Record every sample (Pi timestamps) for CSV export">● Rec</button>
    <button type="button" id="mm-mark" title="Drop a time marker (shown on chart, saved in CSV)">Mark</button>
    <button type="button" id="mm-csv" title="Download the recording (or the chart buffer) as CSV">CSV</button>
    <span id="mm-rec-info" style="color:#8ab;font-size:0.85em"></span>
  </div>
  <div class="siggen-row">
    <label>Window</label>${seg('mm-win', WINDOWS, fmtWin)}
    <span class="mm-sep"></span>
    <label><input type="checkbox" id="mm-yauto"> Y auto</label>
    <input type="number" id="mm-ymin" step="0.1" title="Y min (V)">
    <input type="number" id="mm-ymax" step="0.1" title="Y max (V)">
    <button type="button" id="mm-clear" title="Clear chart buffer">Clear</button>
  </div>
  <div class="mm-chart-wrap" id="mm-wrap"><canvas id="mm-cv"></canvas><div class="mm-tip" id="mm-tip"></div></div>
  <div class="mm-foot"><span id="mm-info">—</span><span id="mm-err"></span></div>
</div>`;
const $ = id => document.getElementById(id);

// ── state ─────────────────────────────────────────────────────────────
let running = false, hold = false, rel = null, visible = true, timer = null;
let seq = 0, primed = false, cfg = null, lastSample = null, lastRx = 0;
let T = [], V = [], OL = [];                      // chart buffer
let markers = [];                                 // {t, n}
let rec = null;                                   // array of [t, v, ol] while recording
let st;                                           // running stats (Welford)
function resetStats() { st = {n: 0, mean: 0, m2: 0, min: Infinity, max: -Infinity, fail: 0, t0: Date.now()}; }
resetStats();

// ── helpers ───────────────────────────────────────────────────────────
function fmtV(v, digits) {
    if (v === null || !isFinite(v)) return '—';
    const a = Math.abs(v);
    if (a < 1) return (v * 1000).toFixed(Math.max(0, (digits || 4) - 2)) + ' mV';
    return v.toFixed(digits || 4) + ' V';
}
function limits() {
    const lo = parseFloat(prefs.lo), hi = parseFloat(prefs.hi);
    return {on: prefs.lim, lo: isFinite(lo) ? lo : null, hi: isFinite(hi) ? hi : null};
}
function inLimits(v) {
    const L = limits();
    if (!L.on) return null;
    return !((L.lo !== null && v < L.lo) || (L.hi !== null && v > L.hi));
}
async function api(path, body) {
    const r = await fetch(API + path, body === undefined ? {} :
        {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)});
    const j = await r.json();
    if (!j.ok) throw new Error(j.error || r.status);
    return j;
}
function setErr(msg) { $('mm-err').textContent = msg || ''; $('mm-err').className = msg ? 'err' : ''; }

// ── config ────────────────────────────────────────────────────────────
function applyCfg(c) {
    cfg = Object.assign(cfg || {}, c);
    const sel = $('mm-range');
    if (cfg.ranges && sel.options.length === 1) {
        Object.keys(cfg.ranges).sort((a, b) => a - b).forEach(g => {
            const o = document.createElement('option');
            o.value = g; o.textContent = '±' + cfg.ranges[g].toFixed(2) + ' V';
            sel.appendChild(o);
        });
    }
    sel.value = cfg.autorange ? 'auto' : String(cfg.pga);
    $('mm-rate').value = String(cfg.sps);
    const fs = cfg.range_v || cfg.full_scale_v;
    $('mm-a-range').textContent = fs ? fs.toFixed(2) + ' V' : '—';
    $('mm-a-rate').textContent = cfg.sps + ' SPS';
    $('mm-a-auto').className = cfg.autorange ? 'on' : '';
    $('mm-bar-lo').textContent = fs ? '-' + fs.toFixed(1) : '';
    $('mm-bar-hi').textContent = fs ? '+' + fs.toFixed(1) : '';
    const lsb = cfg.lsb_v;
    $('mm-info').textContent = 'ADS1110 @' + (cfg.address || '0x48') +
        (cfg.cal ? ' · cal ×' + cfg.cal.scale + ' ' + (cfg.cal.offset_v * 1000).toFixed(2) + ' mV' : '') +
        (lsb ? ' · LSB ' + (lsb * 1000).toFixed(3) + ' mV' : '') +
        ' · single-ended, not isolated (Pi GND) · timestamps = Pi clock';
}
async function loadStatus() {
    try { applyCfg(await api('/api/meter/status')); setErr(''); }
    catch (e) { setErr('meter: ' + e.message); }
}
async function setConfig(body) {
    try { applyCfg(await api('/api/meter/config', body)); setErr(''); }
    catch (e) { setErr('config: ' + e.message); }
}

// ── acquisition ───────────────────────────────────────────────────────
async function poll() {
    if (!running || !visible) return;
    try {
        const j = await api('/api/meter/stream?since=' + seq);
        if (j.seq < seq) seq = 0;                 // service restarted
        seq = j.seq;
        applyCfg({sps: j.sps, pga: j.pga, range_v: j.range_v, lsb_v: j.lsb_v, autorange: j.autorange});
        ingest(j.samples, primed);
        primed = true;
        setErr(j.error ? 'stream: ' + j.error : '');
    } catch (e) { setErr('stream: ' + e.message); }
    if (running && visible) timer = setTimeout(poll, POLL_MS);
}
// The first poll returns the service's backlog: chart it, but keep it out of
// the statistics and the recording, which start now.
function ingest(samples, live) {
    if (!samples.length) return;
    lastRx = Date.now();
    for (const [t, v, ol] of samples) {
        T.push(t); V.push(v); OL.push(ol);
        if (!live) continue;
        if (rec) rec.push([t, v, ol]);
        if (!ol) {
            st.n++; const d = v - st.mean; st.mean += d / st.n; st.m2 += d * (v - st.mean);
            if (v < st.min) st.min = v; if (v > st.max) st.max = v;
            if (inLimits(v) === false) st.fail++;
        }
    }
    if (T.length > BUF_MAX) { const k = T.length - BUF_MAX; T.splice(0, k); V.splice(0, k); OL.splice(0, k); }
    lastSample = samples[samples.length - 1];
    if (!hold) renderDisplay();
    renderStats();
    draw();
}

// ── rendering: LCD + stats ────────────────────────────────────────────
function displayValue() {
    const n = Math.min(prefs.avg, V.length);
    if (!n) return null;
    let s = 0, ol = false;
    for (let i = V.length - n; i < V.length; i++) { s += V[i]; ol = ol || OL[i]; }
    return {v: s / n, ol};
}
function renderDisplay() {
    const d = displayValue(), el = $('mm-val');
    const fs = cfg && (cfg.range_v || cfg.full_scale_v);
    $('mm-a-ol').className = d && d.ol ? 'bad' : '';
    if (!d) { el.innerHTML = '-.----<span class="mm-unit">V</span>'; el.className = 'mm-val stale'; return; }
    let shown = d.v - (rel === null ? 0 : rel);
    if (d.ol) {
        el.innerHTML = (d.v < 0 ? '-' : '') + 'OL<span class="mm-unit">V</span>';
        el.className = 'mm-val ol';
    } else {
        const digits = fs && fs < 5 ? 5 : 4;
        const txt = Math.abs(shown) < 1 && fs && fs < 5
            ? (shown * 1000).toFixed(2) + '<span class="mm-unit">mV</span>'
            : (shown >= 0 ? '+' : '') + shown.toFixed(digits) + '<span class="mm-unit">V</span>';
        el.innerHTML = (rel === null ? '' : 'Δ ') + txt;
        el.className = 'mm-val' + (hold ? ' hold' : '');
    }
    $('mm-sub-l').textContent = rel === null ? '' : 'ref ' + fmtV(rel) + ' · abs ' + fmtV(d.v);
    const ok = inLimits(d.v), lim = $('mm-a-lim');
    lim.className = ok === null ? '' : ok ? 'good' : 'bad';
    lim.textContent = ok === null ? 'LIMIT' : ok ? 'PASS' : 'FAIL';
    $('mm-sub-r').textContent = lastSample ? new Date(lastSample[0]).toLocaleTimeString() + '.' +
        String(lastSample[0] % 1000).padStart(3, '0') : '';
    if (fs) {
        const f = Math.max(-1, Math.min(1, d.v / fs)), bar = $('mm-bar');
        bar.style.left = (f < 0 ? 50 + f * 50 : 50) + '%';
        bar.style.width = Math.abs(f) * 50 + '%';
        bar.style.background = d.ol ? '#e74c3c' : ok === false ? '#e67e22' : '#00d4ff';
    }
}
function renderStats() {
    const has = st.n > 0;
    $('mm-s-min').textContent = has ? fmtV(st.min) : '—';
    $('mm-s-max').textContent = has ? fmtV(st.max) : '—';
    $('mm-s-avg').textContent = has ? fmtV(st.mean, 5) : '—';
    $('mm-s-sd').textContent = st.n > 1 ? (Math.sqrt(st.m2 / (st.n - 1)) * 1000).toFixed(3) + ' mV' : '—';
    $('mm-s-pp').textContent = has ? ((st.max - st.min) * 1000).toFixed(2) + ' mV' : '—';
    $('mm-s-n').textContent = st.n;
    $('mm-s-fail').textContent = limits().on ? String(st.fail) : '—';
    $('mm-s-since').textContent = 'since ' + new Date(st.t0).toLocaleTimeString();
    $('mm-rec-info').textContent = rec ? rec.length + ' samples recorded' : '';
}
function renderAnn() {
    $('mm-a-run').className = running ? 'good' : '';
    $('mm-a-run').textContent = running ? 'RUN' : 'STOP';
    $('mm-a-hold').className = hold ? 'warn' : '';
    $('mm-a-rel').className = rel !== null ? 'on' : '';
    $('mm-a-rec').className = rec ? 'bad' : '';
    $('mm-a-avg').textContent = 'AVG ×' + prefs.avg;
    $('mm-run').textContent = running ? 'Stop' : 'Run';
    $('mm-run').className = running ? 'stop' : 'run';
    $('mm-hold').className = hold ? 'on' : '';
    $('mm-rel').className = rel !== null ? 'on' : '';
    $('mm-rec').className = rec ? 'rec' : '';
    $('mm-rec').textContent = rec ? '■ Stop rec' : '● Rec';
    document.querySelectorAll('#mm-avg button').forEach(b => b.classList.toggle('on', +b.dataset.v === prefs.avg));
    document.querySelectorAll('#mm-win button').forEach(b => b.classList.toggle('on', +b.dataset.v === prefs.win));
    $('mm-yauto').checked = prefs.yauto;
    $('mm-ymin').disabled = $('mm-ymax').disabled = prefs.yauto;
    $('mm-ymin').value = prefs.ymin; $('mm-ymax').value = prefs.ymax;
    $('mm-lim').checked = prefs.lim; $('mm-lo').value = prefs.lo; $('mm-hi').value = prefs.hi;
}

// ── rendering: strip chart ────────────────────────────────────────────
const cv = $('mm-cv'), ctx = cv.getContext('2d');
let view = null;                                  // last drawn mapping, for the hover tip
function niceStep(span, n) {
    const raw = span / n, p = Math.pow(10, Math.floor(Math.log10(raw)));
    return [1, 2, 5, 10].map(m => m * p).find(s => s >= raw) || raw;
}
function draw() {
    const W = cv.clientWidth, H = cv.clientHeight, dpr = window.devicePixelRatio || 1;
    if (!W || !H) return;
    if (cv.width !== W * dpr || cv.height !== H * dpr) { cv.width = W * dpr; cv.height = H * dpr; }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const L = 64, R = 12, TP = 10, B = 24, pw = W - L - R, ph = H - TP - B;
    const tEnd = T.length ? Math.max(T[T.length - 1], running ? Date.now() - 300 : 0) : Date.now();
    const tStart = tEnd - prefs.win * 1000;
    let i0 = T.length; while (i0 > 0 && T[i0 - 1] >= tStart) i0--;
    // y range
    let y0, y1;
    if (prefs.yauto) {
        y0 = Infinity; y1 = -Infinity;
        for (let i = i0; i < T.length; i++) { if (V[i] < y0) y0 = V[i]; if (V[i] > y1) y1 = V[i]; }
        const lim = limits();
        if (lim.on) { for (const x of [lim.lo, lim.hi]) if (x !== null && isFinite(y0)) { y0 = Math.min(y0, x); y1 = Math.max(y1, x); } }
        if (!isFinite(y0)) { y0 = 0; y1 = 1; }
        if (y1 - y0 < 0.01) { const mid = (y0 + y1) / 2; y0 = mid - 0.005; y1 = mid + 0.005; }
        const pad = (y1 - y0) * 0.1; y0 -= pad; y1 += pad;
    } else { y0 = +prefs.ymin; y1 = +prefs.ymax; if (!(y1 > y0)) y1 = y0 + 1; }
    const X = t => L + (t - tStart) / (tEnd - tStart) * pw;
    const Y = v => TP + (1 - (v - y0) / (y1 - y0)) * ph;
    view = {L, pw, TP, ph, tStart, tEnd, y0, y1, i0};
    // grid + labels
    ctx.font = '11px monospace'; ctx.fillStyle = '#667'; ctx.strokeStyle = '#16213e'; ctx.lineWidth = 1;
    const ys = niceStep(y1 - y0, 5), dec = Math.max(0, -Math.floor(Math.log10(ys)));
    ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    for (let v = Math.ceil(y0 / ys) * ys; v <= y1; v += ys) {
        const y = Math.round(Y(v)) + 0.5;
        ctx.beginPath(); ctx.moveTo(L, y); ctx.lineTo(L + pw, y); ctx.stroke();
        ctx.fillText(v.toFixed(Math.min(dec, 4)), L - 6, y);
    }
    const xs = niceStep(prefs.win, 6);
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    for (let s = 0; s <= prefs.win + 1e-9; s += xs) {
        const x = Math.round(X(tEnd - s * 1000)) + 0.5;
        ctx.beginPath(); ctx.moveTo(x, TP); ctx.lineTo(x, TP + ph); ctx.stroke();
        ctx.fillText(s === 0 ? 'now' : '-' + (s < 60 ? s + 's' : (s / 60).toFixed(s % 60 ? 1 : 0) + 'm'), x, TP + ph + 6);
    }
    ctx.strokeStyle = '#0f3460'; ctx.strokeRect(L + 0.5, TP + 0.5, pw, ph);
    // limits + REL reference
    const hline = (v, color, label) => {
        if (v === null || v < y0 || v > y1) return;
        const y = Math.round(Y(v)) + 0.5;
        ctx.save(); ctx.setLineDash([5, 4]); ctx.strokeStyle = color;
        ctx.beginPath(); ctx.moveTo(L, y); ctx.lineTo(L + pw, y); ctx.stroke(); ctx.restore();
        ctx.fillStyle = color; ctx.textAlign = 'left'; ctx.textBaseline = 'bottom'; ctx.fillText(label, L + 4, y - 2);
    };
    const lim = limits();
    if (lim.on) { hline(lim.hi, '#e74c3c', 'HI'); hline(lim.lo, '#e74c3c', 'LO'); }
    if (rel !== null) hline(rel, '#9b59b6', 'REL');
    // markers
    ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    for (const m of markers) {
        if (m.t < tStart || m.t > tEnd) continue;
        const x = Math.round(X(m.t)) + 0.5;
        ctx.strokeStyle = '#f0a030'; ctx.beginPath(); ctx.moveTo(x, TP); ctx.lineTo(x, TP + ph); ctx.stroke();
        ctx.fillStyle = '#f0a030'; ctx.fillText('M' + m.n, x + 3, TP + 2);
    }
    // trace: min/max per pixel column keeps spikes visible when decimating
    ctx.save(); ctx.beginPath(); ctx.rect(L, TP, pw, ph); ctx.clip();
    ctx.strokeStyle = '#00d4ff'; ctx.lineWidth = 1.5; ctx.beginPath();
    let col = -1, mn = 0, mx = 0, first = true;
    const flush = () => {
        if (col < 0) return;
        if (first) { ctx.moveTo(col, Y(mn)); first = false; } else ctx.lineTo(col, Y(mn));
        if (mx !== mn) ctx.lineTo(col, Y(mx));
    };
    for (let i = i0; i < T.length; i++) {
        const c = Math.round(X(T[i]));
        if (c !== col) { flush(); col = c; mn = mx = V[i]; }
        else { if (V[i] < mn) mn = V[i]; if (V[i] > mx) mx = V[i]; }
    }
    flush(); ctx.stroke();
    ctx.fillStyle = '#e74c3c';
    for (let i = i0; i < T.length; i++) if (OL[i]) ctx.fillRect(X(T[i]) - 1, TP, 2, 4);
    ctx.restore();
}
cv.addEventListener('mousemove', e => {
    const tip = $('mm-tip');
    if (!view || !T.length) { tip.style.display = 'none'; return; }
    const r = cv.getBoundingClientRect(), x = e.clientX - r.left;
    const t = view.tStart + (x - view.L) / view.pw * (view.tEnd - view.tStart);
    let lo = view.i0, hi = T.length - 1;
    while (lo < hi) { const m = (lo + hi) >> 1; if (T[m] < t) lo = m + 1; else hi = m; }
    if (lo >= T.length || x < view.L) { tip.style.display = 'none'; return; }
    const d = new Date(T[lo]);
    tip.textContent = d.toLocaleTimeString() + '.' + String(T[lo] % 1000).padStart(3, '0') + '  ' +
        (OL[lo] ? 'OL' : fmtV(V[lo], 5));
    tip.style.display = 'block';
    tip.style.left = Math.min(x + 12, r.width - tip.offsetWidth - 4) + 'px';
    tip.style.top = Math.max(4, e.clientY - r.top - 28) + 'px';
});
cv.addEventListener('mouseleave', () => { $('mm-tip').style.display = 'none'; });
window.addEventListener('resize', draw);

// ── CSV export ────────────────────────────────────────────────────────
function exportCsv() {
    const rows = rec && rec.length ? rec : T.map((t, i) => [t, V[i], OL[i]]);
    if (!rows.length) return;
    const mk = new Map();
    for (const m of markers) {                    // attach each marker to the nearest following sample
        const r = rows.find(x => x[0] >= m.t);
        if (r) mk.set(r[0], (mk.has(r[0]) ? mk.get(r[0]) + ' ' : '') + 'M' + m.n);
    }
    const out = ['epoch_ms,iso_utc,volts,overload,marker'];
    for (const [t, v, ol] of rows) out.push(t + ',' + new Date(t).toISOString() + ',' + v + ',' + ol + ',' + (mk.get(t) || ''));
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([out.join('\n') + '\n'], {type: 'text/csv'}));
    a.download = 'meter-' + new Date(rows[0][0]).toISOString().replace(/[:.]/g, '-').slice(0, 19) + '.csv';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

// ── controls ──────────────────────────────────────────────────────────
function start() { if (running) return; running = true; renderAnn(); clearTimeout(timer); poll(); }
function stop() { running = false; clearTimeout(timer); renderAnn(); }
$('mm-run').onclick = () => running ? stop() : start();
$('mm-hold').onclick = () => { hold = !hold; renderAnn(); renderDisplay(); };
$('mm-rel').onclick = () => {
    const d = displayValue();
    rel = rel === null && d && !d.ol ? d.v : null;
    renderAnn(); renderDisplay(); draw();
};
$('mm-range').onchange = e => setConfig(e.target.value === 'auto' ? {autorange: true} : {autorange: false, pga: +e.target.value});
$('mm-rate').onchange = e => setConfig({sps: +e.target.value});
$('mm-avg').onclick = e => { const v = +e.target.dataset.v; if (v) { prefs.avg = v; savePrefs(); renderAnn(); renderDisplay(); } };
$('mm-win').onclick = e => { const v = +e.target.dataset.v; if (v) { prefs.win = v; savePrefs(); renderAnn(); draw(); } };
$('mm-yauto').onchange = e => { prefs.yauto = e.target.checked; if (!prefs.yauto && view) { prefs.ymin = +view.y0.toFixed(3); prefs.ymax = +view.y1.toFixed(3); } savePrefs(); renderAnn(); draw(); };
$('mm-ymin').onchange = e => { prefs.ymin = +e.target.value; savePrefs(); draw(); };
$('mm-ymax').onchange = e => { prefs.ymax = +e.target.value; savePrefs(); draw(); };
$('mm-lim').onchange = e => { prefs.lim = e.target.checked; st.fail = 0; savePrefs(); renderDisplay(); renderStats(); draw(); };
$('mm-lo').onchange = e => { prefs.lo = e.target.value; st.fail = 0; savePrefs(); renderDisplay(); renderStats(); draw(); };
$('mm-hi').onchange = e => { prefs.hi = e.target.value; st.fail = 0; savePrefs(); renderDisplay(); renderStats(); draw(); };
$('mm-reset').onclick = () => { resetStats(); renderStats(); };
$('mm-clear').onclick = () => { T = []; V = []; OL = []; markers = []; draw(); };
$('mm-rec').onclick = () => { rec = rec ? null : []; if (rec && !running) start(); renderAnn(); renderStats(); };
$('mm-mark').onclick = () => {
    const t = lastSample ? Math.max(lastSample[0], Date.now() - 200) : Date.now();
    markers.push({t, n: markers.length + 1}); draw();
};
$('mm-csv').onclick = exportCsv;

// The dashboard loader tells us when the card is hidden: stop polling so the
// service lets the ADC go idle.
mount.addEventListener('dash-panel-visibility', e => {
    visible = !!e.detail.visible;
    clearTimeout(timer);
    if (visible && running) poll();
});
setInterval(() => {                               // stale indicator when the stream dries up
    if (running && lastRx && Date.now() - lastRx > 3000) $('mm-val').classList.add('stale');
    if (running) draw();                          // keep the time axis scrolling
}, 1000);

renderAnn();
loadStatus().then(start);
})();
