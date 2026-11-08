// Compares ONE section of an original localized template with the same section of our React rebuild:
// element screenshots, the measured box of each, and a side-by-side picture. Local only.
//
//   node MORENE/ops/e2e/section-compare.mjs <site> --orig "<css selector in the original>" --rebuild "<css selector in our page>" [--width 1440] [--out <dir>]
//
// Example: node MORENE/ops/e2e/section-compare.mjs chalant --orig 'section[data-framer-name="Hero"]' --rebuild '[data-section="hero"]' --width 1440
// Our rebuilt root elements should carry data-section="<name>" so the selector stays stable.
// Output: <out>/<site>-<name>-<width>-{original,rebuild,side}.png (default out: MORENE/ops/e2e/out/section) and one line with both boxes and the difference.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.argv.includes('--help') || process.argv.length < 5) {
  console.log('usage: section-compare.mjs <site> --orig "<selector>" --rebuild "<selector>" [--width 1440] [--out dir] [--page /showcase/<site>]');
  process.exit(process.argv.length < 5 ? 2 : 0);
}
const HERE = path.dirname(fileURLToPath(import.meta.url));
const UI = path.resolve(HERE, '../../../MORENE UI');
const site = process.argv[2];
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d; };
const orig = arg('orig'); const rebuild = arg('rebuild');
if (!orig || !rebuild) { console.error('give --orig and --rebuild selectors'); process.exit(2); }
const width = Number(arg('width', 1440));
const out = path.resolve(arg('out', path.join(HERE, 'out', 'section')));
const page = arg('page', `/showcase/${site}`);
const dirs = { safah: 'localized/safah', chalant: 'localized/chalant', dewskincare: 'localized/dewskincare', mirea: 'localized/mirea', raydiant: 'localized/raydiant', 'house-of-honey': 'www.houseofhoney.com', 'palazzo-sogni': 'www.palazzosogni.com' };
if (!dirs[site]) { console.error('unknown site: ' + Object.keys(dirs).join(', ')); process.exit(2); }
fs.mkdirSync(out, { recursive: true });

const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.avif': 'image/avif', '.gif': 'image/gif', '.mp4': 'video/mp4', '.webm': 'video/webm', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf' };
const roots = [path.join(UI, dirs[site]), path.join(UI, 'public')];
const server = http.createServer((req, res) => {
  let rel = decodeURIComponent((req.url || '/').split('?')[0]); if (rel.endsWith('/')) rel += 'index.html';
  for (const root of roots) {
    const file = path.normalize(path.join(root, rel));
    if (!file.startsWith(root)) continue;
    try { if (fs.statSync(file).isFile()) { res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' }); fs.createReadStream(file).pipe(res); return; } } catch { /* next root */ }
  }
  res.writeHead(404); res.end('not found');
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const originalUrl = `http://127.0.0.1:${server.address().port}/index.html`;

const { chromium } = await import('playwright');
const browser = await chromium.launch();
const name = String(rebuild).replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').slice(0, 40);

async function shoot(label, url, selector) {
  const ctx = await browser.newContext({ viewport: { width, height: 900 } });
  const p = await ctx.newPage();
  await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await p.waitForTimeout(2500);
  // scroll through the page so lazy media and scroll-triggered reveals have run
  await p.evaluate(async () => { const step = Math.max(300, Math.floor(innerHeight * 0.6)); for (let y = 0; y < document.body.scrollHeight; y += step) { scrollTo(0, y); await new Promise((r) => setTimeout(r, 140)); } });
  const el = p.locator(selector).first();
  const count = await p.locator(selector).count();
  if (!count) { await ctx.close(); return { label, error: `selector matched nothing: ${selector}` }; }
  await el.scrollIntoViewIfNeeded();
  await p.waitForTimeout(1200);
  const box = await el.boundingBox();
  const styles = await el.evaluate((n) => { const c = getComputedStyle(n); return { bg: c.backgroundColor, color: c.color, font: `${c.fontFamily.split(',')[0]} ${c.fontSize}/${c.lineHeight} ${c.fontWeight}`, padding: c.padding }; });
  const file = path.join(out, `${site}-${name}-${width}-${label}.png`);
  await el.screenshot({ path: file });
  await ctx.close();
  return { label, file, w: Math.round(box.width), h: Math.round(box.height), styles };
}

const a = await shoot('original', originalUrl, orig);
const b = await shoot('rebuild', `http://localhost:3001${page}`, rebuild);
for (const r of [a, b]) {
  if (r.error) console.log(`${r.label}: ERROR ${r.error}`);
  else console.log(`${r.label.padEnd(8)} ${r.w} x ${r.h}px  bg ${r.styles.bg}  text ${r.styles.color}  font ${r.styles.font}  padding ${r.styles.padding}`);
}
if (a.file && b.file) {
  const ctx = await browser.newContext({ viewport: { width: width * 2 + 20, height: 900 } });
  const p = await ctx.newPage();
  const b64 = (f) => fs.readFileSync(f).toString('base64');
  await p.setContent(`<body style="margin:0;background:#888;display:flex;gap:20px;align-items:flex-start"><div><div style="font:14px sans-serif;color:#fff;padding:4px">ORIGINAL ${a.w}x${a.h}</div><img style="width:${width}px;display:block" src="data:image/png;base64,${b64(a.file)}"></div><div><div style="font:14px sans-serif;color:#fff;padding:4px">REBUILD ${b.w}x${b.h}</div><img style="width:${width}px;display:block" src="data:image/png;base64,${b64(b.file)}"></div></body>`);
  const side = path.join(out, `${site}-${name}-${width}-side.png`);
  await p.screenshot({ path: side, fullPage: true });
  await ctx.close();
  const dh = ((b.h - a.h) / a.h * 100).toFixed(1); const dw = ((b.w - a.w) / a.w * 100).toFixed(1);
  console.log(`difference: width ${dw}%  height ${dh}%   (aim: within 2%)`);
  console.log(`side by side: ${path.relative(process.cwd(), side)}`);
}
await browser.close(); server.close();
