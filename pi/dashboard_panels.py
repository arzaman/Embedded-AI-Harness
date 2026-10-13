"""Dashboard panel switches and plug-in panels for the portal web UI.

Lets a bench drop the built-in panels it has no hardware for (signal
generator, SDR console) and host panels served by other bench services
(e.g. the multimeter of hil-instruments on :8081) — without those services
having to live inside portal.py.

Config: /etc/rfc2217/dashboard.json (optional; absent = stock dashboard)
  {
    "disabled": ["siggen", "sdr"],
    "panels": [{"id": "meter", "title": "Multimeter", "script": ":8081/panel/meter.js"}]
  }

"disabled" built-ins are neither initialised (no I2C/USB probing at start)
nor shown. The dashboard gets a panel bar: clicking a built-in chip enables
or disables it (backend included, persisted to the config file); clicking a
plug-in chip shows/hides its card (remembered per browser).

A plug-in script ":<port>/<path>" is fetched through the portal itself
(/panels/<port>/<path> -> 127.0.0.1:<port>/<path>), so the page stays
same-origin: no CORS, and only :8080 needs to be reachable. Only ports named
in "panels" are proxied. The script derives its API base from its own src,
finds its mount <div> through document.currentScript.dataset.mount and gets
a 'dash-panel-visibility' event ({detail: {visible}}) on the mount when the
card is shown or hidden.
"""
import json
import os
import re
import threading
import urllib.error
import urllib.request

CONFIG_FILE = os.environ.get("DASHBOARD_CONFIG", "/etc/rfc2217/dashboard.json")
BUILTINS = {
    "siggen": {"title": "Signal Generator", "element": "siggen-section"},
    "sdr": {"title": "SDR Console", "element": "sdr-section"},
}
_lock = threading.Lock()


def load() -> dict:
    try:
        with open(CONFIG_FILE) as f:
            cfg = json.load(f)
    except FileNotFoundError:
        cfg = {}
    except Exception as exc:
        print(f"[dashboard] {CONFIG_FILE}: {exc} — using defaults", flush=True)
        cfg = {}
    return {"disabled": [n for n in cfg.get("disabled", []) if n in BUILTINS],
            "panels": list(cfg.get("panels", []))}


def enabled(name: str) -> bool:
    return name not in load()["disabled"]


def set_enabled(name: str, on: bool) -> dict:
    if name not in BUILTINS:
        raise ValueError(f"unknown panel {name!r}; built-ins: {sorted(BUILTINS)}")
    with _lock:
        try:
            with open(CONFIG_FILE) as f:
                raw = json.load(f)
        except FileNotFoundError:
            raw = {}
        disabled = [n for n in raw.get("disabled", []) if n != name]
        if not on:
            disabled.append(name)
        raw["disabled"] = disabled
        tmp = CONFIG_FILE + ".tmp"
        with open(tmp, "w") as f:
            json.dump(raw, f, indent=2)
            f.write("\n")
        os.replace(tmp, CONFIG_FILE)
    return load()


def _proxy_ports() -> set[int]:
    ports = set()
    for p in load()["panels"]:
        m = re.match(r":(\d+)/", p.get("script", ""))
        if m:
            ports.add(int(m.group(1)))
    return ports


def proxy(handler, body: bytes | None = None) -> None:
    """Forward /panels/<port>/<rest> to a local panel service."""
    m = re.match(r"/panels/(\d+)(/.*)", handler.path)
    if not m or int(m.group(1)) not in _proxy_ports():
        return handler._send_json({"ok": False, "error": "no such panel service"}, 404)
    req = urllib.request.Request(
        f"http://127.0.0.1:{m.group(1)}{m.group(2)}", data=body,
        method="POST" if body is not None else "GET",
        headers={"Content-Type": handler.headers.get("Content-Type", "application/json")})
    try:
        # POSTs can be long measurements (a 30 s logic capture + analysis).
        with urllib.request.urlopen(req, timeout=120 if body is not None else 10) as r:
            status, ctype, data = r.status, r.headers.get("Content-Type"), r.read()
    except urllib.error.HTTPError as e:
        status, ctype, data = e.code, e.headers.get("Content-Type"), e.read()
    except OSError as e:
        return handler._send_json({"ok": False, "error": f"panel service: {e}"}, 502)
    handler.send_response(status)
    handler.send_header("Content-Type", ctype or "application/octet-stream")
    handler.send_header("Cache-Control", "no-cache")
    handler.send_header("Content-Length", str(len(data)))
    handler.end_headers()
    handler.wfile.write(data)


def state(available: dict) -> dict:
    """Config plus whether each built-in backend actually came up."""
    cfg = load()
    return {"builtins": [{"id": k, **v, "enabled": k not in cfg["disabled"],
                          "available": bool(available.get(k))}
                         for k, v in BUILTINS.items()],
            "panels": cfg["panels"]}


def inject(html: str, available: dict) -> str:
    """Add the panel bar loader to the dashboard page."""
    boot = json.dumps(state(available)).replace("</", "<\\/")
    tag = (f"<script>window.DASH_PANELS = {boot};</script>\n"
           f"<style>{_CSS}</style>\n<script>{_JS}</script>\n")
    return html.replace("</body>", tag + "</body>", 1)


_CSS = """
.dash-bar { display: flex; gap: 8px; justify-content: center; flex-wrap: wrap; margin: -8px 0 16px; }
.dash-chip { background: #16213e; color: #8ab; border: 1px solid #0f3460; border-radius: 20px;
    padding: 4px 14px; font-size: 0.82em; font-weight: bold; cursor: pointer; transition: all 0.2s; }
.dash-chip:hover { border-color: #00d4ff; }
.dash-chip.on { background: #0f3460; color: #00d4ff; border-color: #00d4ff; }
.dash-chip.off { color: #555; text-decoration: line-through; }
.dash-chip .dot { display: inline-block; width: 7px; height: 7px; border-radius: 50%;
    background: #444; margin-right: 6px; vertical-align: middle; }
.dash-chip.on .dot { background: #2ecc71; }
.dash-chip.on.nohw .dot { background: #e67e22; }
.dash-panel { margin: 20px 0 0; }
.dash-panel .dash-fail { color: #ff6b6b; text-align: center; padding: 10px; }
"""

_JS = r"""
(function () {
const cfg = window.DASH_PANELS || {builtins: [], panels: []};
const LS = 'dash.hidden';
let hidden = {};
try { hidden = JSON.parse(localStorage.getItem(LS)) || {}; } catch (e) { /* */ }
const saveHidden = () => { try { localStorage.setItem(LS, JSON.stringify(hidden)); } catch (e) { /* */ } };

const bar = document.createElement('div');
bar.className = 'dash-bar';
document.getElementById('subtitle').after(bar);
const anchor = document.querySelector('.log-section');

// Built-ins: chip = backend on/off. A disabled one also stops the page's
// own 5 s status poll for it, which would only collect 503s.
const quiet = {siggen: 'fetchSiggen'};
function applyBuiltin(b) {
    const el = document.getElementById(b.element);
    if (el) el.style.display = b.enabled ? '' : 'none';
    const fn = quiet[b.id];
    if (fn && window[fn]) {
        if (!window['_dash_' + fn]) window['_dash_' + fn] = window[fn];
        window[fn] = b.enabled ? window['_dash_' + fn] : async function () {};
    }
}
async function toggleBuiltin(b, chip) {
    const verb = b.enabled ? 'Disable' : 'Enable';
    if (!confirm(verb + ' ' + b.title + '?\n\n' + (b.enabled
        ? 'Stops its hardware backend and hides the card (saved in dashboard.json).'
        : 'Initialises its hardware backend and shows the card.'))) return;
    chip.disabled = true;
    try {
        const r = await fetch('/api/dashboard/builtin', {method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({id: b.id, enabled: !b.enabled})});
        const j = await r.json();
        if (!j.ok) throw new Error(j.error || r.status);
        Object.assign(b, j.builtins.find(x => x.id === b.id));
        applyBuiltin(b); paintBuiltin(b, chip);
    } catch (e) { alert(b.title + ': ' + e.message); }
    chip.disabled = false;
}
function paintBuiltin(b, chip) {
    chip.className = 'dash-chip ' + (b.enabled ? 'on' : 'off') + (b.enabled && !b.available ? ' nohw' : '');
    chip.title = b.enabled ? (b.available ? 'enabled — click to disable' : 'enabled, but no hardware detected')
                           : 'disabled — click to enable';
}
for (const b of cfg.builtins) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.innerHTML = '<span class="dot"></span>' + b.title;
    chip.onclick = () => toggleBuiltin(b, chip);
    paintBuiltin(b, chip); applyBuiltin(b);
    bar.appendChild(chip);
}

// Plug-in panels: chip = show/hide, script served by another bench service.
for (const p of cfg.panels) {
    const mount = document.createElement('div');
    mount.className = 'dash-panel';
    mount.id = 'panel-' + p.id;
    anchor.before(mount);
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.innerHTML = '<span class="dot"></span>' + (p.title || p.id);
    const show = v => {
        mount.style.display = v ? '' : 'none';
        chip.className = 'dash-chip ' + (v ? 'on' : 'off');
        chip.title = v ? 'shown — click to hide' : 'hidden — click to show';
        mount.dispatchEvent(new CustomEvent('dash-panel-visibility', {detail: {visible: v}}));
    };
    chip.onclick = () => { hidden[p.id] = !hidden[p.id]; saveHidden(); show(!hidden[p.id]); };
    bar.appendChild(chip);
    const s = document.createElement('script');
    s.src = p.script.replace(/^:(\d+)\//, '/panels/$1/');
    s.dataset.mount = mount.id;
    s.onload = () => show(!hidden[p.id]);
    s.onerror = () => {
        mount.innerHTML = '<h2>' + (p.title || p.id) + '</h2><div class="dash-fail">panel unavailable: ' +
            s.src + ' did not load (service down?)</div>';
        show(!hidden[p.id]);
    };
    document.body.appendChild(s);
}
})();
"""
