// Builds mobile/www from the shared desktop UI (../src/renderer) for the Android app.
// - copies index.html / styles.css / app.js / space.js
// - adds a phone viewport and android-bridge.js (implements window.byte on top of the native plugin)
// - relaxes the CSP for Capacitor's injected bridge script
// - adds licenses.html
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..', '..');
const src = path.join(root, 'src', 'renderer');
const out = path.resolve(__dirname, '..', 'www');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
for (const f of fs.readdirSync(src)) fs.copyFileSync(path.join(src, f), path.join(out, f));
fs.copyFileSync(path.resolve(__dirname, '..', 'src', 'android-bridge.js'), path.join(out, 'android-bridge.js'));

let html = fs.readFileSync(path.join(out, 'index.html'), 'utf8');
const csp = /<meta http-equiv="Content-Security-Policy"[^>]*>/;
if (!csp.test(html)) throw new Error('CSP meta not found in index.html');
html = html.replace(csp, `<meta http-equiv="Content-Security-Policy" content="default-src 'self' https://localhost capacitor: ; script-src 'self' 'unsafe-inline' https://localhost capacitor: ; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:;" />`);
html = html.replace('<meta charset="utf-8" />', '<meta charset="utf-8" />\n  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />');
if (!html.includes('<script src="app.js"></script>')) throw new Error('app.js script tag not found');
html = html.replace('<script src="app.js"></script>', '<script src="android-bridge.js"></script>\n  <script src="app.js"></script>');
fs.writeFileSync(path.join(out, 'index.html'), html);

// licenses page (plain text, readable on a phone)
const esc = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const parts = [
  ['Byte Monitor license', fs.readFileSync(path.join(root, 'LICENSE'), 'utf8')],
  ['Third-party notices', fs.readFileSync(path.join(root, 'THIRD-PARTY-NOTICES.md'), 'utf8')],
  ['Android components', 'Capacitor (core, android, filesystem, share) — MIT — https://github.com/ionic-team/capacitor\nAndroidX / Jetpack libraries — Apache-2.0 — https://developer.android.com/jetpack/androidx\n\nThe Windows-only components listed above (smartctl, sensor helper, PawnIO) are not part of the Android app.'],
  ...fs.readdirSync(path.join(root, 'licenses')).sort().map((f) => [f, fs.readFileSync(path.join(root, 'licenses', f), 'utf8')]),
];
fs.writeFileSync(path.join(out, 'licenses.html'), `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><title>Licenses</title>
<style>body{margin:0;background:#060b10;color:#e3f2f5;font:14px/1.5 system-ui,sans-serif;padding:calc(env(safe-area-inset-top) + 16px) 16px calc(env(safe-area-inset-bottom) + 40px)}a{color:#2ee6c9;font-weight:600}h2{color:#2ee6c9;font-size:15px;margin:26px 0 8px}pre{white-space:pre-wrap;word-break:break-word;font:12px/1.5 ui-monospace,monospace;color:#a9c3cc;background:#0d1a22;border:1px solid #1a2e3a;border-radius:10px;padding:12px}</style></head>
<body><a href="index.html">← Back to Byte Monitor</a>${parts.map(([t, b]) => `<h2>${esc(t)}</h2><pre>${esc(b)}</pre>`).join('')}</body></html>`);
console.log('www built:', fs.readdirSync(out).join(', '));
