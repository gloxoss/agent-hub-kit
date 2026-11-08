// Live compare pages for the owner: the ORIGINAL localized template on the left, our REBUILD on the right, in the browser.
// Serves everything locally and only listens on 127.0.0.1.
//
//   node MORENE/ops/e2e/compare-server.mjs          (keep it running; Ctrl+C stops it)
//
// Pages (http://localhost:4190):
//   /                                  list of every template and section
//   /compare/<site>                    whole page, original left, rebuild right, two scrollbars
//   /compare/<site>/<section>          both frames jump to the section (#<section> in the original, [data-section] in the rebuild)
// The original of each site is served on its own port: safah 4181, chalant 4182, dewskincare 4183, mirea 4184, raydiant 4185.
// The rebuild is read from http://localhost:3001/showcase/<site> (the MORENE UI dev server must be running).
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log('usage: node MORENE/ops/e2e/compare-server.mjs   (opens http://localhost:4190 with live original-versus-rebuild pages)');
  process.exit(0);
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const UI = path.resolve(HERE, '../../../MORENE UI');
const SITES = {
  safah: { port: 4181, sections: ['header', 'hero', 'about', 'collection', 'products', 'testimonials', 'footer'] },
  chalant: { port: 4182, sections: ['navbar', 'hero', 'metrics', 'product', 'mix', 'testimonial', 'faq', 'footer'] },
  dewskincare: { port: 4183, sections: ['navbar', 'hero', 'ticker', 'manifesto', 'zoom', 'products', 'ingredients', 'story', 'reviews-faq', 'closing-footer'] },
  mirea: { port: 4184, sections: ['navbar', 'hero', 'statement', 'products', 'formula', 'ritual', 'story', 'people', 'journal', 'cta-footer'] },
  raydiant: { port: 4185, sections: ['navbar', 'hero', 'benefits', 'collage', 'testimonial-faq', 'cta-footer'] },
};
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.avif': 'image/avif', '.gif': 'image/gif', '.mp4': 'video/mp4', '.webm': 'video/webm', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf', '.txt': 'text/plain' };

function staticServer(root, port) {
  const roots = [root, path.join(UI, 'public')];
  http.createServer((req, res) => {
    let rel = decodeURIComponent((req.url || '/').split('?')[0]);
    if (rel.endsWith('/')) rel += 'index.html';
    for (const r of roots) {
      const file = path.normalize(path.join(r, rel));
      if (!file.startsWith(r)) continue;
      try {
        const st = fs.statSync(file);
        if (!st.isFile()) continue;
        const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
        const range = req.headers.range;
        if (range && /^bytes=/.test(range)) {
          const [a, b] = range.replace('bytes=', '').split('-');
          const start = Number(a) || 0; const end = b ? Number(b) : st.size - 1;
          res.writeHead(206, { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Content-Length': end - start + 1 });
          fs.createReadStream(file, { start, end }).pipe(res);
        } else {
          res.writeHead(200, { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Content-Length': st.size });
          fs.createReadStream(file).pipe(res);
        }
        return;
      } catch { /* next root */ }
    }
    res.writeHead(404); res.end('not found');
  }).listen(port, '127.0.0.1');
}
for (const [site, s] of Object.entries(SITES)) staticServer(path.join(UI, 'localized', site), s.port);

const page = (title, body) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title>
<style>
:root{--bg:#f7f6f2;--ink:#1c262c;--muted:#5b6870;--card:#fff;--line:#dedbd0;--accent:#0b4a5a}
@media (prefers-color-scheme:dark){:root{--bg:#12171a;--ink:#e8ecee;--muted:#9aa8b0;--card:#1b2226;--line:#2b363c;--accent:#6cc4d8}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 system-ui,sans-serif}a{color:var(--accent)}
.bar{display:flex;flex-wrap:wrap;gap:8px;align-items:center;padding:8px 12px;border-bottom:1px solid var(--line);background:var(--bg)}
.bar a,.bar button{padding:4px 10px;border:1px solid var(--line);border-radius:999px;background:var(--card);color:var(--accent);text-decoration:none;font-size:13px;cursor:pointer}
.bar b{margin-right:6px}.frames{display:grid;grid-template-columns:1fr 1fr;height:calc(100vh - 130px)}.frames div{display:flex;flex-direction:column;min-width:0}
.frames h3{margin:0;padding:4px 10px;font-size:13px;background:var(--card);border-bottom:1px solid var(--line)}.frames .wrap{flex:1;overflow:hidden;position:relative;background:#fff}.frames iframe{position:absolute;top:0;left:0;border:0;background:#fff;transform-origin:0 0}
main{max-width:900px;margin:0 auto;padding:16px}h2{margin:24px 0 6px}ul{padding-left:20px}
@media(max-width:800px){.frames{grid-template-columns:1fr;height:auto}.frames iframe{height:80vh}}
</style></head><body>${body}</body></html>`;

http.createServer((req, res) => {
  const url = new URL(req.url || '/', 'http://localhost:4190');
  const parts = url.pathname.split('/').filter(Boolean);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  if (!parts.length) {
    const list = Object.entries(SITES).map(([site, s]) => `<h2>${site}</h2><ul><li><a href="/compare/${site}">whole page, side by side</a> &middot; <a href="http://localhost:${s.port}/index.html" target="_blank">original only</a> &middot; <a href="http://localhost:3001/showcase/${site}" target="_blank">rebuild only</a></li>${s.sections.map((x) => `<li><a href="/compare/${site}/${x}">${x}</a></li>`).join('')}</ul>`).join('');
    res.end(page('Compare', `<main><h1>Original against rebuild, live</h1><p>Left: the original template, served locally and offline. Right: our React rebuild (needs the MORENE UI dev server on port 3001). Pick a page or a section.</p>${list}</main>`));
    return;
  }
  if (parts[0] === 'compare' && SITES[parts[1]]) {
    const site = parts[1]; const section = parts[2] || '';
    const s = SITES[site];
    const left = `http://localhost:${s.port}/index.html${section ? `#${section.split('-')[0]}` : ''}`;
    const right = `http://localhost:3001/showcase/${site}${section ? `#${section}` : ''}`;
    const nav = s.sections.map((x) => `<a href="/compare/${site}/${x}">${x}</a>`).join('');
    res.end(page(`${site} ${section}`, `<div class="bar"><b>${site}${section ? ' / ' + section : ''}</b><a href="/">all</a><a href="/compare/${site}">whole page</a>${nav}<a href="${left}" target="_blank">original in a tab</a><a href="${right}" target="_blank">rebuild in a tab</a></div>
<div class="bar"><b>Page width</b><button data-vw="1440">1440 desktop</button><button data-vw="1024">1024 tablet</button><button data-vw="390">390 phone</button></div><div class="frames"><div><h3>ORIGINAL (offline copy)</h3><div class="wrap"><iframe id="ob" src="${left}" title="original"></iframe></div></div><div><h3>REBUILD (our React page)</h3><div class="wrap"><iframe id="rb" src="${right}" title="rebuild"></iframe></div></div></div>
<script>
const fit=(vw)=>{for(const id of ['ob','rb']){const f=document.getElementById(id);const w=f.parentElement.clientWidth;const s=Math.min(1,w/vw);f.style.width=vw+'px';f.style.height=(f.parentElement.clientHeight/s)+'px';f.style.transform='scale('+s+')';}document.querySelectorAll('[data-vw]').forEach(b=>b.style.background=b.dataset.vw==String(vw)?'var(--accent)':'');};document.querySelectorAll('[data-vw]').forEach(b=>b.addEventListener('click',()=>fit(Number(b.dataset.vw))));addEventListener('resize',()=>fit(window.__vw||1440));fit(1440);const sec=${JSON.stringify(section)};const site=${JSON.stringify(site)};
if(sec){document.getElementById('rb').addEventListener('load',()=>{try{const d=document.getElementById('rb').contentDocument;const el=d.querySelector('[data-section="'+site+'-'+sec+'"]');if(el)el.scrollIntoView();}catch(e){}});}
</script>`));
    return;
  }
  res.statusCode = 404; res.end(page('Not found', '<main><p>Not found. <a href="/">Back</a></p></main>'));
}).listen(4190, '127.0.0.1', () => console.log('compare pages on http://localhost:4190 (originals on ports 4181 to 4185)'));
