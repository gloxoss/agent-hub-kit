// Compares how an element MOVES in the original and in our rebuild: when it starts, how long it lasts, how strong it is.
// It triggers the motion (hover, scroll into view, or page load), photographs the element every 60 ms for 1.5 s on both sides,
// measures the change between neighbouring frames (the "motion energy") and prints both curves and a verdict. Local only.
//
//   node MORENE/ops/e2e/motion-compare.mjs <site> --orig "<selector>" --rebuild "<selector>" --trigger hover|scroll|load [--width 1440] [--target "<child selector>"]
//
//   hover   moves the mouse onto the element (or onto --target, a child of it) and records the reaction
//   scroll  scrolls the page to just above the element, then scrolls it into view and records the reveal
//   load    reloads the page and records the element during the first 1.5 s (entrance animations, hero choreography)
// A faithful animation starts within about 120 ms of the original, lasts within about 25 percent of its duration and has a peak energy within 40 percent.
// It also writes a filmstrip picture per side to MORENE/ops/e2e/out/motion/ for the builder to look at.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.argv.includes('--help') || process.argv.length < 6) {
  console.log('usage: motion-compare.mjs <site> --orig "<sel>" --rebuild "<sel>" --trigger hover|scroll|load [--width 1440] [--target "<child sel>"]');
  process.exit(process.argv.length < 6 ? 2 : 0);
}
const HERE = path.dirname(fileURLToPath(import.meta.url));
const UI = path.resolve(HERE, '../../../MORENE UI');
const site = process.argv[2];
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d; };
const orig = arg('orig'); const rebuild = arg('rebuild'); const trigger = arg('trigger', 'hover'); const target = arg('target', null);
const width = Number(arg('width', 1440));
if (!orig || !rebuild) { console.error('give --orig and --rebuild'); process.exit(2); }
const dirs = { safah: 'localized/safah', chalant: 'localized/chalant', dewskincare: 'localized/dewskincare', mirea: 'localized/mirea', raydiant: 'localized/raydiant' };
if (!dirs[site]) { console.error('unknown site'); process.exit(2); }
const out = path.join(HERE, 'out', 'motion'); fs.mkdirSync(out, { recursive: true });

const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.avif': 'image/avif', '.mp4': 'video/mp4', '.webm': 'video/webm', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf' };
const roots = [path.join(UI, dirs[site]), path.join(UI, 'public')];
const server = http.createServer((req, res) => {
  let rel = decodeURIComponent((req.url || '/').split('?')[0]); if (rel.endsWith('/')) rel += 'index.html';
  for (const r of roots) { const f = path.normalize(path.join(r, rel)); if (!f.startsWith(r)) continue; try { if (fs.statSync(f).isFile()) { res.writeHead(200, { 'Content-Type': MIME[path.extname(f).toLowerCase()] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res); return; } } catch { /* next */ } }
  res.writeHead(404); res.end('not found');
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const originalUrl = `http://127.0.0.1:${server.address().port}/index.html`;
const { chromium } = await import('playwright');
const browser = await chromium.launch();
const FRAMES = 25; const STEP = 60;

async function record(label, url, selector) {
  const ctx = await browser.newContext({ viewport: { width, height: 900 } });
  const p = await ctx.newPage();
  await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await p.waitForTimeout(2500);
  const el = p.locator(selector).first();
  if (!(await p.locator(selector).count())) { await ctx.close(); return { label, error: `selector matched nothing: ${selector}` }; }
  const shots = [];
  const grab = async () => { try { const b = await el.boundingBox(); if (!b) return; shots.push(await el.screenshot({ type: 'jpeg', quality: 60 })); } catch { /* element moved away */ } };
  if (trigger === 'hover') {
    await p.mouse.move(2, 2);
    await el.scrollIntoViewIfNeeded(); await p.waitForTimeout(900);
    const t = target ? el.locator(target).first() : el;
    const b = await t.boundingBox();
    await grab();
    await p.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 2 });
  } else if (trigger === 'scroll') {
    await p.evaluate(() => window.scrollTo(0, 0)); await p.waitForTimeout(600);
    const y = await el.evaluate((n) => n.getBoundingClientRect().top + scrollY);
    await p.evaluate((yy) => window.scrollTo(0, Math.max(0, yy - 1400)), y); await p.waitForTimeout(900);
    await p.evaluate((yy) => window.scrollTo({ top: Math.max(0, yy - 300), behavior: 'instant' }), y);
  } else {
    await p.reload({ waitUntil: 'commit' });
  }
  for (let i = 0; i < FRAMES; i++) { await grab(); await p.waitForTimeout(STEP); }
  await ctx.close();
  return { label, shots };
}

const a = await record('original', originalUrl, orig);
const b = await record('rebuild', `http://localhost:3001/showcase/${site}`, rebuild);
const pg = await (await browser.newContext()).newPage();
async function energy(shots) {
  const urls = shots.map((s) => 'data:image/jpeg;base64,' + s.toString('base64'));
  return pg.evaluate(async (list) => {
    const load = (s) => new Promise((r, j) => { const i = new Image(); i.onload = () => r(i); i.onerror = j; i.src = s; });
    const imgs = await Promise.all(list.map(load)); const W = 160;
    const data = imgs.map((im) => { const h = Math.max(1, Math.round(im.height * W / im.width)); const c = document.createElement('canvas'); c.width = W; c.height = h; const x = c.getContext('2d', { willReadFrequently: true }); x.drawImage(im, 0, 0, W, h); return x.getImageData(0, 0, W, h).data; });
    const e = [];
    for (let i = 1; i < data.length; i++) { const A = data[i - 1], B = data[i]; const n = Math.min(A.length, B.length); let s = 0; for (let k = 0; k < n; k += 4) s += (Math.abs(A[k] - B[k]) + Math.abs(A[k + 1] - B[k + 1]) + Math.abs(A[k + 2] - B[k + 2])) / 3; e.push(+(s / (n / 4) / 255 * 100).toFixed(2)); }
    return e;
  }, urls);
}
const summary = (e) => {
  const peak = Math.max(0, ...e); const thr = Math.max(0.05, peak * 0.1);
  const first = e.findIndex((v) => v > thr); let last = -1; e.forEach((v, i) => { if (v > thr) last = i; });
  return { peak: +peak.toFixed(2), start: first < 0 ? null : first * STEP, end: last < 0 ? null : (last + 1) * STEP, total: +e.reduce((s, v) => s + v, 0).toFixed(1) };
};
const sums = {};
for (const r of [a, b]) {
  if (r.error) { console.log(`${r.label}: ERROR ${r.error}`); continue; }
  const e = await energy(r.shots); const s = summary(e); sums[r.label] = s;
  const bars = e.map((v) => ' .:-=+*#%@'[Math.min(9, Math.floor(v / Math.max(0.01, s.peak) * 9))]).join('');
  console.log(`${r.label.padEnd(8)} ${s.start == null ? 'NO MOTION SEEN' : `moves from ${s.start} ms to ${s.end} ms, peak ${s.peak}, total ${s.total}`}   ${bars}`);
}
if (sums.original && sums.rebuild) {
  const o = sums.original, r = sums.rebuild; const notes = [];
  if (o.start == null && r.start != null) notes.push('the original does not move here but the rebuild does');
  else if (o.start != null && r.start == null) notes.push('the rebuild has NO animation where the original has one');
  else if (o.start != null) {
    if (Math.abs(r.start - o.start) > 120) notes.push(`starts ${r.start - o.start > 0 ? 'late' : 'early'} by ${Math.abs(r.start - o.start)} ms`);
    const od = o.end - o.start, rd = r.end - r.start; if (od > 0 && Math.abs(rd - od) / od > 0.25) notes.push(`lasts ${rd} ms against ${od} ms`);
    if (o.peak > 0 && Math.abs(r.peak - o.peak) / o.peak > 0.4) notes.push(`peak strength ${r.peak} against ${o.peak}`);
  }
  console.log(notes.length ? `MOTION DIFFERS: ${notes.join('; ')}` : 'motion matches the original (start, duration and strength within tolerance)');
}
await browser.close(); server.close();
