#!/usr/bin/env node
// orch-web.mjs: a web console for the orchestrator. Chat with the manager, watch what runs, read logs, tasks and report documents.
// No dependencies. Listens on 127.0.0.1 only (reach it through Tailscale Serve or an SSH tunnel). Every request needs the token.
//   node orch-web.mjs [repoDir] [--port 8787]
// Token: ORCH_WEB_TOKEN in the environment, or the first line of <hub>/runs/web-token (created on first start, mode 600).
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { resolveConfig } from '../orchestrator/config.mjs';
import { fold } from '../fold.mjs';
import { runningJobs } from '../orchestrator/jobs-view.mjs';
import { actionsOf } from '../orchestrator/trace.mjs';
import { help } from './runtime.mjs';

help('usage: orch-web.mjs [repoDir] [--port 8787]   (web console for the orchestrator; localhost only, token required)');

const argv = process.argv.slice(2);
const portAt = argv.indexOf('--port');
const PORT = Number(portAt >= 0 ? argv[portAt + 1] : process.env.ORCH_WEB_PORT || 8787);
const cfg = resolveConfig(path.resolve(argv.find((a, i) => !a.startsWith('--') && argv[i - 1] !== '--port') ?? '.'));
const RUNS = path.join(cfg.hubPath, 'runs');
fs.mkdirSync(RUNS, { recursive: true });
const IN = path.join(RUNS, 'web-inbox.jsonl');
const OUT = path.join(RUNS, 'web-chat.jsonl');

const tokenFile = path.join(RUNS, 'web-token');
if (!process.env.ORCH_WEB_TOKEN && !fs.existsSync(tokenFile)) fs.writeFileSync(tokenFile, crypto.randomBytes(18).toString('base64url') + '\n', { mode: 0o600 });
const TOKEN = process.env.ORCH_WEB_TOKEN || fs.readFileSync(tokenFile, 'utf8').trim();
const same = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };

const readJsonl = (f, tail = 400) => { try { return fs.readFileSync(f, 'utf8').trim().split('\n').slice(-tail).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { return []; } };
const send = (res, code, body, type = 'application/json') => { res.writeHead(code, { 'content-type': type + '; charset=utf-8', 'cache-control': 'no-store' }); res.end(typeof body === 'string' ? body : JSON.stringify(body)); };

function state() {
  const events = readJsonl(path.join(cfg.hubPath, 'events.jsonl'), 200000);
  const { tasks } = fold(events);
  const counts = {};
  for (const t of Object.values(tasks)) counts[t.status] = (counts[t.status] ?? 0) + 1;
  const running = runningJobs(cfg.hubPath, cfg.root).map((j) => ({ task: j.taskId, kind: j.mode === 'review' ? 'review' : 'work', on: j.executor, minutes: j.minutes, goal: j.goal, tokens: j.tokens }));
  let control = {}; try { control = JSON.parse(fs.readFileSync(path.join(cfg.hubPath, 'orch-control.json'), 'utf8')); } catch { /* none */ }
  let driver = {}; try { driver = JSON.parse(fs.readFileSync(path.join(cfg.hubPath, 'orch-driver.json'), 'utf8')); } catch { /* none */ }
  const list = Object.values(tasks).filter((t) => t.status !== 'ACCEPTED' && t.status !== 'CANCELLED').map((t) => ({ id: t.id, status: t.status, title: String(t.title ?? '').slice(0, 90), claimedBy: t.claimedBy ?? null }));
  return {
    project: cfg.projectName, node: cfg.nodeName, counts, running, tasks: list,
    held: fs.existsSync(path.join(RUNS, 'burn-hold.json')) ? JSON.parse(fs.readFileSync(path.join(RUNS, 'burn-hold.json'), 'utf8')).why : null,
    paused: Boolean(control.paused), first: control.first ?? null, onDuty: driver.current ?? null,
  };
}

function taskLog(task) {
  const rows = readJsonl(path.join(RUNS, 'jobs.jsonl'), 3000).filter((j) => j.taskId === task);
  const j = rows.at(-1);
  if (!j) return { found: false };
  let raw = ''; try { raw = fs.readFileSync(path.resolve(cfg.root, j.log), 'utf8').slice(-600_000); } catch { /* unreadable */ }
  const exit = raw.match(/\[dispatch\] (exit \S+|watchdog[^\n]*)/g)?.slice(-1)[0] ?? 'still running';
  const verdictFile = path.join(RUNS, `${j.id}.verdict.md`);
  let verdict = ''; try { verdict = fs.readFileSync(verdictFile, 'utf8').slice(0, 6000); } catch { /* no verdict */ }
  return { found: true, id: j.id, kind: j.mode, on: j.executor, started: j.t, state: exit.replace('[dispatch] ', ''), actions: actionsOf(raw, 25), verdict };
}

// Report documents: markdown files under docs/ and the hub's own folders, newest first.
const DOC_ROOTS = ['docs', path.relative(cfg.root, cfg.hubPath) + '/docs', 'lango-app/docs'].map((p) => path.resolve(cfg.root, p));
function walk(dir, out, depth = 0) {
  if (depth > 5) return;
  let items = []; try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const it of items) {
    if (it.name.startsWith('.') || it.name === 'node_modules') continue;
    const p = path.join(dir, it.name);
    if (it.isDirectory()) walk(p, out, depth + 1);
    else if (/\.(md|html|txt)$/i.test(it.name)) { try { out.push({ path: path.relative(cfg.root, p).replace(/\\/g, '/'), mtime: fs.statSync(p).mtimeMs }); } catch { /* gone */ } }
  }
}
// Live transcript of the manager's current or latest turn, as plain readable steps.
function session() {
  const rows = readJsonl(path.join(RUNS, 'manager-live.jsonl'), 4000);
  const start = rows.find((r) => r.type === 'turn_start') ?? null;
  const steps = [];
  for (const e of rows) {
    if (e.type === 'assistant' && Array.isArray(e.message?.content)) {
      for (const c of e.message.content) {
        if (c.type === 'thinking' && c.thinking) steps.push({ k: 'thinking', text: String(c.thinking).slice(0, 700) });
        else if (c.type === 'tool_use') steps.push({ k: 'tool', text: `${c.name}: ${String(c.input?.command ?? c.input?.file_path ?? c.input?.path ?? JSON.stringify(c.input ?? {})).slice(0, 300)}` });
        else if (c.type === 'text' && c.text) steps.push({ k: 'said', text: String(c.text).slice(0, 1500) });
      }
    } else if (e.type === 'user' && Array.isArray(e.message?.content)) {
      for (const c of e.message.content) if (c.type === 'tool_result') steps.push({ k: 'result', text: String(typeof c.content === 'string' ? c.content : JSON.stringify(c.content)).slice(0, 260) });
    } else if (e.type === 'item.completed' && e.item?.type === 'command_execution') steps.push({ k: 'tool', text: `Bash: ${String(e.item.command).slice(0, 300)}` });
    else if (e.type === 'item.completed' && e.item?.text) steps.push({ k: 'said', text: String(e.item.text).slice(0, 1500) });
    else if (e.type === 'result') steps.push({ k: 'done', text: `finished: ${e.subtype ?? ''}${e.is_error ? ' (error)' : ''}` });
  }
  const live = start && !steps.some((s) => s.k === 'done');
  const d = (() => { try { return JSON.parse(fs.readFileSync(path.join(cfg.hubPath, 'orch-driver.json'), 'utf8')); } catch { return {}; } })();
  const sid = d.sessions?.[start?.entry]?.sid ?? start?.sid ?? null;
  const home = process.env.HOME || '';
  const cmdFor = (e) => {
    if (!e) return null;
    if (/gemini/i.test(e.model ?? e.entry ?? '')) return { note: 'Gemini sessions cannot be resumed (the proxy rejects it). This opens a fresh interactive session in the project instead.', cmd: `cd ${cfg.root} && claude-ag2-gemini` };
    if (/codex/.test(e.family ?? '')) return { note: 'Resumes the same Codex session.', cmd: sid ? `cd ${cfg.root} && codex-proxy resume ${sid}` : `cd ${cfg.root} && codex-proxy` };
    return { note: 'Resumes the same Claude session.', cmd: sid ? `cd ${cfg.root} && ${e.command ?? 'claude'} --resume ${sid}` : `cd ${cfg.root} && ${e.command ?? 'claude'}` };
  };
  void home;
  return { entry: start?.entry ?? null, started: start?.t ?? null, live: Boolean(live), steps: steps.slice(-80), terminal: cmdFor(start) };
}

function docs() { const out = []; for (const r of new Set(DOC_ROOTS)) walk(r, out); return out.sort((a, b) => b.mtime - a.mtime).slice(0, 40); }
function docBody(rel) {
  const abs = path.resolve(cfg.root, rel);
  if (!DOC_ROOTS.some((r) => abs.startsWith(r + path.sep)) || !/\.(md|html|txt)$/i.test(abs) || !fs.existsSync(abs)) return null;
  return fs.readFileSync(abs, 'utf8').slice(0, 400_000);
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const auth = req.headers['x-token'] || u.searchParams.get('token');
  if (u.pathname === '/') return send(res, 200, PAGE, 'text/html');
  if (!auth || !same(auth, TOKEN)) return send(res, 401, { error: 'token' });
  try {
    if (u.pathname === '/api/state') return send(res, 200, state());
    if (u.pathname === '/api/chat') { const after = Number(u.searchParams.get('after') ?? 0); return send(res, 200, readJsonl(OUT, 300).filter((m) => m.t > after)); }
    if (u.pathname === '/api/log') return send(res, 200, taskLog(u.searchParams.get('task') ?? ''));
    if (u.pathname === '/api/session') return send(res, 200, session());
    if (u.pathname === '/api/docs') return send(res, 200, docs());
    if (u.pathname === '/api/doc') { const b = docBody(u.searchParams.get('path') ?? ''); return b === null ? send(res, 404, { error: 'not found' }) : send(res, 200, { body: b }); }
    if (u.pathname === '/api/say' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => { body += c; if (body.length > 20000) req.destroy(); });
      req.on('end', () => {
        const text = String(JSON.parse(body || '{}').text ?? '').trim().slice(0, 4000);
        if (!text) return send(res, 400, { error: 'empty' });
        fs.appendFileSync(IN, JSON.stringify({ t: Date.now(), text }) + '\n');
        fs.appendFileSync(OUT, JSON.stringify({ t: Date.now(), role: 'owner', text }) + '\n');
        send(res, 200, { ok: true });
      });
      return;
    }
    send(res, 404, { error: 'no such page' });
  } catch (e) { send(res, 500, { error: String(e.message).slice(0, 200) }); }
});

if (process.argv.includes('--selftest')) {
  console.log(`PASS orch-web: loads, hub ${path.basename(cfg.hubPath)}, token length ${TOKEN.length}`);
  process.exit(0);
}
server.listen(PORT, '127.0.0.1', () => console.log(`orch-web on http://127.0.0.1:${PORT}  (token file: ${tokenFile})`));

const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Orchestrator console</title>
<style>
:root{--bg:#f6f4ef;--card:#fff;--ink:#1c1b19;--mute:#6c6a64;--line:#e4e0d6;--acc:#17696a;--warn:#b4532a}
@media (prefers-color-scheme:dark){:root{--bg:#141413;--card:#1e1e1c;--ink:#ecebe6;--mute:#9a978f;--line:#2e2d2a;--acc:#4fb3b4;--warn:#e08a5e}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 system-ui,sans-serif}
header{padding:12px 16px;border-bottom:1px solid var(--line);display:flex;gap:12px;align-items:center;flex-wrap:wrap}
header b{font-size:16px}.pill{border:1px solid var(--line);border-radius:99px;padding:2px 10px;color:var(--mute);font-size:13px}.pill.warn{color:var(--warn);border-color:var(--warn)}
main{display:grid;grid-template-columns:minmax(0,1.1fr) minmax(0,1fr);gap:12px;padding:12px;height:calc(100vh - 56px)}
@media(max-width:820px){main{grid-template-columns:1fr;height:auto}}
section{background:var(--card);border:1px solid var(--line);border-radius:12px;display:flex;flex-direction:column;min-height:320px;max-height:calc(100vh - 80px);overflow:hidden}
h2{margin:0;padding:10px 14px;font-size:13px;letter-spacing:.04em;text-transform:uppercase;color:var(--mute);border-bottom:1px solid var(--line)}
.scroll{overflow:auto;padding:12px 14px;flex:1}.msg{margin:0 0 12px;white-space:pre-wrap;word-break:break-word}.msg.owner{color:var(--acc);font-weight:600}.msg small{display:block;color:var(--mute);font-weight:400}
form{display:flex;gap:8px;padding:10px;border-top:1px solid var(--line)}textarea{flex:1;resize:none;height:44px;font:inherit;padding:8px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--ink)}
button{font:inherit;padding:8px 14px;border-radius:8px;border:1px solid var(--acc);background:var(--acc);color:#fff;cursor:pointer}button.ghost{background:none;color:var(--acc)}
.tabs{display:flex;gap:6px;padding:8px 10px;border-bottom:1px solid var(--line);flex-wrap:wrap}.tabs button{background:none;color:var(--ink);border-color:var(--line);padding:4px 10px;font-size:13px}.tabs button.on{background:var(--acc);color:#fff;border-color:var(--acc)}
.row{padding:8px 0;border-bottom:1px solid var(--line);display:flex;justify-content:space-between;gap:8px}.row:last-child{border:0}.mut{color:var(--mute);font-size:13px}pre{white-space:pre-wrap;margin:0;font:13px/1.5 ui-monospace,monospace}
</style></head><body>
<header><b id="proj">Orchestrator</b><span class="pill" id="duty"></span><span class="pill" id="counts"></span><span class="pill warn" id="flag" hidden></span><span style="flex:1"></span><button class="ghost" onclick="say('/orch pause')">Pause</button><button class="ghost" onclick="say('/orch resume')">Resume</button></header>
<main>
<section><h2>Talk to the manager</h2><div class="scroll" id="chat"></div>
<form onsubmit="return send(event)"><textarea id="box" placeholder="Write like you would to a colleague. Shift+Enter for a new line." onkeydown="if(event.key==='Enter'&&!event.shiftKey){send(event)}"></textarea><button>Send</button></form></section>
<section><div class="tabs" id="tabs"></div><div class="scroll" id="panel"></div></section>
</main>
<script>
const T=new URLSearchParams(location.search).get('token')||localStorage.tok||prompt('Access token');localStorage.tok=T;
const $=id=>document.getElementById(id);let tab='running',last=0,S={},detail=null;
const api=(p,o)=>fetch(p+(p.includes('?')?'&':'?')+'token='+encodeURIComponent(T),o).then(r=>r.json());
const esc=s=>String(s).replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
const md=s=>esc(s).replace(/\\*([^*\\n]+)\\*/g,'<b>$1</b>').replace(/_([^_\\n]+)_/g,'<i>$1</i>');
function say(t){api('/api/say',{method:'POST',body:JSON.stringify({text:t})}).then(poll)}
function send(e){e.preventDefault();const t=$('box').value.trim();if(!t)return false;$('box').value='';say(t);return false}
async function poll(){
 const c=await api('/api/chat?after='+last);if(Array.isArray(c)&&c.length){for(const m of c){last=Math.max(last,m.t);const d=document.createElement('div');d.className='msg '+m.role;d.innerHTML=(m.role==='owner'?'You: ':'')+md(m.text).replace(/([\\w./-]*docs\\/[\\w./-]+\\.(?:md|html|txt))/g,'<a href="#" onclick="openDoc(\\'$1\\');return false">$1</a>')+'<small>'+new Date(m.t).toLocaleTimeString()+'</small>';$('chat').appendChild(d)}$('chat').scrollTop=1e9}
 S=await api('/api/state');$('proj').textContent=S.project+' on '+S.node;$('duty').textContent='on duty: '+(S.onDuty||'none');
 $('counts').textContent=Object.entries(S.counts||{}).map(([k,v])=>v+' '+k.toLowerCase()).join(' · ');
 const f=$('flag');const w=S.held?'builds paused: '+S.held:S.paused?'paused':'';f.hidden=!w;f.textContent=w.slice(0,90);draw();
}
const TABS=['session','running','tasks','reports'];
function tabs(){$('tabs').innerHTML=TABS.map(t=>'<button class="'+(t===tab?'on':'')+'" onclick="tab=\\''+t+'\\';detail=null;draw()">'+t+'</button>').join('')}
async function draw(){tabs();const p=$('panel');
 if(detail){p.innerHTML=detail;return}
 if(tab==='session'){const s=await api('/api/session');const k={thinking:'thinking',tool:'ran',result:'got',said:'said',done:'end'};p.innerHTML='<p class="mut">'+(s.entry?('Manager: <b>'+esc(s.entry)+'</b> · '+(s.live?'working now':'idle, last turn shown')):'No turn recorded yet.')+'</p>'+(s.terminal?'<p class="mut">Open this manager in a terminal:</p><pre id="tc">'+esc(s.terminal.cmd)+'</pre><p class="mut">'+esc(s.terminal.note)+' <a href="#" onclick="navigator.clipboard.writeText(document.getElementById(\\'tc\\').textContent);return false">copy</a></p>':'')+(s.steps||[]).map(x=>'<div class="row"><span class="mut" style="min-width:62px">'+k[x.k]+'</span><div style="flex:1;white-space:pre-wrap;word-break:break-word">'+esc(x.text)+'</div></div>').join('');if(s.live)setTimeout(()=>{if(tab==='session'&&!detail)draw()},2500);return}
 if(tab==='running'){const r=S.running||[];p.innerHTML=r.length?r.map(j=>'<div class="row"><div><b>'+esc(j.task)+'</b><div class="mut">'+esc(j.goal||'')+'</div></div><div class="mut">'+j.kind+' · '+esc(j.on)+' · '+j.minutes+' min <a href="#" onclick="openLog(\\''+j.task+'\\');return false">log</a> <a href="#" onclick="say(\\'/orch stop '+j.task+'\\');return false">stop</a></div></div>').join(''):'<p class="mut">Nothing is running right now.</p>'}
 if(tab==='tasks'){p.innerHTML=(S.tasks||[]).map(t=>'<div class="row"><div><b>'+esc(t.id)+'</b><div class="mut">'+esc(t.title)+'</div></div><div class="mut">'+t.status.toLowerCase()+' <a href="#" onclick="openLog(\\''+t.id+'\\');return false">log</a> <a href="#" onclick="say(\\'/orch first '+t.id+'\\');return false">do first</a></div></div>').join('')||'<p class="mut">No open tasks.</p>'}
 if(tab==='reports'){const d=await api('/api/docs');p.innerHTML=d.map(x=>'<div class="row"><a href="#" onclick="openDoc(\\''+x.path+'\\');return false">'+esc(x.path)+'</a><span class="mut">'+new Date(x.mtime).toLocaleString()+'</span></div>').join('')||'<p class="mut">No documents yet.</p>'}}
async function openLog(t){const l=await api('/api/log?task='+encodeURIComponent(t));detail='<p><a href="#" onclick="detail=null;draw();return false">← back</a></p><h3>'+esc(t)+'</h3>'+(l.found?'<p class="mut">'+l.kind+' on '+esc(l.on)+' · '+esc(l.state)+'</p><h4>What it did</h4>'+(l.actions.map(a=>'<div>• '+esc(a)+'</div>').join('')||'<p class="mut">No commands yet.</p>')+(l.verdict?'<h4>Reviewer verdict</h4><pre>'+esc(l.verdict)+'</pre>':''):'<p class="mut">No job found for this task.</p>');draw()}
async function openDoc(p){const d=await api('/api/doc?path='+encodeURIComponent(p));tab='reports';detail='<p><a href="#" onclick="detail=null;draw();return false">← back</a> <span class="mut">'+esc(p)+'</span></p><pre>'+esc(d.body||'Not found')+'</pre>';draw()}
poll();setInterval(poll,3000);
</script></body></html>`;
