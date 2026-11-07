#!/usr/bin/env node
// Library of every agent session the hub has started, so a closed agent window can be found and reopened.
//
//   node .agent-hub/tools/agent-history.mjs list [--task T] [--executor E] [--status S] [--limit N]
//   node .agent-hub/tools/agent-history.mjs show <job id | task id>      full record, resume command, what the agent reported
//   node .agent-hub/tools/agent-history.mjs discover [--all]             find the session id of agents that do not report it (codex, opencode, agy)
//   node .agent-hub/tools/agent-history.mjs html                         write docs/agents/index.html (searchable page with copy buttons)
//
// Data: .agent-hub/history/agents.jsonl, append only, one JSON line per event, the newest line wins per job id.
// Written by dispatch.mjs when a job starts and by herdr-bridge.mjs when a window is closed. Nothing here is secret:
// it holds task ids, executor names, log paths and session ids.
// Reopen a closed agent:  node .agent-hub/tools/herdr-bridge.mjs reopen <job id | task id>

// --help guard (the kit self-test calls every tool with --help)
if (process.argv.includes('--help') || process.argv.includes('-h')) { console.log('usage: agent-history.mjs list [--task T] [--executor E] [--status S] [--limit N] | show <id> | discover [--all] | backfill | html'); process.exit(0); }

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, execSync } from 'node:child_process';
import { fold } from '../fold.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HUB = path.resolve(HERE, '..');
const ROOT = path.resolve(HUB, '..');
export const HISTORY_FILE = path.join(HUB, 'history', 'agents.jsonl');
let opencodeCache = null;
const norm = (p) => String(p ?? '').replace(/\\/g, '/').toLowerCase();

// ---------------------------------------------------------------- store

export function record(rec) {
  try {
    fs.mkdirSync(path.dirname(HISTORY_FILE), { recursive: true });
    fs.appendFileSync(HISTORY_FILE, `${JSON.stringify({ t: new Date().toISOString(), ...rec })}\n`);
  } catch {}
}

function jsonl(file) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);
  } catch { return []; }
}

export function readAll() {
  const by = new Map();
  for (const r of jsonl(HISTORY_FILE)) if (r.id) by.set(r.id, { ...(by.get(r.id) ?? {}), ...r });
  return [...by.values()].sort((a, b) => String(b.startedAt ?? b.t).localeCompare(String(a.startedAt ?? a.t)));
}

// ---------------------------------------------------------------- state of one record

export function logState(rec) {
  const file = rec.log ? path.resolve(ROOT, rec.log) : null;
  if (!file) return { state: 'unknown' };
  let text = '';
  let mtime = 0;
  try { text = fs.readFileSync(file, 'utf8'); mtime = fs.statSync(file).mtimeMs; } catch { return { state: 'no log' }; }
  const exit = text.match(/^\[dispatch\] exit (-?\d+|null)/m);
  if (exit) return { state: exit[1] === '0' ? 'finished' : 'failed', exit: exit[1], endedAt: new Date(mtime).toISOString() };
  return { state: Date.now() - mtime < 3 * 60000 ? 'running' : 'stopped', endedAt: null };
}

// ---------------------------------------------------------------- session discovery (best effort)

const withinWindow = (ms, start) => ms >= start - 5000 && ms <= start + 180000;

function discoverCodex(rec) {
  const start = Date.parse(rec.startedAt);
  const root = path.join(os.homedir(), '.codex', 'sessions');
  const days = new Set();
  for (const d of [new Date(start), new Date(start + 86400000)]) days.add(path.join(root, String(d.getUTCFullYear()), String(d.getUTCMonth() + 1).padStart(2, '0'), String(d.getUTCDate()).padStart(2, '0')));
  for (const dir of days) {
    let files = [];
    try { files = fs.readdirSync(dir).filter((f) => f.startsWith('rollout-')); } catch { continue; }
    for (const f of files) {
      const full = path.join(dir, f);
      try {
        const st = fs.statSync(full);
        if (st.mtimeMs < start - 5000) continue;
        const head = fs.readFileSync(full, 'utf8').slice(0, 60000);
        if (rec.base && head.includes(rec.base)) {
          const meta = JSON.parse(head.split('\n')[0]);
          return meta?.payload?.id ?? meta?.payload?.session_id ?? null;
        }
      } catch {}
    }
  }
  return null;
}

function discoverOpencode(rec) {
  const start = Date.parse(rec.startedAt);
  let list = [];
  // opencode is a command shim on Windows, so it needs a shell. The command line is fixed text, no user input.
  // The list is cached for a minute: discovery asks once per record.
  if (opencodeCache && Date.now() - opencodeCache.at < 60000) list = opencodeCache.list;
  else {
    try { list = JSON.parse(execSync('opencode session list --format json', { encoding: 'utf8', timeout: 40000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })); } catch { return null; }
    opencodeCache = { at: Date.now(), list };
  }
  const mine = list.filter((s) => norm(s.directory) === norm(ROOT) && withinWindow(s.created, start));
  mine.sort((a, b) => Math.abs(a.created - start) - Math.abs(b.created - start));
  return mine[0]?.id ?? null;
}

function discoverAgy(rec) {
  const start = Date.parse(rec.startedAt);
  const dir = path.join(os.homedir(), '.gemini', 'antigravity');
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => /^[0-9a-f-]{36}\.db$/.test(f)); } catch { return null; }
  const hits = [];
  for (const f of files) {
    try {
      const st = fs.statSync(path.join(dir, f));
      if (!withinWindow(st.birthtimeMs || st.ctimeMs, start)) continue;
      const bytes = fs.readFileSync(path.join(dir, f), 'latin1');
      hits.push({ id: f.replace('.db', ''), at: st.birthtimeMs || st.ctimeMs, exact: rec.base ? bytes.includes(rec.base) : false });
    } catch {}
  }
  hits.sort((a, b) => Number(b.exact) - Number(a.exact) || Math.abs(a.at - start) - Math.abs(b.at - start));
  return hits[0]?.id ?? null;
}

export function discover(rec) {
  if (rec.sessionId) return rec.sessionId;
  if (!rec.startedAt) return null;
  try {
    if (rec.executor === 'codex') return discoverCodex(rec);
    if (rec.executor?.startsWith('opencode')) return discoverOpencode(rec);
    if (rec.executor === 'agy') return discoverAgy(rec);
  } catch {}
  return null;
}

// Session ids are filled in later, while the agent window is still open or just before it is closed.
export function discoverMissing({ all = false } = {}) {
  let found = 0;
  for (const rec of readAll()) {
    if (rec.sessionId || rec.mode === 'review') continue;
    if (!all && Date.now() - Date.parse(rec.startedAt ?? 0) > 6 * 3600000) continue;
    const sid = discover(rec);
    if (sid) { record({ id: rec.id, sessionId: sid }); found++; }
  }
  return found;
}

// The command that reopens the conversation. Uses the executor's own "watch" template from executors.json.
export function resumeCommand(rec) {
  const sid = rec.sessionId;
  if (rec.watchTpl && sid) {
    // opencode's template offers two ways; the direct one is the second
    const tpl = rec.watchTpl.includes('(or: ') ? rec.watchTpl.match(/\(or: (.*?)\)/)?.[1] ?? rec.watchTpl : rec.watchTpl;
    return tpl.replace(/\{sid\}/g, sid).trim();
  }
  const fallback = { codex: 'codex resume', agy: 'agy --continue', cursor: 'cursor-agent --resume' };
  if (rec.executor?.startsWith('opencode')) return 'opencode session list';
  return fallback[rec.executor] ?? `${rec.executor ?? 'agent'} --continue`;
}

// ---------------------------------------------------------------- what the agent reported to the hub

function hubFacts() {
  const events = jsonl(path.join(HUB, 'events.jsonl'));
  const state = fold(events);
  const tasks = state.tasks || state;
  const done = new Map();
  for (const e of events) if (e.type === 'done' && e.id) done.set(`${e.id}|${e.agent}`, e);
  return { tasks, done };
}

export function enrich(recs) {
  const { tasks, done } = hubFacts();
  return recs.map((r) => {
    const s = logState(r);
    const d = done.get(`${r.task}|${r.builder}`);
    const closed = r.closedReason ? 'closed' : null;
    return {
      ...r,
      state: r.closedReason && s.state !== 'running' ? (r.closedState ?? s.state) : s.state,
      closed,
      taskStatus: tasks[r.task]?.status ?? null,
      summary: d?.summary ? String(d.summary).replace(/\s+/g, ' ').slice(0, 320) : null,
      resume: resumeCommand(r),
    };
  });
}

// ---------------------------------------------------------------- html page

function html(items) {
  const data = JSON.stringify(items).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Agent history</title>
<style>
:root{--bg:#f7f6f2;--card:#fff;--ink:#1c2230;--muted:#5d6678;--line:#e3e0d6;--accent:#0b4a5a;--ok:#1a6b46;--bad:#b42318;--warn:#b54708;--code:#eef2f4}
@media (prefers-color-scheme:dark){:root{--bg:#12151b;--card:#1a1f28;--ink:#e8ecf3;--muted:#9aa4b6;--line:#2a313d;--accent:#5cc0d6;--ok:#6fd6a0;--bad:#ff8a80;--warn:#ffb86b;--code:#0f1720}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
.wrap{max-width:1180px;margin:0 auto;padding:28px 18px 60px}h1{margin:0 0 4px;font-size:28px}.sub{color:var(--muted);margin:0 0 18px}
.bar{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:14px}.bar input,.bar select{background:var(--card);color:var(--ink);border:1px solid var(--line);border-radius:10px;padding:9px 12px;font:inherit}.bar input{flex:1;min-width:220px}
.count{color:var(--muted);margin:6px 2px 10px;font-size:14px}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:14px 16px;margin-bottom:10px}
.top{display:flex;gap:10px;align-items:center;flex-wrap:wrap}.task{font-weight:700;font-size:16px}.ex{color:var(--muted)}
.badge{font-size:12px;font-weight:700;padding:2px 9px;border-radius:999px;border:1px solid var(--line)}
.running{color:var(--ok)}.finished{color:var(--ok)}.failed{color:var(--bad)}.stopped{color:var(--warn)}
.meta{color:var(--muted);font-size:13px;margin-top:2px}.sum{margin:8px 0 0}
.row{display:flex;gap:8px;align-items:center;margin-top:10px;flex-wrap:wrap}code{background:var(--code);padding:4px 8px;border-radius:8px;font:13px ui-monospace,Consolas,monospace;word-break:break-all}
button{background:var(--accent);color:#fff;border:0;border-radius:8px;padding:6px 12px;font:600 13px inherit;cursor:pointer}button.ghost{background:transparent;color:var(--accent);border:1px solid var(--accent)}
details{margin-top:8px;color:var(--muted);font-size:13px}
</style></head><body><div class="wrap">
<h1>Agent history</h1>
<p class="sub">Every agent session the hub started. Copy the resume command to bring a closed agent back, or run <code>node .agent-hub/tools/herdr-bridge.mjs reopen &lt;id&gt;</code> to open it in the Herdr grid. Generated ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC.</p>
<div class="bar"><input id="q" placeholder="Search task, executor, summary..."><select id="ex"><option value="">All agents</option></select><select id="st"><option value="">Any state</option><option>running</option><option>finished</option><option>failed</option><option>stopped</option></select></div>
<div class="count" id="count"></div><div id="list"></div></div>
<script>
const DATA=${data};
const $=(i)=>document.getElementById(i);
[...new Set(DATA.map(d=>d.executor).filter(Boolean))].sort().forEach(e=>{const o=document.createElement('option');o.textContent=e;$('ex').appendChild(o)});
const esc=(s)=>String(s??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
function render(){
  const q=$('q').value.toLowerCase(),ex=$('ex').value,st=$('st').value;
  const rows=DATA.filter(d=>(!ex||d.executor===ex)&&(!st||d.state===st)&&(!q||JSON.stringify([d.task,d.executor,d.summary,d.builder,d.id]).toLowerCase().includes(q)));
  $('count').textContent=rows.length+' of '+DATA.length+' sessions';
  $('list').innerHTML=rows.map((d,i)=>'<div class="card"><div class="top"><span class="task">'+esc(d.task||d.id)+'</span><span class="ex">'+esc(d.executor)+' '+esc(d.mode||'')+'</span><span class="badge '+esc(d.state)+'">'+esc(d.state)+'</span>'+(d.taskStatus?'<span class="badge">task '+esc(d.taskStatus)+'</span>':'')+(d.closedReason?'<span class="badge">closed: '+esc(d.closedReason)+'</span>':'')+'</div>'
   +'<div class="meta">'+esc((d.startedAt||'').slice(0,16).replace('T',' '))+' UTC &middot; '+esc(d.builder||'')+' &middot; job '+esc(d.id)+'</div>'
   +(d.summary?'<p class="sum">'+esc(d.summary)+'</p>':'')
   +'<div class="row"><code id="c'+i+'">'+esc(d.resume)+'</code><button data-c="'+i+'">Copy resume command</button>'+(d.sessionId?'':'<span class="meta">session id not found yet</span>')+'</div>'
   +'<details><summary>Files</summary>log: '+esc(d.log)+'<br>prompt: '+esc(d.prompt||'')+'<br>session: '+esc(d.sessionId||'-')+'</details></div>').join('');
  document.querySelectorAll('button[data-c]').forEach(b=>b.onclick=()=>{navigator.clipboard.writeText(document.getElementById('c'+b.dataset.c).textContent);b.textContent='Copied';setTimeout(()=>b.textContent='Copy resume command',1200)});
}
['q','ex','st'].forEach(i=>$(i).addEventListener('input',render));render();
</script></body></html>
`;
}

export function writeHtml() {
  const out = path.join(ROOT, 'docs', 'agents', 'index.html');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, html(enrich(readAll())));
  return out;
}

// ---------------------------------------------------------------- command line

function main() {
  const [, , cmd = 'list', ...rest] = process.argv;
  const arg = (n, d) => { const i = rest.indexOf(`--${n}`); return i >= 0 ? rest[i + 1] : d; };
  if (cmd === 'list') {
    let items = enrich(readAll());
    const t = arg('task'), e = arg('executor'), s = arg('status');
    if (t) items = items.filter((r) => r.task === t);
    if (e) items = items.filter((r) => r.executor === e);
    if (s) items = items.filter((r) => r.state === s);
    for (const r of items.slice(0, Number(arg('limit', 40)))) {
      console.log(`${(r.startedAt ?? '').slice(5, 16).replace('T', ' ')}  ${String(r.task ?? '').padEnd(26)} ${String(r.executor ?? '').padEnd(18)} ${String(r.state).padEnd(9)} ${r.sessionId ? 'session ok ' : 'no session '}${r.closedReason ? `closed:${r.closedReason}` : ''}`);
    }
    console.log(`${items.length} session(s)`);
  } else if (cmd === 'show') {
    const key = rest[0];
    const r = enrich(readAll()).find((x) => x.id === key || x.task === key);
    if (!r) { console.log('not found'); process.exit(1); }
    console.log(JSON.stringify(r, null, 2));
  } else if (cmd === 'discover') {
    console.log(`found ${discoverMissing({ all: rest.includes('--all') })} session id(s)`);
  } else if (cmd === 'backfill') {
    // Builds the library from the hub's job log for every agent that started before the library existed.
    let watch = {};
    try {
      const e = JSON.parse(fs.readFileSync(path.join(HUB, 'executors.json'), 'utf8'));
      for (const x of Array.isArray(e.executors) ? e.executors : Object.values(e.executors)) watch[x.name] = x.watch ?? null;
    } catch {}
    const have = new Set(readAll().map((r) => r.id));
    let added = 0;
    const jobs = new Map();
    for (const j of jsonl(path.join(HUB, 'runs', 'jobs.jsonl'))) jobs.set(j.id, { ...(jobs.get(j.id) ?? {}), ...j });
    for (const j of jobs.values()) {
      if (!j.id || have.has(j.id)) continue;
      const clean = j.id.replace(/-mw[a-z0-9]+$/, '');
      record({
        id: j.id, executor: j.executor, mode: j.review || j.mode === 'review' ? 'review' : 'headless',
        task: j.taskId ?? clean.replace(/^(builder-\d+-|review-)/, ''), builder: (clean.match(/^(builder-\d+)-/) || [])[1] || j.agentId || '',
        startedAt: j.t, log: j.log, prompt: j.log ? j.log.replace(/\.log$/, '.prompt.md') : null, base: j.id,
        sessionId: j.sessionId ?? null, watchTpl: watch[j.executor] ?? null, backfilled: true,
      });
      added++;
    }
    console.log(`backfilled ${added} agent session(s) from the job log`);
  } else if (cmd === 'html') {
    console.log(`written: ${writeHtml()}`);
  } else {
    console.error(`unknown command "${cmd}"`);
    process.exit(2);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
