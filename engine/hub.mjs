#!/usr/bin/env node
// Agent hub. Orchestrator plans, assigns and accepts; workers claim, build and report;
// a verifier who is not the worker checks the result. State is an append-only event log.
// Usage: node .agent-hub/hub.mjs <command> [args]   (run from the repo root, Node 20+)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HUB = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HUB);
const HUB_NAME = path.basename(HUB);
const EVENTS = path.join(HUB, 'events.jsonl');
const BOARD = path.join(HUB, 'BOARD.md');
const CHANGELOG = path.join(HUB, 'CHANGELOG.md');
const TASKS_DIR = path.join(HUB, 'tasks');
const BRIEF_TEMPLATE = path.join(HUB, 'templates', 'brief.md');
const TTL_MIN = 45;
const PHASES = ['localize', 'audit', 'map', 'tokens', 'scaffold', 'build', 'assemble', 'chore'];
// Build-type work cannot be accepted until a different agent has verified it.
const NEEDS_VERIFY = new Set(['build', 'assemble', 'scaffold', 'tokens']);
const ID_RE = /^[A-Z]-[a-z0-9][a-z0-9-]*$/;

// ---------- args ----------
const [cmd, ...rest] = process.argv.slice(2);
const pos = [];
const opt = {};
for (let i = 0; i < rest.length; i++) {
  const a = rest[i];
  if (a.startsWith('--')) {
    const k = a.slice(2);
    const next = rest[i + 1];
    if (next === undefined || next.startsWith('--')) opt[k] = true;
    else { opt[k] = next; i++; }
  } else pos.push(a);
}
const list = (v) => (typeof v === 'string' ? v.split(',').map((s) => s.trim().replace(/\\/g, '/')).filter(Boolean) : []);
const me = opt.agent || process.env.AGENT_ID;
const now = () => new Date().toISOString();
const ago = (t) => Math.round((Date.now() - Date.parse(t)) / 60000);

function fail(msg, code = 1) { console.error(`hub: ${msg}`); process.exit(code); }
function need(v, name) { if (!v || v === true) fail(`missing ${name}`); return v; }

// ---------- state ----------
function readEvents() {
  if (!fs.existsSync(EVENTS)) return [];
  return fs.readFileSync(EVENTS, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}
// Every event names the machine that wrote it, so the shared board (board.mjs) knows which
// machine's log is the live one for each task when several machines work on one repo.
const NODE = (process.env.DEVBOX_NODE || os.hostname()).toLowerCase();
function emit(type, data) {
  const ev = { t: now(), type, agent: me ?? null, node: NODE, ...data };
  fs.appendFileSync(EVENTS, JSON.stringify(ev) + '\n');
  return ev;
}

function fold(events) {
  const agents = {};
  const tasks = {};
  const messages = [];
  for (const e of events) {
    if (e.agent && agents[e.agent]) agents[e.agent].lastSeen = e.t;
    switch (e.type) {
      case 'join': agents[e.agent] = { id: e.agent, role: e.role, tool: e.tool, note: e.note, lastSeen: e.t, active: true }; break;
      case 'leave': if (agents[e.agent]) agents[e.agent].active = false; for (const t of Object.values(tasks)) if (t.claimedBy === e.agent) { t.claimedBy = null; t.files = []; if (t.status === 'CLAIMED') t.status = t.assignee ? 'ASSIGNED' : 'OPEN'; } break;
      case 'heartbeat': if (agents[e.agent]) agents[e.agent].note = e.note ?? agents[e.agent].note; break;
      case 'task-add': tasks[e.id] = { id: e.id, phase: e.phase, title: e.title, deps: e.deps ?? [], scope: e.scope ?? [], status: 'OPEN', assignee: null, claimedBy: null, files: [], history: [] }; break;
      case 'assign': tasks[e.id].assignee = e.to; if (['OPEN', 'REWORK'].includes(tasks[e.id].status) && !tasks[e.id].claimedBy) tasks[e.id].status = 'ASSIGNED'; break;
      case 'claim': Object.assign(tasks[e.id], { claimedBy: e.agent, files: e.files, status: 'CLAIMED' }); break;
      case 'files': tasks[e.id].files = [...new Set([...tasks[e.id].files, ...e.files])]; break;
      case 'progress': tasks[e.id].lastNote = e.note; break;
      case 'block': Object.assign(tasks[e.id], { status: 'BLOCKED', lastNote: e.note }); break;
      case 'release': Object.assign(tasks[e.id], { claimedBy: null, files: [], status: tasks[e.id].assignee ? 'ASSIGNED' : 'OPEN', lastNote: e.note }); break;
      case 'done': Object.assign(tasks[e.id], { status: 'REVIEW', doneBy: e.agent, summary: e.summary, changed: e.files, verifyCmd: e.verify, claimedBy: null, files: [] }); break;
      case 'verify': Object.assign(tasks[e.id], { status: e.ok ? 'VERIFIED' : 'REWORK', verifiedBy: e.agent, verifyNote: e.note, report: e.report }); break;
      case 'accept': Object.assign(tasks[e.id], { status: 'ACCEPTED', acceptNote: e.note }); break;
      case 'reject': Object.assign(tasks[e.id], { status: 'REWORK', lastNote: e.note }); break;
      case 'edit': for (const k of ['deps', 'scope', 'title', 'needsVerify', 'strict']) if (e[k] !== undefined) tasks[e.id][k] = e[k]; break;
      case 'cancel': Object.assign(tasks[e.id], { status: 'CANCELLED', claimedBy: null, files: [], lastNote: e.note }); break;
      case 'say': messages.push(e); break;
    }
    if (e.id && tasks[e.id] && e.type !== 'task-add') tasks[e.id].history.push(`${e.t.slice(5, 16)} ${e.type} ${e.agent ?? ''}`);
  }
  for (const a of Object.values(agents)) a.stale = a.active && ago(a.lastSeen) > TTL_MIN;
  return { agents, tasks, messages };
}

const state = () => fold(readEvents());
function task(s, id) { return s.tasks[need(id, 'task id')] ?? fail(`unknown task ${id}`); }
function requireJoined(s) {
  if (!me) fail('set AGENT_ID or pass --agent');
  if (!s.agents[me]?.active) fail(`${me} has not joined (run: join --role ... --tool ...)`);
  return s.agents[me];
}
function requireRole(s, ...roles) {
  const a = requireJoined(s);
  if (!roles.includes(a.role)) fail(`${me} is ${a.role}; this command needs ${roles.join(' or ')}`);
  return a;
}
// Optimistic deps: a dep counts once it is built and in review, so lanes never idle on review time.
// If that dep is later sent back, the dependant may need a small rework. Tasks marked strict wait for ACCEPTED.
const BUILT = new Set(['REVIEW', 'VERIFIED', 'ACCEPTED']);
const depsMet = (s, t) => t.deps.every((d) => (t.strict ? s.tasks[d]?.status === 'ACCEPTED' : BUILT.has(s.tasks[d]?.status)));
// Per-task verifier requirement; defaults by phase.
const needsVerify = (t) => t.needsVerify ?? NEEDS_VERIFY.has(t.phase);
const overlaps = (a, b) => a === b || a.startsWith(b.replace(/\/?$/, '/')) || b.startsWith(a.replace(/\/?$/, '/'));

function fileConflicts(s, id, files) {
  const out = [];
  for (const t of Object.values(s.tasks)) {
    if (t.id === id || !t.claimedBy) continue;
    if (s.agents[t.claimedBy]?.stale) continue;
    for (const f of files) for (const g of t.files) if (overlaps(f, g)) out.push(`${f} (held by ${t.claimedBy} under ${t.id})`);
  }
  return out;
}

function outOfScope(t, files) {
  if (!t.scope.length) return [];
  // Ports are claimed like files ("port:4310") so two dev servers never collide; they are always in scope.
  return files.filter((f) => !f.startsWith('port:') && !t.scope.some((s) => f === s || f.startsWith(s.replace(/\/?$/, '/'))));
}

// ---------- board ----------
function renderBoard(s) {
  const by = (st) => Object.values(s.tasks).filter((t) => t.status === st);
  const row = (t) => `| ${t.id} | ${t.phase} | ${t.title} | ${t.assignee ?? '-'} | ${t.claimedBy ?? '-'} | ${t.deps.join(', ') || '-'} | ${t.lastNote ?? ''} |`;
  const table = (rows) => rows.length ? `| Task | Phase | Title | Assignee | Claimed by | Deps | Note |\n|---|---|---|---|---|---|---|\n${rows.map(row).join('\n')}` : '_none_';
  const agents = Object.values(s.agents).filter((a) => a.active);
  const review = [...by('REVIEW'), ...by('VERIFIED')];
  const md = `# Agent hub board

Generated ${now()} by \`hub.mjs\`. Do not edit by hand.

## Agents
${agents.length ? agents.map((a) => `- **${a.id}** (${a.role}, ${a.tool}) last seen ${ago(a.lastSeen)} min ago${a.stale ? ' **STALE**' : ''}${a.note ? `: ${a.note}` : ''}`).join('\n') : '_none active_'}

## Needs the orchestrator
${review.length ? review.map((t) => `- **${t.id}** ${t.status}${t.status === 'REVIEW' && needsVerify(t) ? ' (waiting for verifier)' : ''}: ${t.summary ?? ''}${t.verifyNote ? ` / verifier: ${t.verifyNote}` : ''}`).join('\n') : '_nothing waiting_'}

## Blocked or rework
${table([...by('BLOCKED'), ...by('REWORK')])}

## In progress
${table(by('CLAIMED'))}

## Claimed files
${Object.values(s.tasks).filter((t) => t.claimedBy).map((t) => `- ${t.id} (${t.claimedBy}): ${t.files.join(', ')}`).join('\n') || '_none_'}

## Ready (deps accepted)
${table([...by('ASSIGNED'), ...by('OPEN')].filter((t) => depsMet(s, t)))}

## Waiting on deps
${table([...by('ASSIGNED'), ...by('OPEN')].filter((t) => !depsMet(s, t)))}

## Accepted
${by('ACCEPTED').map((t) => `- ${t.id}: ${t.summary ?? t.title}`).join('\n') || '_none_'}

## Messages (last 15)
${s.messages.slice(-15).map((m) => `- ${m.t.slice(5, 16)} **${m.agent}**${m.to ? ` → ${m.to}` : ''}: ${m.text}`).join('\n') || '_none_'}
`;
  fs.writeFileSync(BOARD, md);
}

function appendChangelog(lines) {
  if (!fs.existsSync(CHANGELOG)) fs.writeFileSync(CHANGELOG, '# Hub changelog\n\nOne entry per finished, verified, and accepted task. Written by `hub.mjs`.\n');
  fs.appendFileSync(CHANGELOG, `\n${lines.join('\n')}\n`);
}

// ---------- commands ----------
const commands = {
  help() {
    console.log(`Agent hub (${HUB})
Everyone
  join --agent ID --role orchestrator|worker|verifier --tool claude|codex|gemini|other [--note N]
  status | inbox | log [--n 30] | show TASK | say "text" [--to ID] | heartbeat [--note N] | leave
Orchestrator
  add TASK --phase ${PHASES.join('|')} --title T [--deps A,B] [--scope paths] [--to AGENT]
  assign TASK --to AGENT | accept TASK --note N | reject TASK --note N
  edit TASK [--deps a,b] [--scope paths] [--title T] [--to AGENT] [--verify on|off] [--strict on|off] | cancel TASK --note N
  kick AGENT [--note N]       retire a closed worker session and release its claims
Worker
  next | claim TASK --files a,b | files TASK --add a,b | progress TASK --note N
  block TASK --note N | release TASK [--note N]
  done TASK --summary S --files a,b --verify "cmd -> result"
Verifier (never the agent who did the task)
  verify TASK --ok|--fail --note N [--report path]
Task ids look like L-site, A-site-page, B-section-name. Briefs: ${HUB_NAME}/tasks/<TASK>.md
Exit codes: 0 ok, 1 usage or rule error, 3 conflict (file or task held by someone else)`);
  },

  join() {
    need(me, '--agent');
    const role = need(opt.role, '--role');
    if (!['orchestrator', 'worker', 'verifier'].includes(role)) fail('role must be orchestrator, worker or verifier');
    const s = state();
    if (s.agents[me]?.active && !s.agents[me].stale) fail(`${me} is already active; pick another id or leave first`);
    if (role === 'orchestrator') {
      const other = Object.values(s.agents).find((a) => a.active && !a.stale && a.role === 'orchestrator' && a.id !== me);
      if (other) fail(`${other.id} is already the orchestrator`, 3);
    }
    emit('join', { role, tool: opt.tool ?? 'other', note: opt.note });
    console.log(`joined as ${me} (${role}). Read ${HUB_NAME}/PROTOCOL.md, then: status, inbox, ${role === 'worker' ? 'next' : role === 'verifier' ? 'status (REVIEW tasks)' : 'add / assign'}`);
  },

  add() {
    const s = state();
    requireRole(s, 'orchestrator');
    const id = need(pos[0], 'task id');
    if (!ID_RE.test(id)) fail(`task id must match ${ID_RE}`);
    if (s.tasks[id]) fail(`${id} already exists`);
    const phase = need(opt.phase, '--phase');
    if (!PHASES.includes(phase)) fail(`phase must be one of ${PHASES.join(', ')}`);
    const deps = list(opt.deps);
    for (const d of deps) if (!s.tasks[d]) fail(`unknown dep ${d}`);
    emit('task-add', { id, phase, title: need(opt.title, '--title'), deps, scope: list(opt.scope) });
    const brief = path.join(TASKS_DIR, `${id}.md`);
    if (!fs.existsSync(brief)) {
      const tpl = fs.existsSync(BRIEF_TEMPLATE) ? fs.readFileSync(BRIEF_TEMPLATE, 'utf8') : '# {{id}}\n';
      fs.mkdirSync(TASKS_DIR, { recursive: true });
      fs.writeFileSync(brief, tpl.replaceAll('{{id}}', id).replaceAll('{{phase}}', phase).replaceAll('{{title}}', opt.title).replaceAll('{{deps}}', deps.join(', ') || 'none').replaceAll('{{scope}}', list(opt.scope).join(', ') || 'see Scope'));
    }
    if (opt.to) emit('assign', { id, to: opt.to });
    console.log(`added ${id}${opt.to ? ` assigned to ${opt.to}` : ''}. Fill the brief: ${path.relative(ROOT, brief)}`);
  },

  assign() {
    const s = state();
    requireRole(s, 'orchestrator');
    const t = task(s, pos[0]);
    emit('assign', { id: t.id, to: need(opt.to, '--to') });
    console.log(`${t.id} → ${opt.to}`);
  },

  next() {
    const s = state();
    requireJoined(s);
    const mine = Object.values(s.tasks).filter((t) => (t.assignee === me || t.claimedBy === me) && !['ACCEPTED', 'REVIEW', 'VERIFIED'].includes(t.status));
    const toVerify = s.agents[me].role === 'verifier' ? Object.values(s.tasks).filter((t) => t.status === 'REVIEW' && needsVerify(t) && t.doneBy !== me) : [];
    if (!mine.length && !toVerify.length) return console.log('nothing assigned to you. Wait for the orchestrator or check inbox.');
    for (const t of toVerify) console.log(`VERIFY ${t.id}: ${t.summary} (done by ${t.doneBy})`);
    for (const t of mine) console.log(`${t.status.padEnd(9)} ${t.id} ${depsMet(s, t) ? '' : `(waiting on ${t.deps.filter((d) => s.tasks[d]?.status !== 'ACCEPTED').join(', ')}) `}brief: ${HUB_NAME}/tasks/${t.id}.md`);
  },

  claim() {
    const s = state();
    requireRole(s, 'worker');
    const t = task(s, pos[0]);
    if (t.assignee && t.assignee !== me) fail(`${t.id} is assigned to ${t.assignee}`, 3);
    if (t.claimedBy && t.claimedBy !== me && !s.agents[t.claimedBy]?.stale) fail(`${t.id} is held by ${t.claimedBy}`, 3);
    if (!['OPEN', 'ASSIGNED', 'REWORK', 'BLOCKED', 'CLAIMED'].includes(t.status)) fail(`${t.id} is ${t.status}`);
    if (!depsMet(s, t)) fail(`${t.id} waits on ${t.deps.join(', ')}`);
    const files = list(need(opt.files, '--files'));
    const bad = outOfScope(t, files);
    if (bad.length) fail(`outside the task scope (${t.scope.join(', ')}): ${bad.join(', ')}. Ask the orchestrator.`);
    const c = fileConflicts(s, t.id, files);
    if (c.length) fail(`conflict:\n  ${c.join('\n  ')}`, 3);
    emit('claim', { id: t.id, files });
    console.log(`claimed ${t.id}: ${files.join(', ')}`);
  },

  files() {
    const s = state();
    requireRole(s, 'worker');
    const t = task(s, pos[0]);
    if (t.claimedBy !== me) fail(`you do not hold ${t.id}`);
    const files = list(need(opt.add, '--add'));
    const bad = outOfScope(t, files);
    if (bad.length) fail(`outside the task scope: ${bad.join(', ')}. Ask the orchestrator.`);
    const c = fileConflicts(s, t.id, files);
    if (c.length) fail(`conflict:\n  ${c.join('\n  ')}`, 3);
    emit('files', { id: t.id, files });
    console.log(`${t.id} now holds ${[...new Set([...t.files, ...files])].join(', ')}`);
  },

  heartbeat() { const s = state(); requireJoined(s); emit('heartbeat', { note: opt.note }); console.log('ok'); },

  progress() {
    const s = state(); requireJoined(s);
    const t = task(s, pos[0]);
    emit('progress', { id: t.id, note: need(opt.note, '--note') });
    console.log('noted');
  },

  block() {
    const s = state(); requireRole(s, 'worker');
    const t = task(s, pos[0]);
    emit('block', { id: t.id, note: need(opt.note, '--note') });
    emit('say', { text: `${t.id} BLOCKED: ${opt.note}`, to: Object.values(s.agents).find((a) => a.active && a.role === 'orchestrator')?.id });
    console.log(`${t.id} blocked; orchestrator notified`);
  },

  release() {
    const s = state(); requireJoined(s);
    const t = task(s, pos[0]);
    if (t.claimedBy !== me) fail(`you do not hold ${t.id}`);
    emit('release', { id: t.id, note: opt.note });
    console.log(`released ${t.id}`);
  },

  done() {
    const s = state(); requireRole(s, 'worker');
    const t = task(s, pos[0]);
    if (t.claimedBy !== me) fail(`you do not hold ${t.id}`);
    const summary = need(opt.summary, '--summary');
    const files = list(need(opt.files, '--files'));
    const verify = need(opt.verify, '--verify');
    const unclaimed = files.filter((f) => !t.files.some((g) => overlaps(f, g)));
    if (unclaimed.length) fail(`you changed files you never claimed: ${unclaimed.join(', ')}. Claim them with files --add first.`);
    emit('done', { id: t.id, summary, files, verify });
    appendChangelog([`## ${t.id} · ${t.phase} · done by ${me} · ${now().slice(0, 16)}`, `- Summary: ${summary}`, `- Files: ${files.join(', ')}`, `- Proof: ${verify}`]);
    console.log(`${t.id} → REVIEW${needsVerify(t) ? ' (needs a verifier, then the orchestrator)' : ' (orchestrator reviews)'}`);
  },

  verify() {
    const s = state(); requireRole(s, 'verifier', 'orchestrator');
    const t = task(s, pos[0]);
    if (t.status !== 'REVIEW') fail(`${t.id} is ${t.status}, not REVIEW`);
    if (t.doneBy === me) fail('self-verification is refused');
    if (!opt.ok && !opt.fail) fail('pass --ok or --fail');
    emit('verify', { id: t.id, ok: !!opt.ok, note: need(opt.note, '--note'), report: typeof opt.report === 'string' ? opt.report : undefined });
    appendChangelog([`- Verify by ${me}: ${opt.ok ? 'PASS' : 'FAIL'}. ${opt.note}${typeof opt.report === 'string' ? ` Report: ${opt.report}` : ''}`]);
    console.log(`${t.id} → ${opt.ok ? 'VERIFIED' : 'REWORK'}`);
  },

  accept() {
    const s = state(); requireRole(s, 'orchestrator');
    const t = task(s, pos[0]);
    if (needsVerify(t) ? t.status !== 'VERIFIED' : !['REVIEW', 'VERIFIED'].includes(t.status)) fail(`${t.id} is ${t.status}; ${t.phase} tasks need ${needsVerify(t) ? 'VERIFIED' : 'REVIEW'} first`);
    emit('accept', { id: t.id, note: need(opt.note, '--note') });
    appendChangelog([`- Accepted by ${me}: ${opt.note}`]);
    console.log(`${t.id} ACCEPTED`);
  },

  reject() {
    const s = state(); requireRole(s, 'orchestrator');
    const t = task(s, pos[0]);
    emit('reject', { id: t.id, note: need(opt.note, '--note') });
    if (t.doneBy) emit('say', { text: `${t.id} sent back: ${opt.note}`, to: t.doneBy });
    appendChangelog([`- Rejected by ${me}: ${opt.note}`]);
    console.log(`${t.id} → REWORK`);
  },

  edit() {
    const s = state(); requireRole(s, 'orchestrator');
    const t = task(s, pos[0]);
    // Widening a scope never invalidates a held claim, so it is allowed mid-task.
    const flagsOnly = opt.deps === undefined && opt.title === undefined && opt.scope === undefined && (opt.verify !== undefined || opt.strict !== undefined);
    const widenOnly = flagsOnly || (opt.scope !== undefined && opt.deps === undefined && opt.title === undefined && t.scope.every((s) => list(opt.scope).includes(s)));
    if (t.claimedBy && !widenOnly) fail(`${t.id} is claimed by ${t.claimedBy}; only a scope widening is allowed while claimed`, 3);
    const patch = {};
    if (opt.deps !== undefined) { patch.deps = list(opt.deps); for (const d of patch.deps) if (!s.tasks[d]) fail(`unknown dep ${d}`); }
    if (opt.scope !== undefined) patch.scope = list(opt.scope);
    if (typeof opt.title === 'string') patch.title = opt.title;
    if (opt.verify === 'on' || opt.verify === 'off') patch.needsVerify = opt.verify === 'on';
    if (opt.strict === 'on' || opt.strict === 'off') patch.strict = opt.strict === 'on';
    if (!Object.keys(patch).length) fail('nothing to edit (use --deps, --scope, --title, --verify on|off, --strict on|off)');
    emit('edit', { id: t.id, ...patch });
    if (opt.to) emit('assign', { id: t.id, to: opt.to });
    console.log(`${t.id} updated`);
  },

  // A worker whose session was closed keeps its claims until it goes stale (45 min). The orchestrator
  // can retire it now: its claims are released and its tasks go back to ASSIGNED for re-dispatch.
  kick() {
    const s = state(); requireRole(s, 'orchestrator');
    const target = need(pos[0], 'agent id');
    if (!s.agents[target]?.active) fail(`${target} is not active`);
    const held = Object.values(s.tasks).filter((t) => t.claimedBy === target).map((t) => t.id);
    fs.appendFileSync(EVENTS, JSON.stringify({ t: now(), type: 'leave', agent: target, by: me, note: opt.note ?? 'retired by orchestrator' }) + '\n');
    console.log(`${target} retired${held.length ? `; released ${held.join(', ')}` : ''}`);
  },

  cancel() {
    const s = state(); requireRole(s, 'orchestrator');
    const t = task(s, pos[0]);
    const dependants = Object.values(s.tasks).filter((x) => x.deps.includes(t.id) && x.status !== 'CANCELLED').map((x) => x.id);
    if (dependants.length) fail(`re-point these tasks first (edit --deps): ${dependants.join(', ')}`);
    emit('cancel', { id: t.id, note: need(opt.note, '--note') });
    console.log(`${t.id} CANCELLED`);
  },

  say() {
    const s = state(); requireJoined(s);
    emit('say', { text: need(pos.join(' '), 'text'), to: opt.to });
    console.log('sent');
  },

  inbox() {
    const s = state(); requireJoined(s);
    const mine = s.messages.filter((m) => !m.to || m.to === me).slice(-20);
    console.log(mine.map((m) => `${m.t.slice(5, 16)} ${m.agent}${m.to ? ` → ${m.to}` : ''}: ${m.text}`).join('\n') || 'no messages');
  },

  show() {
    const t = task(state(), pos[0]);
    console.log(JSON.stringify(t, null, 2));
  },

  status() {
    const s = state();
    renderBoard(s);
    const count = {};
    for (const t of Object.values(s.tasks)) count[t.status] = (count[t.status] ?? 0) + 1;
    const active = Object.values(s.agents).filter((a) => a.active);
    console.log(`agents: ${active.map((a) => `${a.id}(${a.role}${a.stale ? ',STALE' : ''})`).join(' ') || 'none'}`);
    console.log(`tasks: ${Object.entries(count).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}`);
    console.log(`board: ${path.relative(ROOT, BOARD)}`);
  },

  log() {
    const n = Number(opt.n ?? 30);
    for (const e of readEvents().slice(-n)) console.log(`${e.t.slice(5, 19)} ${e.agent ?? '-'} ${e.type} ${e.id ?? ''} ${e.note ?? e.summary ?? e.text ?? e.title ?? ''}`);
  },

  leave() {
    const s = state(); requireJoined(s);
    emit('leave', {});
    console.log(`${me} left; claims released`);
  },
};

if (!cmd || cmd === 'help' || !commands[cmd]) { commands.help(); process.exit(cmd && cmd !== 'help' ? 1 : 0); }
commands[cmd]();
if (!['help', 'status'].includes(cmd)) renderBoard(state());
