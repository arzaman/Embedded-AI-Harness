// Logic analyzer panel for the testbench dashboard (portal :8080).
// Served by hil-instruments (:8081) and loaded by pi/dashboard_panels.py,
// which creates the mount <div> and tells us when the card is shown/hidden.
// Same look as the multimeter (panel_meter.js): portal classes (h2,
// .siggen-box, .siggen-row) plus our own, prefixed "la-".
(function () {
'use strict';
const script = document.currentScript;
const API = script.src.replace(/\/panel\/logic\.js.*$/, '');   // same-origin via the portal proxy
const mount = document.getElementById(script.dataset.mount || 'panel-logic');
if (!mount) return;

const DURATIONS = [10, 50, 100, 500, 1000, 2000, 5000, 10000, 30000];   // ms
const FALLBACK_RATES = [20e3, 50e3, 100e3, 250e3, 500e3, 1e6, 2e6, 4e6, 8e6, 12e6, 16e6, 24e6];
const MAX_SAMPLES = 200e6;
const TREND_MAX = 200;
const LS_KEY = 'dash.logic';
const PRE_MS = [0, 10, 50, 100, 500, 1000, 5000];
const TIMEOUTS = [1000, 5000, 10000, 30000, 60000];
const CONDS = [['r', '↑ rising'], ['f', '↓ falling'], ['e', '↕ edge'], ['1', 'high'], ['0', 'low']];
const MAX_CYCLES = 100;
const COLORS = ['#00d4ff', '#2ecc71', '#f1c40f', '#e67e22', '#e84393', '#9b59b6', '#1abc9c', '#bdc3c7'];

// ── persisted UI settings ─────────────────────────────────────────────
const prefs = Object.assign(
    {rate: 1e6, dur: 2000, chans: [0], labels: {}, meas: 0, maxEdges: 20000, abs: false,
     lim: false, flo: '', fhi: '', dlo: '', dhi: '',
     trg: false, tch: 0, tcond: 'r', tpre: 100, ttmo: 10000},
    (() => { try { return JSON.parse(localStorage.getItem(LS_KEY)) || {}; } catch (e) { return {}; } })());
function savePrefs() { try { localStorage.setItem(LS_KEY, JSON.stringify(prefs)); } catch (e) { /* */ } }

// ── DOM ───────────────────────────────────────────────────────────────
const css = `
.la-top { display: grid; grid-template-columns: minmax(320px, 1.4fr) minmax(260px, 1fr); gap: 16px; margin-bottom: 14px; }
@media (max-width: 760px) { .la-top { grid-template-columns: 1fr; } }
.la-lcd { background: #0a0a1a; border: 1px solid #0f3460; border-radius: 10px; padding: 12px 16px; }
.la-ann { display: flex; gap: 6px; flex-wrap: wrap; font-size: 0.72em; font-weight: bold; min-height: 20px; }
.la-ann span { padding: 2px 8px; border-radius: 10px; background: #16213e; color: #445; border: 1px solid #0f3460; }
.la-ann span.on { color: #1a1a2e; background: #00d4ff; border-color: #00d4ff; }
.la-ann span.warn { color: #fff; background: #e67e22; border-color: #e67e22; }
.la-ann span.bad { color: #fff; background: #e74c3c; border-color: #e74c3c; }
.la-ann span.good { color: #1a1a2e; background: #2ecc71; border-color: #2ecc71; }
.la-val { font-family: 'Consolas', 'DejaVu Sans Mono', monospace; font-size: 3.6em; line-height: 1.15;
    color: #00d4ff; text-align: right; letter-spacing: 0.02em; white-space: nowrap; overflow: hidden; }
.la-val.stale { color: #445; }
.la-val.static { color: #f0a030; }
.la-val.busy { opacity: 0.55; }
.la-unit { font-size: 0.45em; color: #8ab; margin-left: 8px; }
.la-sub { display: flex; justify-content: space-between; color: #8ab; font-family: monospace; font-size: 0.85em; min-height: 1.2em; gap: 10px; }
.la-bar { position: relative; height: 10px; border-radius: 5px; background: #16213e; margin-top: 8px; overflow: hidden; }
.la-bar-fill { position: absolute; top: 0; bottom: 0; left: 0; background: #00d4ff; transition: all 0.15s; }
.la-bar-mid { position: absolute; left: 50%; top: -2px; width: 1px; height: 14px; background: #556; }
.la-bar-scale { display: flex; justify-content: space-between; color: #556; font-size: 0.7em; font-family: monospace; }
.la-stats { display: grid; grid-template-columns: auto 1fr; gap: 4px 14px; align-content: start;
    background: #0a0a1a; border: 1px solid #0f3460; border-radius: 10px; padding: 12px 16px; font-size: 0.9em; }
.la-stats .k { color: #8ab; }
.la-stats .v { color: #e0e0e0; font-family: monospace; text-align: right; }
.la-stats .full { grid-column: 1 / -1; display: flex; justify-content: space-between; align-items: center;
    margin-top: 4px; color: #666; font-size: 0.85em; }
.la-stats canvas { grid-column: 1 / -1; width: 100%; height: 38px; }
.la .siggen-row button { background: #0f3460; color: #cfe; border: 1px solid #2a4070; font-weight: bold; }
.la .siggen-row button.on { background: #00d4ff; color: #1a1a2e; border-color: #00d4ff; }
.la .siggen-row button.run { background: #28a745; color: #fff; border-color: #28a745; }
.la .siggen-row button.stop { background: #dc3545; color: #fff; border-color: #dc3545; animation: la-blink 1s steps(2) infinite; }
.la .siggen-row button:disabled { opacity: 0.5; cursor: default; }
@keyframes la-blink { 50% { opacity: 0.6; } }
.la .siggen-row label { min-width: auto; }
.la .siggen-row input[type="number"] { width: 90px; }
.la-sep { width: 1px; align-self: stretch; background: #0f3460; margin: 0 4px; }
.la-chips { display: inline-flex; gap: 6px; flex-wrap: wrap; }
.la-chip { border-radius: 14px !important; padding: 3px 10px !important; font-size: 0.85em; opacity: 0.45; }
.la-chip.on { opacity: 1; }
.la-chip i { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 6px; vertical-align: middle; }
.la-wave-wrap { position: relative; background: #0a0a1a; border: 1px solid #0f3460; border-radius: 10px; }
.la-wave-wrap canvas { position: absolute; inset: 0; width: 100%; height: 100%; cursor: crosshair; }
.la-wave-wrap canvas.drag { cursor: grabbing; }
.la-tip { position: absolute; pointer-events: none; background: #16213e; border: 1px solid #00d4ff; color: #e0e0e0;
    font-family: monospace; font-size: 0.78em; padding: 3px 7px; border-radius: 4px; display: none; white-space: pre; z-index: 2; }
.la-empty { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; color: #556; font-size: 0.9em; pointer-events: none; }
.la-cur { font-family: monospace; font-size: 0.85em; color: #8ab; }
.la-cur b { color: #e0e0e0; font-weight: normal; }
.la-cur .a { color: #f0a030; } .la-cur .b { color: #c39bd3; }
.la-tbl { width: 100%; border-collapse: collapse; margin-top: 12px; font-size: 0.85em; }
.la-tbl th { color: #8ab; text-align: right; font-weight: normal; padding: 4px 8px; border-bottom: 1px solid #0f3460; white-space: nowrap; }
.la-tbl th:nth-child(-n+3) { text-align: left; }
.la-tbl td { font-family: monospace; color: #e0e0e0; text-align: right; padding: 4px 8px; border-bottom: 1px solid #16213e; white-space: nowrap; }
.la-tbl td:nth-child(-n+3) { text-align: left; }
.la-tbl tr { cursor: pointer; }
.la-tbl tr.sel td { background: #16213e; }
.la-tbl tr:hover td { background: #121a33; }
.la-tbl .dim { color: #667; }
.la-tbl .bad { color: #e74c3c; } .la-tbl .good { color: #2ecc71; }
.la-lv { display: inline-flex; gap: 6px; flex-wrap: wrap; font-family: monospace; font-size: 0.82em; }
.la-lv span { padding: 2px 8px; border-radius: 10px; border: 1px solid #0f3460; color: #8ab; background: #0a0a1a; }
.la-lv span.hi { color: #1a1a2e; background: #2ecc71; border-color: #2ecc71; }
.la-lv span.lo { color: #e0e0e0; background: #16213e; }
.la-lv span.tg { color: #1a1a2e; background: #f1c40f; border-color: #f1c40f; }
.la-foot { color: #666; font-size: 0.78em; margin-top: 8px; display: flex; justify-content: space-between; flex-wrap: wrap; gap: 8px; }
.la-foot .err { color: #ff6b6b; } .la-foot .warn { color: #e67e22; }
`;
const style = document.createElement('style');
style.textContent = css;
document.head.appendChild(style);

const fmtDur = ms => ms < 1000 ? ms + ' ms' : (ms / 1000) + ' s';
const fmtRate = r => r >= 1e6 ? (r / 1e6) + ' MHz' : (r / 1e3) + ' kHz';

mount.innerHTML = `
<h2>Logic Analyzer <span style="color:#8ab;font-size:0.6em">8 ch · 3.3 V</span></h2>
<div class="siggen-box la">
  <div class="la-top">
    <div class="la-lcd">
      <div class="la-ann">
        <span id="la-a-run">STOP</span><span id="la-a-busy">ACQ</span><span id="la-a-ext" title="capture made by another client (test, MCP, another dashboard)">EXT</span><span id="la-a-ch" class="on">—</span>
        <span id="la-a-rate" class="on">—</span><span id="la-a-dur" class="on">—</span>
        <span id="la-a-trg" title="trigger: WAIT = armed, waiting for the condition">TRIG</span><span id="la-a-lim">LIMIT</span><span id="la-a-ovr">OVR</span><span id="la-a-trunc">TRUNC</span><span id="la-a-hi">⚠ RATE</span>
      </div>
      <div class="la-val stale" id="la-val">-.-----<span class="la-unit">Hz</span></div>
      <div class="la-sub"><span id="la-sub-l"></span><span id="la-sub-r"></span></div>
      <div class="la-bar"><div class="la-bar-mid"></div><div class="la-bar-fill" id="la-bar" style="width:0"></div></div>
      <div class="la-bar-scale"><span>duty 0%</span><span>50%</span><span>100%</span></div>
    </div>
    <div class="la-stats">
      <span class="k">Freq min</span><span class="v" id="la-s-fmin">—</span>
      <span class="k">Freq max</span><span class="v" id="la-s-fmax">—</span>
      <span class="k">Freq avg</span><span class="v" id="la-s-favg">—</span>
      <span class="k">Freq σ</span><span class="v" id="la-s-fsd">—</span>
      <span class="k">Duty min / max</span><span class="v" id="la-s-dmm">—</span>
      <span class="k">Duty avg</span><span class="v" id="la-s-davg">—</span>
      <span class="k">Captures</span><span class="v" id="la-s-n">0</span>
      <span class="k">Limit fails</span><span class="v" id="la-s-fail">—</span>
      <canvas id="la-trend" title="frequency per capture"></canvas>
      <div class="full"><span id="la-s-since">since —</span>
        <button type="button" id="la-reset" style="background:#0f3460;color:#aaa;border:1px solid #333;padding:3px 10px;border-radius:4px;cursor:pointer">Reset stats</button></div>
    </div>
  </div>
  <div class="siggen-row">
    <button type="button" id="la-single" class="run" title="One capture">Single</button>
    <button type="button" id="la-run" title="Capture repeatedly">Run</button>
    <span class="la-sep"></span>
    <label>Rate</label><select id="la-rate"></select>
    <label>Length</label><select id="la-dur">${DURATIONS.map(d => '<option value="' + d + '">' + fmtDur(d) + '</option>').join('')}</select>
    <label>Measure</label><select id="la-meas"></select>
    <span id="la-samples" style="color:#8ab;font-size:0.85em"></span>
  </div>
  <div class="siggen-row">
    <label title="Wait for a condition before keeping data (software trigger on the Pi)"><input type="checkbox" id="la-trg"> Trigger</label>
    <select id="la-tch"></select><select id="la-tcond">${CONDS.map(c => '<option value="' + c[0] + '">' + c[1] + '</option>').join('')}</select>
    <label>Pre</label><select id="la-tpre">${PRE_MS.map(d => '<option value="' + d + '">' + fmtDur(d) + '</option>').join('')}</select>
    <label>Timeout</label><select id="la-ttmo">${TIMEOUTS.map(d => '<option value="' + d + '">' + fmtDur(d) + '</option>').join('')}</select>
    <span style="color:#556;font-size:0.8em">Length = window after the trigger</span>
    <span class="la-sep"></span>
    <button type="button" id="la-levels" title="Level of the enabled channels right now (20 ms capture)">Levels</button>
    <span class="la-lv" id="la-lv"></span>
  </div>
  <div class="siggen-row">
    <label>Channels</label><span class="la-chips" id="la-chips"></span>
    <span style="color:#556;font-size:0.8em">click = on/off · double-click = rename</span>
  </div>
  <div class="siggen-row">
    <label><input type="checkbox" id="la-lim"> Limits</label>
    <label>f</label><input type="number" id="la-flo" step="any" placeholder="min Hz"><input type="number" id="la-fhi" step="any" placeholder="max Hz">
    <label>duty</label><input type="number" id="la-dlo" step="any" placeholder="min %"><input type="number" id="la-dhi" step="any" placeholder="max %">
    <span class="la-sep"></span>
    <button type="button" id="la-csv" title="Edges of every channel, Pi-clock timestamps">CSV</button>
    <button type="button" id="la-vcd" title="Value change dump: opens in PulseView / GTKWave">VCD</button>
    <button type="button" id="la-json" title="Raw service response">JSON</button>
  </div>
  <div class="siggen-row">
    <button type="button" id="la-fit" title="Show the whole capture (double-click on the trace does the same)">Fit</button>
    <button type="button" id="la-zin">Zoom +</button><button type="button" id="la-zout">Zoom −</button>
    <button type="button" id="la-curclr" title="Remove cursors">Clear A/B</button>
    <label><input type="checkbox" id="la-abs"> Clock time</label>
    <span class="la-sep"></span>
    <span class="la-cur" id="la-cur">click = cursor A · shift-click / right-click = B · drag = pan · wheel = zoom</span>
  </div>
  <div class="la-wave-wrap" id="la-wrap"><canvas id="la-cv"></canvas><div class="la-empty" id="la-empty">no capture yet — press Single</div><div class="la-tip" id="la-tip"></div></div>
  <table class="la-tbl" id="la-tbl"></table>
  <div class="la-foot"><span id="la-info">—</span><span id="la-err"></span></div>
</div>`;
const $ = id => document.getElementById(id);

// ── state ─────────────────────────────────────────────────────────────
let status = null, cap = null, busy = false, running = false, visible = true, timer = null;
let view = {a: 0, b: 1};                     // visible time span, s from first sample
let curA = null, curB = null, hover = null;  // cursor times (s)
let geo = null;                              // last drawn geometry
let st, trend = [];
let trg = {state: null, armedAt: null};        // our own trigger: null | 'wait' | 'trig' | 'none'
const trigSpec = () => prefs.trg ? probe(prefs.tch) + '=' + prefs.tcond : null;
function resetStats() { st = {n: 0, fm: 0, fm2: 0, fmin: Infinity, fmax: -Infinity, dn: 0, dm: 0, dmin: Infinity, dmax: -Infinity, fail: 0, t0: Date.now()}; trend = []; }
resetStats();

// ── helpers ───────────────────────────────────────────────────────────
function fmtT(s, digits) {
    if (s === null || s === undefined || !isFinite(s)) return '—';
    const a = Math.abs(s), d = digits === undefined ? 4 : digits;
    if (a === 0) return '0 s';
    if (a >= 1) return s.toFixed(d) + ' s';
    if (a >= 1e-3) return (s * 1e3).toFixed(Math.max(0, d - 1)) + ' ms';
    if (a >= 1e-6) return (s * 1e6).toFixed(Math.max(0, d - 2)) + ' µs';
    return (s * 1e9).toFixed(1) + ' ns';
}
function fmtF(f, sig) {
    if (f === null || f === undefined || !isFinite(f)) return {n: '—', u: 'Hz'};
    const [div, u] = f >= 1e6 ? [1e6, 'MHz'] : f >= 1e3 ? [1e3, 'kHz'] : [1, 'Hz'];
    const v = f / div, s = sig || 6;
    const dec = Math.max(0, s - 1 - Math.floor(Math.log10(Math.max(Math.abs(v), 1e-12))));
    return {n: v.toFixed(Math.min(dec, 9)), u};
}
const fmtFs = (f, sig) => { const x = fmtF(f, sig); return x.n === '—' ? '—' : x.n + ' ' + x.u; };
function clockStr(epochMs) {
    const d = new Date(epochMs), us = Math.round((epochMs % 1000) * 1000);
    return d.toLocaleTimeString() + '.' + String(Math.floor(us / 1000)).padStart(3, '0') + String(us % 1000).padStart(3, '0');
}
const chName = i => 'D' + i;
const probe = i => 'CH' + (i + 1);
function label(i) {
    if (prefs.labels[chName(i)] !== undefined) return prefs.labels[chName(i)];
    const c = status && status.channels && status.channels[i];
    return (c && c.label) || '';
}
async function api(path, body) {
    const r = await fetch(API + path, body === undefined ? {} :
        {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)});
    let j;
    try { j = await r.json(); } catch (e) { throw new Error('HTTP ' + r.status); }
    if (!j.ok) { const err = new Error(j.error || r.status); err.code = r.status; throw err; }
    return j;
}
function setErr(msg, cls) { $('la-err').textContent = msg || ''; $('la-err').className = msg ? (cls || 'err') : ''; }
function limits() {
    const n = x => { const v = parseFloat(x); return isFinite(v) ? v : null; };
    return {on: prefs.lim, flo: n(prefs.flo), fhi: n(prefs.fhi), dlo: n(prefs.dlo), dhi: n(prefs.dhi)};
}
function judge(ch) {                           // null = no limits, true = pass, false = fail
    const L = limits();
    if (!L.on || !ch) return null;
    const f = ch.frequency_hz, d = ch.duty_pct;
    if ((L.flo !== null || L.fhi !== null) && !isFinite(f)) return false;
    if ((L.dlo !== null || L.dhi !== null) && !isFinite(d)) return false;
    if (L.flo !== null && f < L.flo) return false;
    if (L.fhi !== null && f > L.fhi) return false;
    if (L.dlo !== null && d < L.dlo) return false;
    if (L.dhi !== null && d > L.dhi) return false;
    return true;
}

// ── status / controls setup ───────────────────────────────────────────
function fillRates() {
    const rates = (status && status.samplerates) || FALLBACK_RATES;
    const rel = (status && status.max_reliable_samplerate) || 12e6;
    $('la-rate').innerHTML = rates.map(r => '<option value="' + r + '">' + fmtRate(r) + (r > rel ? ' ⚠' : '') + '</option>').join('');
    if (!rates.includes(prefs.rate)) prefs.rate = 1e6;
    $('la-rate').value = String(prefs.rate);
}
function renderChips() {
    $('la-chips').innerHTML = [0, 1, 2, 3, 4, 5, 6, 7].map(i =>
        '<button type="button" class="la-chip' + (prefs.chans.includes(i) ? ' on' : '') + '" data-i="' + i + '" title="' +
        chName(i) + ' — double-click to rename"><i style="background:' + COLORS[i] + '"></i>' + probe(i) +
        (label(i) ? ' · ' + label(i) : '') + '</button>').join('');
    $('la-tch').innerHTML = [0, 1, 2, 3, 4, 5, 6, 7].map(i => '<option value="' + i + '">' + probe(i) + (label(i) ? ' ' + label(i) : '') + '</option>').join('');
    $('la-tch').value = String(prefs.tch);
    $('la-meas').innerHTML = prefs.chans.map(i => '<option value="' + i + '">' + probe(i) + (label(i) ? ' ' + label(i) : '') + '</option>').join('');
    if (!prefs.chans.includes(prefs.meas)) prefs.meas = prefs.chans[0];
    $('la-meas').value = String(prefs.meas);
}
function renderSamples() {
    const n = prefs.rate * (prefs.dur + (prefs.trg ? prefs.ttmo : 0)) / 1000, rel = (status && status.max_reliable_samplerate) || 12e6;
    const mb = n / 1e6;
    $('la-samples').textContent = (mb >= 1 ? mb.toFixed(mb < 10 ? 1 : 0) + ' M' : (n / 1e3).toFixed(0) + ' k') + ' samples · ' +
        'resolution ' + fmtT(1 / prefs.rate, 3) + (n > MAX_SAMPLES ? ' · too long (max 200 M)' : '') +
        (prefs.rate > rel ? ' · may overrun on a Pi 3' : '');
    $('la-samples').style.color = n > MAX_SAMPLES ? '#e74c3c' : prefs.rate > rel ? '#e67e22' : '#8ab';
}
function renderAnn() {
    $('la-a-run').className = running ? 'good' : '';
    $('la-a-run').textContent = running ? 'RUN' : 'STOP';
    $('la-a-busy').className = busy ? 'warn' : '';
    $('la-a-ch').textContent = prefs.chans.length + ' CH';
    const ext = cap && cap.ext && !running;          // following someone else's capture
    $('la-a-rate').textContent = fmtRate(ext ? cap.rate : prefs.rate);
    $('la-a-dur').textContent = ext ? fmtT(cap.dur, 2) : fmtDur(prefs.dur);
    const other = status && status.busy && status.busy_client && status.busy_client !== 'dashboard';
    const ej = other && status.job && !status.job.done && status.job.trigger ? status.job : null;
    $('la-a-ext').className = other ? 'warn' : ext ? 'on' : '';
    $('la-a-ext').textContent = ej ? 'EXT WAIT · ' + ej.client + ' · ' + ej.trigger :
        other ? 'EXT ACQ · ' + status.busy_client : ext ? 'EXT · ' + cap.ext : 'EXT';
    // trigger: ours while it runs, otherwise what the shown capture did
    const t = trg.state === 'wait' ? 'wait' : cap && cap.raw.trigger ? (cap.raw.triggered ? 'trig' : 'none') : null;
    $('la-a-trg').className = t === 'wait' ? 'warn' : t === 'trig' ? 'good' : t === 'none' ? 'bad' : prefs.trg ? 'on' : '';
    $('la-a-trg').textContent = t === 'wait' ? 'WAIT ' + (trigSpec() || '') : t === 'trig' ? "TRIG'D " + cap.raw.trigger.spec :
        t === 'none' ? 'NO TRIG' : prefs.trg ? 'TRIG ' + trigSpec() : 'TRIG';
    const rel = (status && status.max_reliable_samplerate) || 12e6;
    $('la-a-hi').className = prefs.rate > rel ? 'warn' : '';
    $('la-run').textContent = running ? 'Stop' : 'Run';
    $('la-run').className = running ? 'stop' : '';
    $('la-single').disabled = busy || running;
    $('la-levels').disabled = busy || running;
    $('la-trg').checked = prefs.trg;
    $('la-tcond').value = prefs.tcond; $('la-tpre').value = String(prefs.tpre); $('la-ttmo').value = String(prefs.ttmo);
    ['la-tch', 'la-tcond', 'la-tpre', 'la-ttmo'].forEach(id => { $(id).disabled = !prefs.trg || running; });
    $('la-abs').checked = prefs.abs;
    $('la-lim').checked = prefs.lim;
    for (const k of ['flo', 'fhi', 'dlo', 'dhi']) $('la-' + k).value = prefs[k];
    ['la-rate', 'la-dur'].forEach(id => { $(id).disabled = running; });
    $('la-dur').value = String(prefs.dur);
}
async function loadStatus() {
    try {
        status = await api('/api/logic/status');
        $('la-info').textContent = (status.present ? (status.device || 'fx2lafw device').replace(/ with \d+ channels.*/, '') : 'logic analyzer not found') +
            ' · probes CH1..CH8 = D0..D7 · max reliable ' + fmtRate(status.max_reliable_samplerate) +
            ' · timestamps = Pi clock';
        setErr(status.present ? '' : 'logic analyzer not detected on the Pi USB');
    } catch (e) { setErr('status: ' + e.message); }
    fillRates(); renderChips(); renderSamples(); renderAnn();
    decorateSlots();
}

// ── acquisition ───────────────────────────────────────────────────────
async function capture() {
    if (busy) return;
    if (!prefs.chans.length) { setErr('enable at least one channel'); return; }
    busy = true; renderAnn(); $('la-val').classList.add('busy');
    const labels = {};
    prefs.chans.forEach(i => { if (label(i)) labels[chName(i)] = label(i); });
    const body = {samplerate: prefs.rate, duration_ms: prefs.dur, channels: prefs.chans.map(chName), labels,
        max_edges: prefs.maxEdges, client: 'dashboard', cycles: MAX_CYCLES};
    try {
        let j;
        if (prefs.trg) {
            Object.assign(body, {trigger: trigSpec(), pre_ms: prefs.tpre, timeout_ms: prefs.ttmo});
            const a = await api('/api/logic/arm', body);
            trg = {state: 'wait', armedAt: Date.now()}; renderAnn();
            do { j = await api('/api/logic/result?id=' + a.capture_id + '&wait_s=1'); } while (!j.done);
        } else {
            j = await api('/api/logic/capture', body);
        }
        trg.state = null;
        ingest(j);
        setErr(j.trigger && !j.triggered ? 'no trigger (' + j.trigger.spec + ') within ' + fmtDur(j.trigger.timeout_ms) : j.warning || '',
               'warn');
    } catch (e) {
        trg.state = null;
        if (e.code === 409) setErr('analyzer busy (another client is capturing) — retrying', 'warn');
        else { setErr('capture: ' + e.message); if (running) stop(); }
    }
    busy = false; $('la-val').classList.remove('busy'); renderAnn();
    if (!running) refreshStatus();                  // slot card: last capture, counters
    if (running && visible) timer = setTimeout(capture, 150);
}
// live = our own capture (feeds the stats); otherwise one made by someone
// else (test, MCP, another browser) that the card is following.
function ingest(j, live = true) {
    const prevDur = cap ? cap.dur : null;
    const chans = j.channels.map(c => {
        const i = +c.channel.slice(1), n = c.edges.length;
        const E = new Float64Array(n), Lv = new Uint8Array(n);
        c.edges.forEach((e, k) => { E[k] = e[0]; Lv[k] = e[1]; });
        return Object.assign(c, {i, E, Lv, tTrunc: c.edges_truncated && n ? E[n - 1] : null});
    });
    cap = {raw: j, chans, dur: j.duration_s, rate: j.samplerate, t0: j.t0_epoch_ms, at: Date.now(),
           ext: live ? null : (j.client || 'api'),
           trigT: j.trigger && j.triggered ? j.trigger.trigger_s : null};
    // keep the zoom across repeated captures of the same length, else fit
    if (prevDur === null || Math.abs(prevDur - cap.dur) > 1e-9 || view.b > cap.dur) fit();
    if (curA !== null && curA > cap.dur) curA = null;
    if (curB !== null && curB > cap.dur) curB = null;
    const m = measCh();
    if (live && m && !m.static && isFinite(m.frequency_hz)) {
        const f = m.frequency_hz;
        st.n++; const d = f - st.fm; st.fm += d / st.n; st.fm2 += d * (f - st.fm);
        st.fmin = Math.min(st.fmin, f); st.fmax = Math.max(st.fmax, f);
        if (isFinite(m.duty_pct)) {
            st.dn++; st.dm += (m.duty_pct - st.dm) / st.dn;
            st.dmin = Math.min(st.dmin, m.duty_pct); st.dmax = Math.max(st.dmax, m.duty_pct);
        }
        trend.push(f); if (trend.length > TREND_MAX) trend.shift();
    }
    if (live && judge(m) === false) st.fail++;
    $('la-empty').style.display = 'none';
    renderAll();
}
const measCh = () => cap && cap.chans.find(c => c.i === prefs.meas);

// ── rendering: LCD, stats, table ──────────────────────────────────────
function renderDisplay() {
    const m = measCh(), el = $('la-val');
    const ok = judge(m), lim = $('la-a-lim');
    lim.className = ok === null ? '' : ok ? 'good' : 'bad';
    lim.textContent = ok === null ? 'LIMIT' : ok ? 'PASS' : 'FAIL';
    $('la-a-ovr').className = cap && cap.raw.overrun ? 'bad' : '';
    $('la-a-trunc').className = cap && cap.chans.some(c => c.edges_truncated) ? 'warn' : '';
    if (!m) { el.innerHTML = '-.-----<span class="la-unit">Hz</span>'; el.className = 'la-val stale'; $('la-sub-l').textContent = ''; $('la-bar').style.width = '0'; return; }
    if (m.static || !isFinite(m.frequency_hz)) {
        const lvl = m.static ? (m.initial_level ? 'HIGH' : 'LOW') : (m.edge_count + ' edge' + (m.edge_count === 1 ? '' : 's'));
        el.innerHTML = lvl + '<span class="la-unit">' + (m.static ? 'static' : '') + '</span>';
        el.className = 'la-val static';
        $('la-sub-l').textContent = probe(m.i) + (m.label ? ' ' + m.label : '') + ' · no full period in ' + fmtT(cap.dur, 3);
        $('la-bar').style.width = m.static && m.initial_level ? '100%' : '0';
    } else {
        const f = fmtF(m.frequency_hz, 7);
        el.innerHTML = f.n + '<span class="la-unit">' + f.u + '</span>';
        el.className = 'la-val';
        $('la-sub-l').textContent = probe(m.i) + (m.label ? ' ' + m.label : '') + ' · T ' + fmtT(m.period_s.mean, 5) +
            (isFinite(m.duty_pct) ? ' · duty ' + m.duty_pct.toFixed(3) + ' %' : '');
        const bar = $('la-bar');
        bar.style.width = (isFinite(m.duty_pct) ? m.duty_pct : 0) + '%';
        bar.style.background = ok === false ? '#e67e22' : '#00d4ff';
    }
    $('la-sub-r').textContent = cap ? (cap.ext ? cap.ext + ' · ' : '') + clockStr(cap.t0) : '';
}
function renderStats() {
    const has = st.n > 0;
    $('la-s-fmin').textContent = has ? fmtFs(st.fmin, 7) : '—';
    $('la-s-fmax').textContent = has ? fmtFs(st.fmax, 7) : '—';
    $('la-s-favg').textContent = has ? fmtFs(st.fm, 7) : '—';
    $('la-s-fsd').textContent = st.n > 1 ? (Math.sqrt(st.fm2 / (st.n - 1)) / st.fm * 1e6).toFixed(1) + ' ppm' : '—';
    $('la-s-dmm').textContent = st.dn ? st.dmin.toFixed(3) + ' / ' + st.dmax.toFixed(3) + ' %' : '—';
    $('la-s-davg').textContent = st.dn ? st.dm.toFixed(3) + ' %' : '—';
    $('la-s-n').textContent = st.n;
    $('la-s-fail').textContent = limits().on ? String(st.fail) : '—';
    $('la-s-since').textContent = 'since ' + new Date(st.t0).toLocaleTimeString();
    drawTrend();
}
function drawTrend() {
    const c = $('la-trend'), g = c.getContext('2d'), W = c.clientWidth, H = c.clientHeight, dpr = window.devicePixelRatio || 1;
    if (!W) return;
    if (c.width !== W * dpr) { c.width = W * dpr; c.height = H * dpr; }
    g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, W, H);
    g.strokeStyle = '#16213e'; g.strokeRect(0.5, 0.5, W - 1, H - 1);
    if (trend.length < 2) return;
    let lo = Math.min(...trend), hi = Math.max(...trend);
    if (hi - lo < hi * 1e-9) { lo -= hi * 1e-6; hi += hi * 1e-6; }
    g.strokeStyle = '#00d4ff'; g.lineWidth = 1.2; g.beginPath();
    trend.forEach((f, k) => {
        const x = 2 + k / (trend.length - 1) * (W - 4), y = H - 3 - (f - lo) / (hi - lo) * (H - 6);
        k ? g.lineTo(x, y) : g.moveTo(x, y);
    });
    g.stroke();
    g.fillStyle = '#667'; g.font = '10px monospace'; g.textBaseline = 'top';
    g.fillText('Δ ' + ((hi - lo) / st.fm * 1e6).toFixed(1) + ' ppm', 4, 2);
}
function renderTable() {
    if (!cap) { $('la-tbl').innerHTML = ''; return; }
    const head = '<tr><th>Ch</th><th>Label</th><th>State</th><th>Frequency</th><th>Period (σ)</th><th>Duty</th>' +
        '<th>High</th><th>Low</th><th title="duty of each full cycle (rising to rising): time-proportional outputs">Cycle duty min–max</th><th>Edges</th></tr>';
    const rws = rows().map(c => {
        if (c.missing) return '<tr data-i="' + c.i + '"' + (c.i === prefs.meas ? ' class="sel"' : '') + '><td>' +
            '<i style="display:inline-block;width:8px;height:8px;border-radius:50%;background:' + COLORS[c.i] + ';margin-right:6px"></i>' +
            probe(c.i) + '</td><td>' + (c.label || '<span class="dim">' + chName(c.i) + '</span>') +
            '</td><td class="dim" colspan="8" style="text-align:left">not in this capture</td></tr>';
        const ok = c.i === prefs.meas ? judge(c) : null;
        const state = c.static ? '<span class="dim">static ' + (c.initial_level ? 'HIGH' : 'LOW') + '</span>'
            : ok === false ? '<span class="bad">FAIL</span>' : ok ? '<span class="good">PASS</span>' : 'toggling';
        const p = c.period_s;
        return '<tr data-i="' + c.i + '"' + (c.i === prefs.meas ? ' class="sel"' : '') + '>' +
            '<td><i style="display:inline-block;width:8px;height:8px;border-radius:50%;background:' + COLORS[c.i] + ';margin-right:6px"></i>' + probe(c.i) + '</td>' +
            '<td>' + (c.label || '<span class="dim">' + chName(c.i) + '</span>') + '</td><td>' + state + '</td>' +
            '<td>' + fmtFs(c.frequency_hz, 7) + '</td>' +
            '<td>' + (p ? fmtT(p.mean, 5) + ' <span class="dim">(' + fmtT(p.std, 2) + ')</span>' : '—') + '</td>' +
            '<td>' + (isFinite(c.duty_pct) ? c.duty_pct.toFixed(3) + ' %' : '—') + '</td>' +
            '<td>' + (c.high_s ? fmtT(c.high_s.mean, 5) : '—') + '</td>' +
            '<td>' + (c.low_s ? fmtT(c.low_s.mean, 5) : '—') + '</td>' +
            '<td>' + cycleDuty(c) + '</td>' +
            '<td>' + c.edge_count + (c.edges_truncated ? ' <span class="dim">(' + c.edges.length + ' shown)</span>' : '') + '</td></tr>';
    });
    $('la-tbl').innerHTML = head + rws.join('');
}
function cycleDuty(c) {
    const cy = c.cycles;
    if (!cy || !cy.length) return '—';
    const d = cy.map(x => x[3]), lo = Math.min(...d), hi = Math.max(...d);
    return lo.toFixed(2) + '–' + hi.toFixed(2) + ' % <span class="dim">(' + cy.length + ')</span>';
}
function renderCursors() {
    const el = $('la-cur');
    if (curA === null && curB === null) {
        el.innerHTML = 'click = cursor A · shift-click / right-click = B · drag = pan · wheel = zoom';
        return;
    }
    let h = '';
    if (curA !== null) h += '<span class="a">A</span> <b>' + tlabel(curA) + '</b>  ';
    if (curB !== null) h += '<span class="b">B</span> <b>' + tlabel(curB) + '</b>  ';
    if (curA !== null && curB !== null) {
        const d = Math.abs(curB - curA), lo = Math.min(curA, curB), hi = Math.max(curA, curB);
        h += 'Δ <b>' + fmtT(d, 5) + '</b>  1/Δ <b>' + (d > 0 ? fmtFs(1 / d, 6) : '—') + '</b>';
        const m = measCh();
        if (m) {
            const n = countEdges(m, lo, hi);
            h += '  ' + probe(m.i) + ' edges in A–B <b>' + n.all + '</b> (↑' + n.up + ' ↓' + n.down + ')';
        }
    }
    el.innerHTML = h;
}
function countEdges(c, lo, hi) {
    let all = 0, up = 0;
    for (let k = lowerBound(c.E, lo); k < c.E.length && c.E[k] <= hi; k++) { all++; if (c.Lv[k]) up++; }
    return {all, up, down: all - up};
}
function renderAll() { renderAnn(); renderDisplay(); renderStats(); renderTable(); renderCursors(); draw(); }

// ── rendering: waveforms ──────────────────────────────────────────────
const cv = $('la-cv'), ctx = cv.getContext('2d');
const ROW = 38, TOPPAD = 8, AXIS = 24, LEFT = 104, RIGHT = 14;
function lowerBound(A, t) { let lo = 0, hi = A.length; while (lo < hi) { const m = (lo + hi) >> 1; if (A[m] < t) lo = m + 1; else hi = m; } return lo; }
function levelAt(c, t) { const k = lowerBound(c.E, t) - 1; return k >= 0 ? c.Lv[k] : c.initial_level; }
function niceStep(span, n) {
    const raw = span / n, p = Math.pow(10, Math.floor(Math.log10(raw)));
    return [1, 2, 5, 10].map(m => m * p).find(s => s >= raw) || raw;
}
function tlabel(t) { return prefs.abs && cap ? clockStr(cap.t0 + t * 1000) : fmtT(t, 6); }
// Rows follow the channel selection, not the capture: a channel switched on
// after the last capture shows a placeholder until the next one.
function rows() {
    return prefs.chans.map(i => (cap && cap.chans.find(c => c.i === i)) ||
        {i, label: label(i), E: new Float64Array(0), missing: true});
}
function draw() {
    const R = rows(), wrap = $('la-wrap');
    const Hwant = TOPPAD + Math.max(1, R.length) * ROW + AXIS;
    if (wrap.clientHeight !== Hwant) wrap.style.height = Hwant + 'px';
    const W = cv.clientWidth, H = cv.clientHeight, dpr = window.devicePixelRatio || 1;
    if (!W || !H) return;
    if (cv.width !== W * dpr || cv.height !== H * dpr) { cv.width = W * dpr; cv.height = H * dpr; }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const pw = W - LEFT - RIGHT, ph = R.length * ROW;
    const {a, b} = view, X = t => LEFT + (t - a) / (b - a) * pw;
    geo = {pw, ph, X, T: x => a + (x - LEFT) / pw * (b - a)};
    // time grid
    ctx.font = '11px monospace'; ctx.lineWidth = 1;
    const ts = niceStep(b - a, Math.max(2, Math.floor(pw / 110)));
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    for (let t = Math.ceil(a / ts) * ts; t <= b + ts * 1e-6; t += ts) {
        const x = Math.round(X(t)) + 0.5;
        ctx.strokeStyle = '#16213e'; ctx.beginPath(); ctx.moveTo(x, TOPPAD); ctx.lineTo(x, TOPPAD + ph); ctx.stroke();
        ctx.fillStyle = '#667';
        const tw = 46;                         // keep edge labels inside the canvas
        ctx.textAlign = x + tw > W ? 'right' : 'center';
        ctx.fillText(prefs.abs && cap ? clockStr(cap.t0 + t * 1000).slice(-12) : fmtT(t, 3), x, TOPPAD + ph + 6);
    }
    ctx.strokeStyle = '#0f3460'; ctx.strokeRect(LEFT + 0.5, TOPPAD + 0.5, pw, ph);
    // channel rows
    R.forEach((c, r) => {
        const y0 = TOPPAD + r * ROW, yHi = y0 + 8, yLo = y0 + ROW - 8, col = COLORS[c.i];
        if (r) { ctx.strokeStyle = '#16213e'; ctx.beginPath(); ctx.moveTo(LEFT, y0 + 0.5); ctx.lineTo(LEFT + pw, y0 + 0.5); ctx.stroke(); }
        ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
        ctx.fillStyle = col; ctx.font = 'bold 11px monospace'; ctx.fillText(probe(c.i), 8, y0 + ROW / 2 - 7);
        ctx.fillStyle = '#8ab'; ctx.font = '11px monospace'; ctx.fillText((c.label || chName(c.i)).slice(0, 12), 8, y0 + ROW / 2 + 7);
        if (c.i === prefs.meas) { ctx.fillStyle = col; ctx.fillRect(0, y0 + 6, 3, ROW - 12); }
        if (!cap) return;
        if (c.missing) {
            ctx.fillStyle = '#556'; ctx.textAlign = 'left';
            ctx.fillText('not in this capture — press Single / Run', LEFT + 10, y0 + ROW / 2);
            return;
        }
        ctx.save(); ctx.beginPath(); ctx.rect(LEFT, y0, pw, ROW); ctx.clip();
        const Y = l => l ? yHi : yLo;
        let lvl = levelAt(c, a), k = lowerBound(c.E, a);
        const tEnd = Math.min(b, c.tTrunc !== null ? c.tTrunc : b, cap.dur);
        let x = LEFT, segStart = X(Math.max(a, 0)), lastCol = -1;
        const dense = [];
        ctx.strokeStyle = col; ctx.lineWidth = 1.5; ctx.fillStyle = col + '22';
        ctx.beginPath(); ctx.moveTo(segStart, Y(lvl));
        for (; k < c.E.length && c.E[k] <= tEnd; k++) {
            x = X(c.E[k]); const cx = Math.round(x);
            if (cx === lastCol) { dense.push(cx); lvl = c.Lv[k]; continue; }
            if (lvl) ctx.fillRect(segStart, yHi, x - segStart, yLo - yHi);
            ctx.lineTo(x, Y(lvl)); lvl = c.Lv[k]; ctx.lineTo(x, Y(lvl));
            segStart = x; lastCol = cx;
        }
        const xe = X(tEnd);
        if (lvl) ctx.fillRect(segStart, yHi, xe - segStart, yLo - yHi);
        ctx.lineTo(xe, Y(lvl)); ctx.stroke();
        if (dense.length) {                    // many edges per pixel: solid bar
            ctx.fillStyle = col;
            for (const cx of dense) ctx.fillRect(cx, yHi, 1, yLo - yHi);
        }
        if (c.tTrunc !== null && c.tTrunc < b) {   // edges beyond max_edges not transferred
            const xs = X(c.tTrunc);
            ctx.fillStyle = 'rgba(102,102,119,0.18)'; ctx.fillRect(xs, y0 + 2, LEFT + pw - xs, ROW - 4);
            ctx.fillStyle = '#889'; ctx.textAlign = 'left'; ctx.fillText('edges not transferred (' + c.edge_count + ' total)', xs + 6, y0 + ROW / 2);
        }
        if (cap.dur < b) { const xd = X(cap.dur); ctx.fillStyle = 'rgba(231,76,60,0.12)'; ctx.fillRect(xd, y0, LEFT + pw - xd, ROW); }
        ctx.restore();
    });
    // cursors + hover
    const vline = (t, color, name, dash) => {
        if (t === null || t < a || t > b) return;
        const x = Math.round(X(t)) + 0.5;
        ctx.save(); if (dash) ctx.setLineDash(dash); ctx.strokeStyle = color;
        ctx.beginPath(); ctx.moveTo(x, TOPPAD); ctx.lineTo(x, TOPPAD + ph); ctx.stroke(); ctx.restore();
        if (name) { ctx.fillStyle = color; ctx.font = 'bold 11px monospace'; ctx.textAlign = 'left'; ctx.textBaseline = 'top'; ctx.fillText(name, x + 3, TOPPAD + 2); }
    };
    if (curA !== null && curB !== null) {
        const xa = X(Math.max(a, Math.min(curA, curB))), xb = X(Math.min(b, Math.max(curA, curB)));
        if (xb > xa) { ctx.fillStyle = 'rgba(240,160,48,0.07)'; ctx.fillRect(xa, TOPPAD, xb - xa, ph); }
    }
    if (cap && cap.trigT !== null) vline(cap.trigT, '#f1c40f', 'T', [5, 3]);
    vline(curA, '#f0a030', 'A'); vline(curB, '#c39bd3', 'B');
    if (hover !== null) vline(hover, '#556', null, [3, 3]);
}

// ── waveform interaction ──────────────────────────────────────────────
function fit() { view = {a: 0, b: cap ? cap.dur : 1}; }
function clampView(a, b) {
    const total = cap ? cap.dur : 1, minSpan = cap ? 10 / cap.rate : 1e-6;
    let span = Math.max(minSpan, Math.min(total, b - a));
    a = Math.max(0, Math.min(a, total - span));
    view = {a, b: a + span};
}
function zoomAt(t, f) { const {a, b} = view; clampView(t - (t - a) * f, t + (b - t) * f); draw(); }
function snap(x, y) {                        // nearest edge of the row under the mouse, within 6 px
    const t = geo.T(x);
    if (!cap) return t;
    const r = Math.floor((y - TOPPAD) / ROW), c = rows()[r];
    if (!c || !c.E.length) return t;
    const k = lowerBound(c.E, t);
    let best = null;
    for (const j of [k - 1, k]) if (j >= 0 && j < c.E.length && (best === null || Math.abs(c.E[j] - t) < Math.abs(best - t))) best = c.E[j];
    return best !== null && Math.abs(geo.X(best) - x) <= 6 ? best : t;
}
let drag = null;
cv.addEventListener('mousedown', e => { if (e.button === 0) drag = {x: e.clientX, a: view.a, b: view.b, moved: false}; });
window.addEventListener('mousemove', e => {
    if (!drag || !geo) return;
    const dx = e.clientX - drag.x;
    if (Math.abs(dx) > 3) { drag.moved = true; cv.classList.add('drag'); }
    if (drag.moved) { const dt = dx / geo.pw * (drag.b - drag.a); clampView(drag.a - dt, drag.b - dt); draw(); }
});
window.addEventListener('mouseup', e => {
    if (!drag) return;
    const d = drag; drag = null; cv.classList.remove('drag');
    if (d.moved || !cap) return;
    const r = cv.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
    if (x < LEFT) return;
    const t = snap(x, y);
    if (e.shiftKey) curB = t; else curA = t;
    renderCursors(); draw();
});
cv.addEventListener('contextmenu', e => {
    e.preventDefault();
    if (!cap) return;
    const r = cv.getBoundingClientRect(), x = e.clientX - r.left;
    if (x < LEFT) return;
    curB = snap(x, e.clientY - r.top); renderCursors(); draw();
});
cv.addEventListener('dblclick', () => { fit(); draw(); });
cv.addEventListener('wheel', e => {
    if (!cap || !geo) return;
    e.preventDefault();
    const r = cv.getBoundingClientRect(), x = e.clientX - r.left;
    zoomAt(geo.T(Math.max(LEFT, x)), e.deltaY > 0 ? 1.25 : 0.8);
}, {passive: false});
cv.addEventListener('mousemove', e => {
    const tip = $('la-tip');
    if (!cap || !geo || drag && drag.moved) { tip.style.display = 'none'; return; }
    const r = cv.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
    if (x < LEFT || x > LEFT + geo.pw) { tip.style.display = 'none'; hover = null; draw(); return; }
    const t = snap(x, y);
    hover = t;
    const lines = [tlabel(t) + (prefs.abs ? '' : '   ' + clockStr(cap.t0 + t * 1000))];
    for (const c of rows()) lines.push(probe(c.i).padEnd(4) + ' ' + (c.label || chName(c.i)).padEnd(10).slice(0, 10) + ' ' +
        (c.missing || (c.tTrunc !== null && t > c.tTrunc) ? '?' : levelAt(c, t)));
    tip.textContent = lines.join('\n');
    tip.style.display = 'block';
    tip.style.left = Math.min(x + 14, r.width - tip.offsetWidth - 4) + 'px';
    tip.style.top = Math.max(4, Math.min(y - 10, r.height - tip.offsetHeight - 4)) + 'px';
    draw();
});
cv.addEventListener('mouseleave', () => { $('la-tip').style.display = 'none'; hover = null; draw(); });
window.addEventListener('resize', () => { draw(); drawTrend(); });

// ── export ────────────────────────────────────────────────────────────
function download(name, text, type) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], {type}));
    a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
const stamp = () => new Date(cap.t0).toISOString().replace(/[:.]/g, '-').slice(0, 19);
function exportCsv() {
    if (!cap) return;
    const ev = [];
    for (const c of cap.chans) for (let k = 0; k < c.E.length; k++) ev.push([c.E[k], c, c.Lv[k]]);
    ev.sort((p, q) => p[0] - q[0]);
    const out = ['# t0_epoch_ms=' + cap.t0 + ' samplerate=' + cap.rate + ' duration_s=' + cap.dur +
        ' initial=' + cap.chans.map(c => chName(c.i) + ':' + c.initial_level).join(' '),
        'epoch_ms,t_s,channel,probe,label,level'];
    for (const [t, c, l] of ev) out.push((cap.t0 + t * 1000).toFixed(6) + ',' + t + ',' + chName(c.i) + ',' + probe(c.i) + ',' + (c.label || '') + ',' + l);
    download('logic-' + stamp() + '.csv', out.join('\n') + '\n', 'text/csv');
}
function exportVcd() {
    if (!cap) return;
    const ids = cap.chans.map((c, k) => String.fromCharCode(33 + k));
    const name = c => (c.label ? c.label + '_' : '') + probe(c.i);
    const out = ['$date ' + new Date(cap.t0).toISOString() + ' $end', '$version hil-instruments logic panel $end',
        '$comment t0_epoch_ms=' + cap.t0 + ' samplerate=' + cap.rate + ' $end', '$timescale 1 ns $end',
        '$scope module logic $end'];
    cap.chans.forEach((c, k) => out.push('$var wire 1 ' + ids[k] + ' ' + name(c).replace(/\s+/g, '_') + ' $end'));
    out.push('$upscope $end', '$enddefinitions $end', '#0', '$dumpvars');
    cap.chans.forEach((c, k) => out.push(c.initial_level + ids[k]));
    out.push('$end');
    const ev = [];
    cap.chans.forEach((c, k) => { for (let j = 0; j < c.E.length; j++) ev.push([Math.round(c.E[j] * 1e9), ids[k], c.Lv[j]]); });
    ev.sort((p, q) => p[0] - q[0]);
    let last = -1;
    for (const [t, id, l] of ev) { if (t !== last) { out.push('#' + t); last = t; } out.push(l + id); }
    out.push('#' + Math.round(cap.dur * 1e9));
    download('logic-' + stamp() + '.vcd', out.join('\n') + '\n', 'text/plain');
}
function exportJson() { if (cap) download('logic-' + stamp() + '.json', JSON.stringify(cap.raw, null, 1), 'application/json'); }

// ── controls ──────────────────────────────────────────────────────────
function start() { if (running) return; running = true; renderAnn(); clearTimeout(timer); capture(); }
function stop() { running = false; clearTimeout(timer); renderAnn(); }
$('la-single').onclick = () => { if (!running) capture(); };
$('la-run').onclick = () => running ? stop() : start();
async function readLevels() {
    if (busy) return;
    busy = true; renderAnn();
    try {
        const j = await api('/api/logic/state?client=dashboard&channels=' + prefs.chans.map(probe).join(','));
        $('la-lv').innerHTML = Object.entries(j.levels).map(([p, v]) =>
            '<span class="' + (!v.stable ? 'tg' : v.level ? 'hi' : 'lo') + '" title="' + (v.stable ? 'stable for 20 ms' :
                v.edges + ' edges in 20 ms' + (v.frequency_hz ? ' · ' + fmtFs(v.frequency_hz, 5) : '')) + '">' + p +
            (v.label ? ' ' + v.label : '') + ' ' + (!v.stable ? '⇅' : v.level ? 'HIGH' : 'LOW') + '</span>').join('') +
            '<span style="border:none;background:none;color:#556">' + new Date(j.at_epoch_ms).toLocaleTimeString() + '</span>';
        setErr('');
    } catch (e) { setErr(e.code === 409 ? 'analyzer busy (another client is capturing)' : 'levels: ' + e.message, 'warn'); }
    busy = false; renderAnn();
}
$('la-levels').onclick = readLevels;
$('la-trg').onchange = e => { prefs.trg = e.target.checked; savePrefs(); renderSamples(); renderAnn(); };
$('la-tch').onchange = e => { prefs.tch = +e.target.value; savePrefs(); renderAnn(); };
$('la-tcond').onchange = e => { prefs.tcond = e.target.value; savePrefs(); renderAnn(); };
$('la-tpre').onchange = e => { prefs.tpre = +e.target.value; savePrefs(); };
$('la-ttmo').onchange = e => { prefs.ttmo = +e.target.value; savePrefs(); renderSamples(); };
$('la-rate').onchange = e => { prefs.rate = +e.target.value; savePrefs(); renderSamples(); renderAnn(); };
$('la-dur').onchange = e => { prefs.dur = +e.target.value; savePrefs(); renderSamples(); renderAnn(); };
$('la-meas').onchange = e => { prefs.meas = +e.target.value; savePrefs(); resetStats(); renderAll(); };
$('la-chips').onclick = e => {
    const b = e.target.closest('.la-chip'); if (!b) return;
    const i = +b.dataset.i;
    clearTimeout(b._t);                          // wait: a double-click renames instead
    b._t = setTimeout(() => {
        prefs.chans = prefs.chans.includes(i) ? prefs.chans.filter(x => x !== i) : [...prefs.chans, i].sort();
        if (!prefs.chans.length) prefs.chans = [i];   // keep at least one
        savePrefs(); renderChips(); renderAll();
    }, 250);
};
$('la-chips').ondblclick = e => {
    const b = e.target.closest('.la-chip'); if (!b) return;
    clearTimeout(b._t);
    const i = +b.dataset.i, v = prompt('Label for ' + probe(i) + ' (' + chName(i) + '), e.g. the DUT pin:', label(i));
    if (v === null) return;
    prefs.labels[chName(i)] = v.trim(); savePrefs(); renderChips();
    if (cap) { const c = cap.chans.find(x => x.i === i); if (c) c.label = v.trim(); renderAll(); } else draw();
};
$('la-tbl').onclick = e => {
    const tr = e.target.closest('tr[data-i]'); if (!tr) return;
    prefs.meas = +tr.dataset.i; savePrefs(); resetStats(); renderChips(); renderAll();
};
$('la-lim').onchange = e => { prefs.lim = e.target.checked; st.fail = 0; savePrefs(); renderAll(); };
for (const k of ['flo', 'fhi', 'dlo', 'dhi']) $('la-' + k).onchange = e => { prefs[k] = e.target.value; st.fail = 0; savePrefs(); renderAll(); };
$('la-reset').onclick = () => { resetStats(); renderStats(); };
$('la-fit').onclick = () => { fit(); draw(); };
$('la-zin').onclick = () => zoomAt((view.a + view.b) / 2, 0.5);
$('la-zout').onclick = () => zoomAt((view.a + view.b) / 2, 2);
$('la-curclr').onclick = () => { curA = curB = null; renderCursors(); draw(); };
$('la-abs').onchange = e => { prefs.abs = e.target.checked; savePrefs(); renderCursors(); draw(); };
$('la-csv').onclick = exportCsv;
$('la-vcd').onclick = exportVcd;
$('la-json').onclick = exportJson;

// Hidden card: stop repeating captures (the analyzer is shared with scripts/MCP).
mount.addEventListener('dash-panel-visibility', e => {
    visible = !!e.detail.visible;
    clearTimeout(timer);
    if (visible) { draw(); drawTrend(); if (running && !busy) capture(); }
});

// ── USB slot card ─────────────────────────────────────────────────────
// The portal draws one card per USB port (renderSlots, every 5 s) and only
// knows "product + VID:PID": the analyzer's port read "ABSENT / No device
// connected". We wrap renderSlots (as dashboard_panels does for fetchSiggen)
// and fill the analyzer's card with what sysfs and sigrok know about it.
const FX2_IDS = ['0925:3881', '1d50:608c', '04b4:8613'];
const slotCss = `
.slot.la-slot { border-color: #00d4ff55; }
.slot .status.la-instr { background: #0f3460; color: #00d4ff; }
.slot .status.la-busy { background: #e67e22; color: #fff; }
.slot .la-sinfo div { margin: 2px 0; }
.slot .la-sinfo .k { color: #8ab; }
.slot .la-sinfo .d { color: #667; }
.slot .la-sinfo .h { color: #8ab; font-size: 0.78em; text-transform: uppercase; letter-spacing: 0.05em; margin-top: 8px; border-top: 1px solid #0f3460; padding-top: 6px; }
.slot .url-box.la-open { cursor: pointer; color: #00d4ff; }
.slot .url-box.la-open:hover { background: #0f3460; }
`;
const sst = document.createElement('style');
sst.textContent = slotCss;
document.head.appendChild(sst);
let lastSlots = null;
const esc = s => String(s === null || s === undefined ? '' : s).replace(/[&<>"]/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[c]));
function rateSpan(rs) { return rs && rs.length ? fmtRate(rs[0]) + ' – ' + fmtRate(rs[rs.length - 1]) : '—'; }
const TRIG = {'0': 'low', '1': 'high', r: 'rising', f: 'falling', e: 'any edge'};
function slotInfoHtml(s) {
    const u = status.usb || {}, d = status.details || {}, v = status.versions || {}, sv = status.service || {};
    const row = (k, val, dim) => '<div><span class="k">' + k + ':</span> <span>' + val + '</span>' + (dim ? ' <span class="d">' + dim + '</span>' : '') + '</div>';
    const speed = u.speed_mbps === 480 ? 'High-Speed 480 Mb/s' : u.speed_mbps ? u.speed_mbps + ' Mb/s' + (u.speed_mbps < 480 ? ' ⚠ not high-speed' : '') : '—';
    const labels = [0, 1, 2, 3, 4, 5, 6, 7].filter(i => label(i)).map(i => probe(i) + ' ' + esc(label(i)));
    let h = '<div class="h">Device</div>' +
        row('Instrument', esc(d.model || u.product || 'fx2lafw device'), (d.channel_count || 8) + ' ch logic analyzer') +
        row('Chip', esc(d.fx2_chip || 'Cypress FX2'), d.fx2_revid !== undefined ? 'REVID ' + d.fx2_revid : '') +
        row('Firmware', 'fx2lafw ' + esc(d.fx2lafw_version || '?'), (v.fx2lafw_package ? 'pkg ' + esc(v.fx2lafw_package) : '') +
            (d.firmware_uploaded ? ' · uploaded at plug-in' : ' · resident')) +
        row('Serial', esc(d.sigrok_serial || u.serial || '—'), esc(u.manufacturer || '')) +
        '<div class="h">USB</div>' +
        row('ID', esc(u.vid_pid || '—'), 'bcdDevice ' + esc(u.bcd_device || '?')) +
        row('Link', 'USB ' + esc((u.usb_version || '').trim() || '?') + ' ' + speed, esc(u.max_power || '')) +
        row('Port', esc(u.sysfs || '—') + ' (' + esc(u.usb_prefix || '') + ')', 'sigrok conn ' + esc(u.busnum) + '.' + esc(u.devnum)) +
        row('RFC2217', s.tcp_port || '-', 'unused — not a serial device') +
        '<div class="h">Capabilities</div>' +
        row('Sample rate', rateSpan(d.device_samplerates), d.device_samplerates ? d.device_samplerates.length + ' steps' : '') +
        row('On this Pi', '≤ ' + fmtRate(status.max_reliable_samplerate || 12e6) + ' reliable', 'USB shared with Ethernet') +
        row('Triggers', (d.triggers || []).map(t => TRIG[t] || t).join(', ') || '—', 'not used yet') +
        row('Channels', 'CH1..CH8 = D0..D7', labels.length ? labels.join(' · ') : 'no labels') +
        row('Software', 'libsigrok ' + esc(v.libsigrok || '?'), 'sigrok-cli ' + esc(v.sigrok_cli || '?')) +
        '<div class="h">Service</div>' +
        row('hil-instruments', ':8081 · ' + (status.busy ? '<span style="color:#e67e22">capturing</span>' : 'ready'),
            (sv.captures || 0) + ' captures, ' + (sv.overruns || 0) + ' overruns since ' +
            (sv.since_epoch_ms ? new Date(sv.since_epoch_ms).toLocaleTimeString() : '—'));
    const L = sv.last;
    if (L) {
        const m = (L.channels || []).find(c => !c.static && isFinite(c.frequency_hz)) || (L.channels || [])[0];
        h += row('Last capture', new Date(L.at_epoch_ms).toLocaleTimeString() + ' · ' + fmtRate(L.samplerate) + ' × ' + fmtT(L.duration_s, 2) +
            (L.overrun ? ' <span style="color:#e74c3c">OVR</span>' : ''),
            m ? m.probe + (m.label ? ' ' + esc(m.label) : '') + ' ' + (m.static ? 'static ' + (m.initial_level ? 'HIGH' : 'LOW')
                : fmtFs(m.frequency_hz, 6) + (isFinite(m.duty_pct) ? ' / ' + m.duty_pct.toFixed(1) + ' %' : '')) : '');
    }
    return h;
}
function decorateSlots() {
    const box = document.getElementById('slots');
    if (!box || !lastSlots || !status || !status.present) return;
    lastSlots.forEach((s, k) => {
        if (!(s.usb_devices || []).some(dv => FX2_IDS.includes(dv.vid_pid))) return;
        const card = box.children[k];
        if (!card) return;
        card.classList.remove('absent'); card.classList.add('la-slot');
        const pill = card.querySelector('.status');
        if (pill) { pill.className = 'status ' + (status.busy ? 'la-busy' : 'la-instr'); pill.textContent = status.busy ? 'CAPTURING' : 'LOGIC ANALYZER'; }
        const info = card.querySelector('.slot-info');
        if (info) { info.classList.add('la-sinfo'); info.innerHTML = slotInfoHtml(s); }
        const url = card.querySelector('.url-box');
        if (url) {
            url.className = 'url-box la-open';
            url.textContent = '▸ Open the Logic Analyzer card';
            url.onclick = () => {
                if (mount.style.display === 'none') {
                    const chip = [...document.querySelectorAll('.dash-chip')].find(c => c.textContent.trim() === 'Logic Analyzer');
                    if (chip) chip.click();
                }
                mount.scrollIntoView({behavior: 'smooth', block: 'start'});
            };
        }
    });
}
(function hookSlots() {
    const orig = window.renderSlots;
    if (typeof orig !== 'function' || orig._la) return;
    const wrapped = function (slots) { orig.apply(this, arguments); lastSlots = slots; decorateSlots(); };
    wrapped._la = true;
    window.renderSlots = wrapped;
})();
async function refreshStatus() {
    try { status = await api('/api/logic/status'); } catch (e) { return; /* service down: leave the cards stock */ }
    decorateSlots();
    renderAnn();
    // Follow mode: show captures made by others (tests, MCP) while we are idle.
    const L = status.service && status.service.last;
    if (L && !running && !busy && visible && (!cap || L.at_epoch_ms !== cap.raw.captured_at_epoch_ms)) {
        try { ingest(await api('/api/logic/last'), false); setErr(''); } catch (e) { /* raced with a new capture */ }
    }
}
// 1 s while the card is visible (follow tests live), 5 s otherwise (slot card only).
let tick = 0;
setInterval(() => { if (visible || ++tick % 5 === 0) refreshStatus(); }, 1000);
// The portal drew the slots before this script loaded: decorate now, not at its next refresh.
fetch('/api/devices').then(r => r.json()).then(j => { if (!lastSlots && j.slots) { lastSlots = j.slots; decorateSlots(); } }).catch(() => {});

// Show the last capture made by anyone (MCP, tests) when the page opens.
loadStatus().then(async () => {
    try { const j = await api('/api/logic/last'); ingest(j, false); } catch (e) { /* none yet */ }
    renderAll();
});
})();
