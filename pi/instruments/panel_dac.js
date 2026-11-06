// Bench DAC panel (GP8413, 2 x 0-5/0-10 V) for the testbench dashboard.
// Served by hil-instruments (:8081), loaded by pi/dashboard_panels.py.
// Styling reuses the portal classes (h2, .siggen-box, .siggen-row); new
// classes are prefixed "dac-".
(function () {
'use strict';
const script = document.currentScript;
const API = script.src.replace(/\/panel\/dac\.js.*$/, '');
const mount = document.getElementById(script.dataset.mount || 'panel-dac');
if (!mount) return;

const css = `
.dac-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 14px; margin-bottom: 10px; }
.dac-ch { background: #0a0a1a; border: 1px solid #0f3460; border-radius: 10px; padding: 12px 16px; }
.dac-ch h3 { margin: 0 0 6px; color: #8ab; font-size: 0.9em; font-weight: normal; display: flex; justify-content: space-between; }
.dac-val { font-family: 'Consolas', 'DejaVu Sans Mono', monospace; font-size: 2.6em; color: #00d4ff; text-align: right; }
.dac-val .u { font-size: 0.45em; color: #8ab; margin-left: 6px; }
.dac-ch input[type=range] { width: 100%; }
.dac-row { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; margin-top: 6px; }
.dac-row input[type=number] { width: 90px; }
.dac .siggen-row button, .dac-row button { background: #0f3460; color: #cfe; border: 1px solid #2a4070; font-weight: bold;
    border-radius: 4px; padding: 4px 10px; cursor: pointer; }
.dac-row button.go { background: #28a745; color: #fff; border-color: #28a745; }
.dac-foot { color: #666; font-size: 0.78em; display: flex; justify-content: space-between; flex-wrap: wrap; gap: 8px; }
.dac-foot .err { color: #ff6b6b; }
`;
const style = document.createElement('style');
style.textContent = css;
document.head.appendChild(style);

const chHtml = ch => `
  <div class="dac-ch">
    <h3><span>DAC${ch} · VOUT${ch}</span><span id="dac-code${ch}">code —</span></h3>
    <div class="dac-val"><span id="dac-v${ch}">-.----</span><span class="u">V</span></div>
    <input type="range" id="dac-sl${ch}" min="0" max="10" step="0.01" value="0">
    <div class="dac-row">
      <input type="number" id="dac-in${ch}" min="0" max="10" step="0.001" value="0">
      <button type="button" class="go" id="dac-set${ch}">Set</button>
      <button type="button" data-ch="${ch}" data-v="0">0</button>
      <button type="button" data-ch="${ch}" data-v="1">1</button>
      <button type="button" data-ch="${ch}" data-v="2.5">2.5</button>
      <button type="button" data-ch="${ch}" data-v="3.3">3.3</button>
      <button type="button" data-ch="${ch}" data-v="5">5</button>
      <button type="button" data-ch="${ch}" data-v="10">10</button>
    </div>
  </div>`;

mount.innerHTML = `
<h2>Bench DAC <span style="color:#8ab;font-size:0.6em">DC source 0–10 V</span></h2>
<div class="siggen-box dac">
  <div class="dac-grid">${chHtml(0)}${chHtml(1)}</div>
  <div class="siggen-row">
    <button type="button" id="dac-off">Both 0 V</button>
  </div>
  <div class="dac-foot"><span id="dac-info">—</span><span id="dac-err"></span></div>
</div>`;

const $ = id => document.getElementById(id);
let st = null, visible = true, timer = null;

async function api(path, body) {
    const r = await fetch(API + path, body === undefined ? {} :
        {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)});
    const j = await r.json();
    if (!j.ok) throw new Error(j.error || r.status);
    return j;
}
function setErr(m) { $('dac-err').textContent = m || ''; $('dac-err').className = m ? 'err' : ''; }

function render(s) {
    st = s;
    const top = s.max_v;
    [0, 1].forEach(ch => {
        const v = s.volts[ch];
        $('dac-v' + ch).textContent = v === null ? '-.----' : v.toFixed(4);
        $('dac-code' + ch).textContent = 'code ' + (s.codes[ch] === null ? '—' : s.codes[ch]);
        [$('dac-sl' + ch), $('dac-in' + ch)].forEach(el => { el.max = top; });
        if (document.activeElement !== $('dac-in' + ch)) $('dac-in' + ch).value = v === null ? 0 : +v.toFixed(4);
        $('dac-sl' + ch).value = v || 0;
    });
    mount.querySelectorAll('button[data-v]').forEach(b => { b.disabled = +b.dataset.v > top; });
    const cal = Object.entries(s.cal || {}).filter(([, c]) => c.gain !== 1 || c.offset_v !== 0)
        .map(([ch, c]) => 'DAC' + ch + ' cal ×' + c.gain + ' ' + (c.offset_v * 1000).toFixed(1) + ' mV');
    $('dac-info').textContent = s.model + ' @' + s.address + ' · step ' + (s.step_v * 1000).toFixed(2) + ' mV' +
        (s.max_v < s.range_v ? ' · limit ' + s.max_v + ' V' : '') +
        (cal.length ? ' · ' + cal.join(', ') : ' · uncalibrated') + ' · outputs referenced to AGND';
}
async function load() {
    try { render(await api('/api/dac/status')); setErr(''); } catch (e) { setErr(String(e.message || e)); }
}
async function setV(ch, v) {
    try { render(await api('/api/dac/set', {channel: ch, volts: +v})); setErr(''); } catch (e) { setErr(String(e.message || e)); }
}
[0, 1].forEach(ch => {
    $('dac-set' + ch).onclick = () => setV(ch, $('dac-in' + ch).value);
    $('dac-in' + ch).onkeydown = e => { if (e.key === 'Enter') setV(ch, e.target.value); };
    $('dac-sl' + ch).oninput = e => { $('dac-in' + ch).value = e.target.value; };
    $('dac-sl' + ch).onchange = e => setV(ch, e.target.value);
});
mount.querySelectorAll('button[data-ch]').forEach(b => { b.onclick = () => setV(+b.dataset.ch, b.dataset.v); });
$('dac-off').onclick = async () => { try { render(await api('/api/dac/off', {})); setErr(''); } catch (e) { setErr(String(e.message || e)); } };

// Another client (test, MCP) may change the outputs: refresh while visible.
function tick() { clearTimeout(timer); if (!visible) return; load().finally(() => { timer = setTimeout(tick, 3000); }); }
mount.addEventListener('dash-panel-visibility', e => { visible = !!e.detail.visible; tick(); });
tick();
})();
