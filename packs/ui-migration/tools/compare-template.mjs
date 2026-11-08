// Side-by-side screenshots of an ORIGINAL localized template page and our React REBUILD, at three widths.
// Local only: the original is served from its localized folder, the rebuild from the MORENE UI dev server.
//
//   node MORENE/ops/e2e/compare-template.mjs <site> [--rebuild-url http://localhost:3001/showcase/house-of-honey]
//   sites: house-of-honey, palazzo-sogni
//
// Output: MORENE/ops/e2e/out/compare/<site>/<width>-original.png, <width>-rebuild.png, <width>-side.png (original left, rebuild right)
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log('usage: node MORENE/ops/e2e/compare-template.mjs <house-of-honey|palazzo-sogni> [--rebuild-url <url>]');
  process.exit(0);
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const UI = path.resolve(HERE, '../../../MORENE UI');
const SITES = {
  'house-of-honey': { dir: path.join(UI, 'www.houseofhoney.com'), rebuild: 'http://localhost:3001/showcase/house-of-honey' },
  'palazzo-sogni': { dir: path.join(UI, 'www.palazzosogni.com'), rebuild: 'http://localhost:3001/showcase/palazzo-sogni' },
  // the five Framer templates: original = the offline copy under MORENE UI/localized/<site>
  safah: { dir: path.join(UI, 'localized', 'safah'), rebuild: 'http://localhost:3001/showcase/safah' },
  chalant: { dir: path.join(UI, 'localized', 'chalant'), rebuild: 'http://localhost:3001/showcase/chalant' },
  dewskincare: { dir: path.join(UI, 'localized', 'dewskincare'), rebuild: 'http://localhost:3001/showcase/dewskincare' },
  mirea: { dir: path.join(UI, 'localized', 'mirea'), rebuild: 'http://localhost:3001/showcase/mirea' },
  raydiant: { dir: path.join(UI, 'localized', 'raydiant'), rebuild: 'http://localhost:3001/showcase/raydiant' },
};
const site = process.argv[2];
if (!SITES[site]) { console.error('site must be one of: ' + Object.keys(SITES).join(', ')); process.exit(2); }
const ri = process.argv.indexOf('--rebuild-url');
const rebuildUrl = ri > 0 ? process.argv[ri + 1] : SITES[site].rebuild;
const WIDTHS = [1440, 1024, 390];
const OUT = path.join(HERE, 'out', 'compare', site);
fs.mkdirSync(OUT, { recursive: true });

const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.avif': 'image/avif', '.gif': 'image/gif', '.mp4': 'video/mp4', '.webm': 'video/webm', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf' };
const roots = [SITES[site].dir, path.join(UI, 'public')];
const server = http.createServer((req, res) => {
  let rel = decodeURIComponent((req.url || '/').split('?')[0]);
  if (rel.endsWith('/')) rel += 'index.html';
  for (const root of roots) {
    const file = path.normalize(path.join(root, rel));
    if (!file.startsWith(root)) continue;
    try {
      if (fs.statSync(file).isFile()) {
        res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
        fs.createReadStream(file).pipe(res);
        return;
      }
    } catch { /* try the next root */ }
  }
  res.writeHead(404); res.end('not found');
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const originalUrl = `http://127.0.0.1:${server.address().port}/index.html`;

let chromium;
try { ({ chromium } = await import('playwright')); } catch { console.error('playwright is not installed: run npm install in MORENE/ops/e2e'); server.close(); process.exit(2); }
const browser = await chromium.launch();

// Scroll to the bottom in steps so lazy images and scroll-triggered animations have run before the screenshot.
async function settle(page) {
  await page.evaluate(async () => {
    const step = Math.max(300, Math.floor(window.innerHeight * 0.6));
    for (let y = 0; y < document.body.scrollHeight; y += step) { window.scrollTo(0, y); await new Promise((r) => setTimeout(r, 180)); }
    window.scrollTo(0, 0);
  });
  await page.waitForTimeout(800);
}

const shots = {};
for (const w of WIDTHS) {
  for (const [kind, url] of [['original', originalUrl], ['rebuild', rebuildUrl]]) {
    const ctx = await browser.newContext({ viewport: { width: w, height: 900 } });
    const page = await ctx.newPage();
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForTimeout(2500);
      await settle(page);
      const file = path.join(OUT, `${w}-${kind}.png`);
      await page.screenshot({ path: file, fullPage: true });
      const h = await page.evaluate(() => document.documentElement.scrollHeight);
      shots[`${w}-${kind}`] = { file, height: h };
    } catch (e) {
      console.log(`FAIL ${w} ${kind}: ${String(e.message).split('\n')[0]}`);
    }
    await ctx.close();
  }
  // side by side page, so one image shows both
  const a = shots[`${w}-original`], b = shots[`${w}-rebuild`];
  if (a && b) {
    const ctx = await browser.newContext({ viewport: { width: w * 2 + 20, height: 900 } });
    const page = await ctx.newPage();
    const b64 = (f) => fs.readFileSync(f).toString('base64');
    await page.setContent(`<body style="margin:0;background:#888;display:flex;gap:20px;align-items:flex-start"><div><div style="font:14px sans-serif;color:#fff;padding:4px">ORIGINAL (${a.height}px)</div><img style="width:${w}px;display:block" src="data:image/png;base64,${b64(a.file)}"></div><div><div style="font:14px sans-serif;color:#fff;padding:4px">REBUILD (${b.height}px)</div><img style="width:${w}px;display:block" src="data:image/png;base64,${b64(b.file)}"></div></body>`);
    await page.screenshot({ path: path.join(OUT, `${w}-side.png`), fullPage: true });
    await ctx.close();
  }
  console.log(`${w}px  original height ${a?.height ?? 'n/a'}  rebuild height ${b?.height ?? 'n/a'}`);
}
await browser.close();
server.close();
console.log(`screenshots in ${path.relative(process.cwd(), OUT)}`);
