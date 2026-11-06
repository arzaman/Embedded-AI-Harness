// Bench digital I/O panel (8 channels DI/DO/PWM/ADC) for the testbench dashboard.
// Served by hil-instruments (:8081), loaded by pi/dashboard_panels.py.
// New classes are prefixed "io-".
(function () {
'use strict';
const script = document.currentScript;
const API = script.src.replace(/\/panel\/io\.js.*$/, '');
const mount = document.getElementById(script.dataset.mount || 'panel-io');
if (!mount) return;

const POLL_MS = 500;
const MODES = ['DI', 'DO', 'PWM', 'ADC'];
const css = `
.io-tab { width: 100%; border-collapse: collapse; font-size: 0.9em; }
.io-tab th { color: #8ab; font-weight: normal; text-align: left; padding: 4px 8px; border-bottom: 1px solid #0f3460; }
.io-tab td { padding: 5px 8px; border-bottom: 1px solid #16213e; }
.io-tab td.v { font-family: monospace; color: #e0e0e0; }
.io-led { display: inline-block; width: 14px; height: 14px; border-radius: 50%; background: #223; border: 1px solid #334; vertical-align: middle; }
.io-led.on { background: #2ecc71; border-color: #2ecc71; box-shadow: 0 0 6px #2ecc71; }
.io-led.out.on { background: #00d4ff; border-color: #00d4ff; box-shadow: 0 0 6px #00d4ff; }
.io-led.pwm { background: linear-gradient(90deg, #f0a030 50%, #223 50%); border-color: #f0a030; }
.io-tab select, .io-tab input { background: #16213e; color: #e0e0e0; border: 1px solid #0f3460; border-radius: 4px; padding: 2px 4px; }
.io-tab input[type=number] { width: 64px; }
.io-tab button { background: #0f3460; color: #cfe; border: 1px solid #2a4070; font-weight: bold; border-radius: 4px; padding: 3px 10px; cursor: pointer; }
.io-tab button.on { background: #00d4ff; color: #1a1a2e; border-color: #00d4ff; }
.io-foot { color: #666; font-size: 0.78em; margin-top: 8px; display: flex; justify-content: space-between; flex-wrap: wrap; gap: 8px; }
.io-foot .err { color: #ff6b6b; }
.io-foot .warn { color: #e67e22; }
`;
const style = document.createElement('style');
style.textContent = css;
document.head.appendChild(style);

mount.innerHTML = `
<h2>Bench I/O <span style="color:#8ab;font-size:0.6em">8 ch · 3.3 V</span></h2>
<div class="siggen-box">
  <table class="io-tab">
    <thead><tr><th>Ch</th><th>Mode</th><th>Level</th><th>Value</th><th>Control</th></tr></thead>
    <tbody id="io-body"></tbody>
  </table>
  <div class="io-foot"><span id="io-info">—</span><span id="io-err"></span></div>
  <div class="io-foot"><span class="warn">DO drives the pin: set that channel's direction switch on the panel to OUT first.
    An open DI reads 1.</span></div>
</div>`;

const $ = id => document.getElementById(id);
let visible = true, timer = null, built = false, status = null;

async function api(path, body) {
    const r = await fetch(API + path, body === undefined ? {} :
        {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)});
    const j = await r.json();
    if (!j.ok) throw new Error(j.error || r.status);
    return j;
}
function setErr(m) { $('io-err').textContent = m || ''; $('io-err').className = m ? 'err' : ''; }

function build() {
    $('io-body').innerHTML = [0, 1, 2, 3, 4, 5, 6, 7].map(c => `
      <tr id="io-r${c}">
        <td>IO${c}</td>
        <td><select data-c="${c}" class="io-mode">${MODES.map(m => '<option>' + m + '</option>').join('')}</select></td>
        <td><span class="io-led" id="io-led${c}"></span></td>
        <td class="v" id="io-val${c}">—</td>
        <td id="io-ctl${c}"></td>
      </tr>`).join('');
    mount.querySelectorAll('.io-mode').forEach(s => {
        s.onchange = e => act('/api/io/mode', {channel: +e.target.dataset.c, mode: e.target.value});
    });
    built = true;
}
function ctl(c, mode, ch) {
    const cell = $('io-ctl' + c);
    if (cell.dataset.mode === mode) {               // keep focus/typing; just sync state
        if (mode === 'DO') cell.querySelector('button').className = ch.level ? 'on' : '';
        return;
    }
    cell.dataset.mode = mode;
    if (mode === 'DO') {
        cell.innerHTML = '<button type="button">Toggle</button>';
        cell.querySelector('button').onclick = () => {
            const lv = status && status.channels[c].level;
            act('/api/io/write', {channel: c, level: lv ? 0 : 1});
        };
    } else if (mode === 'PWM') {
        cell.innerHTML = '<input type="number" min="0" max="100" step="1" value="' + (ch.duty_pct || 0) + '"> % <button type="button">Set</button>';
        const inp = cell.querySelector('input');
        const go = () => act('/api/io/pwm', {channel: c, duty_pct: +inp.value});
        cell.querySelector('button').onclick = go;
        inp.onkeydown = e => { if (e.key === 'Enter') go(); };
    } else {
        cell.innerHTML = '';
    }
}
function render(r) {
    status = r;
    if (!built) build();
    r.channels.forEach(ch => {
        const c = ch.channel, sel = mount.querySelector('.io-mode[data-c="' + c + '"]');
        if (document.activeElement !== sel) sel.value = ch.mode;
        const led = $('io-led' + c);
        led.className = 'io-led' + (ch.mode === 'DO' ? ' out' : '') + (ch.mode === 'PWM' ? ' pwm' : '') +
            (ch.level ? ' on' : '');
        $('io-val' + c).textContent = ch.mode === 'ADC' ? ch.volts.toFixed(3) + ' V (' + ch.adc + ')'
            : ch.mode === 'PWM' ? ch.duty_pct + ' % @ 1 kHz' : String(ch.level);
        ctl(c, ch.mode, ch);
    });
}
async function act(path, body) {
    try { await api(path, body); setErr(''); } catch (e) { setErr(String(e.message || e)); }
    poll();
}
async function info() {
    try {
        const s = await api('/api/io/status');
        $('io-info').textContent = s.model + ' @' + s.address + ' · FW ' + s.firmware +
            ' · unit resets seen: ' + s.resets + (s.in_sync ? '' : ' · OUT OF SYNC');
    } catch (e) { setErr(String(e.message || e)); }
}
async function poll() {
    clearTimeout(timer);
    if (!visible) return;
    try { render(await api('/api/io/read')); setErr(''); } catch (e) { setErr(String(e.message || e)); }
    if (status && status.reset_detected) info();
    timer = setTimeout(poll, POLL_MS);
}
mount.addEventListener('dash-panel-visibility', e => { visible = !!e.detail.visible; if (visible) { info(); poll(); } else clearTimeout(timer); });
setInterval(() => { if (visible) info(); }, 5000);
info();
poll();
})();
