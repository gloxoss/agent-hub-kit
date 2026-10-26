#!/usr/bin/env node
// Shared board: mirrors this machine's hub tasks to GitHub issues so several machines
// (PC, vps1, vps2...) working on the same repo see one board and never run the same task twice.
// Usage (from the repo root):
//   node .hub/board.mjs sync [--dry]     create/update one issue per hub task (labels: status + machine)
//   node .hub/board.mjs claim <task>     claim a task for this machine; exit 3 if another machine owns it
//   node .hub/board.mjs release <task>   give a claim back
//   node .hub/board.mjs note <task> "t"  leave a note other machines' orchestrators read
//   node .hub/board.mjs status           every board task, across machines
// Machine name = $DEVBOX_NODE or the hostname. Needs the GitHub CLI logged in (gh auth status).
// Issue title "[<task id>] <title>" is the key, so no local mapping file is needed.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const HUB = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const NODE = (process.env.DEVBOX_NODE || os.hostname()).toLowerCase();
const CFG = (() => { try { return JSON.parse(fs.readFileSync(path.join(HUB, 'config.json'), 'utf8')); } catch { return {}; } })();
const STATUS = { OPEN: 'planned', ASSIGNED: 'planned', CLAIMED: 'in-progress', BLOCKED: 'blocked', REVIEW: 'review',
  VERIFIED: 'verified', REWORK: 'rework', ACCEPTED: 'accepted', CANCELLED: 'cancelled' };
const COLORS = { planned: 'c5def5', 'in-progress': 'fbca04', blocked: 'b60205', review: '1d76db', verified: '0e8a16',
  rework: 'e99695', accepted: '5319e7', pushed: '0e8a16', cancelled: 'cccccc' };
const dry = process.argv.includes('--dry');
const adopt = process.argv.includes('--adopt');
const [cmd, id, ...rest] = process.argv.slice(2).filter((a) => a !== '--dry' && a !== '--adopt');

const gh = (args, input) => execFileSync('gh', args, { encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
const git = (args) => { try { return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).trim(); } catch { return ''; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Same fold as hub.mjs, reduced to what the board shows.
function localTasks() {
  const file = path.join(HUB, 'events.jsonl');
  const tasks = {};
  if (!fs.existsSync(file)) return tasks;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let e; try { e = JSON.parse(line); } catch { continue; }
    const t = tasks[e.id];
    switch (e.type) {
      case 'task-add': tasks[e.id] = { id: e.id, phase: e.phase, title: e.title, scope: e.scope ?? [], deps: e.deps ?? [], status: 'OPEN', history: [] }; break;
      case 'assign': if (t && ['OPEN', 'REWORK'].includes(t.status)) t.status = 'ASSIGNED'; break;
      case 'claim': if (t) Object.assign(t, { status: 'CLAIMED', by: e.agent }); break;
      case 'block': if (t) Object.assign(t, { status: 'BLOCKED', note: e.note }); break;
      case 'release': if (t) t.status = 'OPEN'; break;
      case 'done': if (t) Object.assign(t, { status: 'REVIEW', summary: e.summary, doneBy: e.agent }); break;
      case 'verify': if (t) Object.assign(t, { status: e.ok ? 'VERIFIED' : 'REWORK', verifyNote: e.note }); break;
      case 'accept': if (t) Object.assign(t, { status: 'ACCEPTED', acceptedAt: e.t }); break;
      case 'reject': if (t) Object.assign(t, { status: 'REWORK', note: e.note }); break;
      case 'edit': if (t) for (const k of ['title', 'scope', 'deps']) if (e[k] !== undefined) t[k] = e[k]; break;
      case 'cancel': if (t) t.status = 'CANCELLED'; break;
    }
    const cur = tasks[e.id];
    if (cur && e.type !== 'task-add') cur.history.push(`${e.t.slice(5, 16)} ${e.type} ${e.agent ?? ''}${e.node ? ` @${e.node}` : ''}`.trim());
    // The machine of a task's latest event owns its board row; old events have no machine field
    // and count as this machine's only with --adopt (run once on the machine whose log is live).
    if (cur) cur.node = e.node ?? (adopt ? NODE : cur.node);
  }
  return tasks;
}

// Accepted work counts as pushed once a commit naming the task is on the remote branch (anyone can pull it).
function pushedCommit(taskId) {
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
  return git(['log', `origin/${branch}`, '--fixed-strings', `--grep=${taskId}`, '-1', '--format=%h %s']);
}

let issueCache;
function issues() {
  if (!issueCache) {
    const list = JSON.parse(gh(['issue', 'list', '--label', 'board', '--state', 'all', '--limit', '1000', '--json', 'number,title,state,labels,body']));
    issueCache = new Map(list.map((i) => [i.title.match(/^\[([^\]]+)\]/)?.[1], i]).filter(([k]) => k));
  }
  return issueCache;
}
const ensuredLabels = new Set();
function ensureLabel(name) {
  if (ensuredLabels.has(name) || dry) return;
  const color = name.startsWith('node:') ? 'bfd4f2' : COLORS[name.slice(7)] ?? 'ededed';
  try { gh(['label', 'create', name, '--color', color, '--force']); } catch { /* exists */ }
  ensuredLabels.add(name);
}

function bodyFor(t, status, commit) {
  return [
    `**Status:** ${status}${t.machine ? ` · **machine:** ${t.machine}` : ''}${commit ? ` · **pushed:** \`${commit}\` (pull to get it)` : ''}`,
    `**Phase:** ${t.phase ?? '-'} · **deps:** ${t.deps.join(', ') || 'none'}`,
    `**Scope:** ${t.scope.map((s) => `\`${s}\``).join(', ') || '-'}`,
    t.summary ? `\n**Done summary:** ${t.summary}` : '',
    t.note ? `\n**Last note:** ${t.note}` : '',
    `\n<details><summary>History (${t.history.length})</summary>\n\n${t.history.slice(-15).map((h) => `- ${h}`).join('\n')}\n</details>`,
    `\n<sub>Mirrored from the hub by board.mjs on ${NODE}. Edit the task in the hub, not here.</sub>`,
  ].filter(Boolean).join('\n');
}

async function syncOne(t) {
  const commit = t.status === 'ACCEPTED' ? pushedCommit(t.id) : '';
  const status = commit ? 'pushed' : STATUS[t.status] ?? 'planned';
  // A machine label only once a machine actually started the task.
  if (!['OPEN', 'ASSIGNED'].includes(t.status)) t.machine = t.node;
  const wanted = ['board', `status:${status}`, ...(t.machine ? [`node:${t.machine}`] : [])];
  const title = `[${t.id}] ${t.title}`;
  const body = bodyFor(t, status, commit);
  const closed = status === 'pushed' || status === 'cancelled';
  const cur = issues().get(t.id);
  if (!cur) {
    console.log(`create  ${title}  (${status})`);
    if (dry) return;
    wanted.forEach(ensureLabel);
    const url = gh(['issue', 'create', '--title', title, '--body-file', '-', ...wanted.flatMap((l) => ['--label', l])], body).trim();
    if (closed) gh(['issue', 'close', url, '--reason', status === 'pushed' ? 'completed' : 'not planned']);
    return;
  }
  const have = cur.labels.map((l) => l.name);
  const add = wanted.filter((l) => !have.includes(l));
  // Keep other machines' node labels: a task can move between machines.
  const remove = have.filter((l) => l.startsWith('status:') && !wanted.includes(l));
  const stateWrong = closed !== (cur.state === 'CLOSED');
  if (!add.length && !remove.length && cur.body === body && cur.title === title && !stateWrong) return;
  console.log(`update  ${title}  (${status})`);
  if (dry) return;
  add.forEach(ensureLabel);
  gh(['issue', 'edit', String(cur.number), '--title', title, '--body-file', '-',
    ...add.flatMap((l) => ['--add-label', l]), ...remove.flatMap((l) => ['--remove-label', l])], body);
  if (stateWrong) gh(closed ? ['issue', 'close', String(cur.number)] : ['issue', 'reopen', String(cur.number)]);
}

function comments(num) {
  const repo = gh(['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner']).trim();
  return JSON.parse(gh(['api', `repos/${repo}/issues/${num}/comments?per_page=100`]));
}
// Owner = first CLAIM after the last RELEASE by that owner; GitHub orders comments, so two machines
// claiming at the same moment both see the same winner.
function ownerOf(num) {
  let owner = null;
  for (const c of comments(num)) {
    const m = c.body.match(/^(CLAIM|RELEASE) node=(\S+)/);
    if (!m) continue;
    if (m[1] === 'CLAIM' && !owner) owner = m[2];
    if (m[1] === 'RELEASE' && owner === m[2]) owner = null;
  }
  return owner;
}

switch (cmd) {
  case 'sync': {
    // Only rows this machine is live for: another machine's copy of the log may be stale.
    const all = Object.values(localTasks());
    const mine = all.filter((t) => t.node === NODE);
    for (const t of mine) await syncOne(t);
    console.log(`${dry ? '[dry] ' : ''}${mine.length} of ${all.length} hub tasks are live on ${NODE} and checked${mine.length < all.length && !adopt ? ' (first run on the live machine: add --adopt)' : ''}`);
    break;
  }
  case 'claim': {
    const t = localTasks()[id];
    if (!t) { console.error(`unknown task ${id}`); process.exit(1); }
    await syncOne(t);
    issueCache = undefined;
    const issue = issues().get(id);
    const before = ownerOf(issue.number);
    if (before && before !== NODE) { console.log(`${id} is owned by ${before}`); process.exit(3); }
    if (!before) { gh(['issue', 'comment', String(issue.number), '--body', `CLAIM node=${NODE} at ${new Date().toISOString()}`]); await sleep(4000); }
    const owner = ownerOf(issue.number);
    if (owner !== NODE) { console.log(`${id} was claimed first by ${owner}`); process.exit(3); }
    ensureLabel(`node:${NODE}`);
    gh(['issue', 'edit', String(issue.number), '--add-label', `node:${NODE}`]);
    console.log(`${id} claimed by ${NODE}`);
    break;
  }
  case 'release': {
    const issue = issues().get(id);
    if (issue && ownerOf(issue.number) === NODE) gh(['issue', 'comment', String(issue.number), '--body', `RELEASE node=${NODE}`]);
    console.log(`${id} released by ${NODE}`);
    break;
  }
  case 'note': {
    const issue = issues().get(id);
    if (!issue) { console.error(`no board issue for ${id}: run sync first`); process.exit(1); }
    gh(['issue', 'comment', String(issue.number), '--body', `NOTE node=${NODE}: ${rest.join(' ')}`]);
    console.log('noted');
    break;
  }
  case 'status': {
    for (const [tid, i] of issues()) {
      if (!tid) continue;
      const labels = i.labels.map((l) => l.name);
      const st = labels.find((l) => l.startsWith('status:'))?.slice(7) ?? '?';
      const nodes = labels.filter((l) => l.startsWith('node:')).map((l) => l.slice(5)).join(',') || '-';
      console.log(`${st.padEnd(12)} ${nodes.padEnd(14)} #${String(i.number).padEnd(5)} ${tid}`);
    }
    break;
  }
  default:
    console.log('usage: board.mjs sync [--dry] | claim <task> | release <task> | note <task> "text" | status');
    if (!CFG.board?.enabled) console.log('(board is off for this hub: set "board": {"enabled": true} in config.json)');
}
