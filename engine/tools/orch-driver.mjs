#!/usr/bin/env node
// Orchestrator driver: lets any agent CLI be the project's orchestrator, with failover.
// It watches the hub autoloop and the user's WhatsApp replies, hands each batch of events to the
// agent on duty (headless, same session across turns), and when that agent hits quota/auth limits
// it switches to the next one in the order, tells the user, and the new agent takes over from
// docs/HANDOFF.md + the hub + the shared brain (ORCHESTRATOR.md says how).
// Every agent keeps its own safety layer: Claude-family in auto mode, Codex in its workspace
// sandbox (network on for GitHub/WhatsApp), OpenCode with its configured permissions.
//
//   node orch-driver.mjs [repoDir] [--order claude,codex,claude-ag2-gemini] [--no-autoloop]
//   node orch-driver.mjs [repoDir] --say "message"     one turn with that message, then exit
//
// Order: --order, else config.json "orchestrator.order", else the default below.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
if (argv.includes('--help')) { console.log('usage: node orch-driver.mjs [repoDir] [--order a,b,c] [--no-autoloop] [--say "message"]'); process.exit(0); }
const opt = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv.splice(i, 2)[1] : undefined; };
const orderArg = opt('--order');
const sayOnce = opt('--say');
const withAutoloop = !argv.includes('--no-autoloop');
const ROOT = path.resolve(argv.find((a) => !a.startsWith('--')) ?? '.');
const HUB = ['.hub', '.agent-hub'].map((d) => path.join(ROOT, d)).find((d) => fs.existsSync(path.join(d, 'config.json')));
if (!HUB) { console.error(`no hub in ${ROOT}: run agentify first`); process.exit(1); }
const KIT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PLAYBOOK = path.join(KIT, 'engine', 'ORCHESTRATOR.md');
const REPO = path.basename(ROOT);
const NODE = (process.env.DEVBOX_NODE || os.hostname()).toLowerCase();
const CFG = JSON.parse(fs.readFileSync(path.join(HUB, 'config.json'), 'utf8')).orchestrator ?? {};
const ORDER = (orderArg?.split(',') ?? CFG.order ?? ['claude', 'codex', 'claude-ag2-gemini', 'claude-oc1', 'opencode']).map((s) => s.trim()).filter(Boolean);
const BATCH_MS = (CFG.batchSeconds ?? 20) * 1000;
const IDLE_MS = (CFG.idleMinutes ?? 60) * 60_000;
const DOWN_MS = (CFG.downMinutes ?? 30) * 60_000;
const TURN_MS = (CFG.turnMinutes ?? 30) * 60_000;
const STATE = path.join(HUB, 'orch-driver.json');
const LOG = path.join(HUB, 'runs', 'orchestrator.log');
const WA = path.join(os.homedir(), '.config', 'waha', 'wa.mjs');
const LIMIT = /usage limit|rate.?limit|quota|exhausted|insufficient balance|\b402\b|\b429\b|unauthori[sz]ed|invalid bearer|not logged in|credits?\b|overloaded/i;

// Driver state is per machine: keep it out of git without touching the repo's .gitignore.
try {
  const ex = path.join(ROOT, '.git', 'info', 'exclude');
  const rel = path.relative(ROOT, STATE).split(path.sep).join('/');
  if (!fs.readFileSync(ex, 'utf8').includes(rel)) fs.appendFileSync(ex, `\n${rel}\n`);
} catch { /* worktree or no .git dir */ }
const st = (() => { try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { return { sessions: {}, down: {} }; } })();
const save = () => fs.writeFileSync(STATE, JSON.stringify(st, null, 2));
const log = (s) => { const line = `${new Date().toISOString().slice(5, 19)} ${s}`; console.log(line); fs.mkdirSync(path.dirname(LOG), { recursive: true }); fs.appendFileSync(LOG, line + '\n'); };
const notify = (text) => fs.existsSync(WA) && spawn(process.execPath, [WA, 'send', text], { cwd: ROOT, stdio: 'ignore', windowsHide: true });
const healthy = (a) => !st.down[a] || Date.now() - st.down[a] > DOWN_MS;

// How each CLI family runs one headless turn and resumes the same session next time.
function command(agent, prompt, sid) {
  if (agent.startsWith('codex')) {
    const sandbox = ['--sandbox', 'workspace-write', '-c', 'sandbox_workspace_write.network_access=true'];
    return sid ? [agent, ['exec', 'resume', ...sandbox, sid, prompt]] : [agent, ['exec', '--skip-git-repo-check', ...sandbox, '-C', ROOT, prompt]];
  }
  if (agent === 'opencode') return [agent, ['run', ...(sid ? ['-s', sid] : []), '--format', 'json', prompt]];
  // claude and claude-* launchers: auto mode keeps the safety review on every action.
  return [agent, ['-p', prompt, '--permission-mode', 'auto', ...(sid ? ['--resume', sid] : ['--session-id', st.pending = crypto.randomUUID()])]];
}
const sessionFrom = (agent, out) => {
  if (agent.startsWith('codex')) return out.match(/session id:\s*([0-9a-f-]{36})/i)?.[1];
  if (agent === 'opencode') return out.match(/"sessionID"\s*:\s*"([^"]+)"/)?.[1];
  return st.pending;
};

function turn(agent, prompt) {
  return new Promise((resolve) => {
    const [cmd, args] = command(agent, prompt, st.sessions[agent]);
    const child = spawn(cmd, args, { cwd: ROOT, env: { ...process.env, AGENT_PROJECT: REPO }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: process.platform === 'win32' });  // no stdin: CLIs wait on an open pipe
    let out = '';
    const take = (d) => { out += d; fs.appendFileSync(LOG, d); };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    const timer = setTimeout(() => child.kill('SIGTERM'), TURN_MS);
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, out: String(e.message) }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, out }); });
  });
}

const bootstrap = (agent, takeover) => [
  `You are the orchestrator of the project "${REPO}" on machine "${NODE}" (driver turn, agent: ${agent}).`,
  `Read and follow ${PLAYBOOK} now (it tells you where all context lives and how to work).`,
  takeover ? `You take over from ${takeover}. Read docs/HANDOFF.md and the hub status first, then continue its work.` : '',
  'Then handle the events below. End the turn by updating docs/HANDOFF.md as the playbook says.',
].filter(Boolean).join('\n');

let busy = false;
let queue = [];
let lastEvent = Date.now();

async function handle(events) {
  busy = true;
  const body = `EVENTS:\n${events.join('\n')}`;
  let takeover = null;
  for (const agent of ORDER.filter(healthy)) {
    const fresh = !st.sessions[agent];
    const prompt = fresh || takeover ? `${bootstrap(agent, takeover)}\n\n${body}` : `${body}\n\nHandle these per the playbook; update docs/HANDOFF.md before you finish.`;
    log(`turn → ${agent}${fresh ? ' (new session)' : ''}: ${events.length} event(s)`);
    const r = await turn(agent, prompt);
    const sid = sessionFrom(agent, r.out);
    if (r.code === 0 && !(LIMIT.test(r.out.slice(-600)) && r.out.length < 1500)) {
      if (sid) st.sessions[agent] = sid;
      st.current = agent;
      save();
      log(`turn ok (${agent})`);
      busy = false;
      return;
    }
    const why = (r.out.match(LIMIT)?.[0] ?? `exit ${r.code}`).slice(0, 60);
    st.down[agent] = Date.now();
    delete st.sessions[agent];   // start clean next time: the old session may be what failed
    save();
    const next = ORDER.filter(healthy)[0];
    log(`${agent} unavailable (${why}); next: ${next ?? 'none'}`);
    notify(next ? `Orchestrator switch: ${agent} is unavailable (${why}); ${next} takes over.` : `Orchestrator paused: every agent is unavailable (last: ${agent}, ${why}). Retrying in ${DOWN_MS / 60000} min.`);
    takeover = agent;
  }
  busy = false;
  queue.unshift(...events);   // nobody could take it: keep it for the retry
}

const push = (line) => { lastEvent = Date.now(); queue.push(line); };

setInterval(() => {
  if (busy) return;
  if (!queue.length && Date.now() - lastEvent > IDLE_MS) push(`TICK ${new Date().toISOString().slice(11, 16)}: no events for ${IDLE_MS / 60000} min; check the hub and keep lanes busy within quota.`);
  if (queue.length) { const batch = queue; queue = []; handle(batch); }
}, BATCH_MS);

function follow(name, cmd, args, filter = () => true) {
  const child = spawn(cmd, args, { cwd: ROOT, windowsHide: true });
  let buf = '';
  child.stdout.on('data', (d) => {
    buf += d;
    const lines = buf.split('\n'); buf = lines.pop();
    for (const l of lines.map((x) => x.trim()).filter(Boolean)) if (filter(l)) push(`${name}: ${l}`);
  });
  child.on('close', (code) => { log(`${name} stopped (${code}); restarting in 10s`); setTimeout(() => follow(name, cmd, args, filter), 10_000); });
}

if (sayOnce) {
  await handle([`USER (terminal): ${sayOnce}`]);
  process.exit(0);
}
log(`driver up for ${REPO} on ${NODE}; order: ${ORDER.join(' → ')}`);
if (withAutoloop) follow('autoloop', process.execPath, [path.join(HUB, 'autoloop.mjs')]);
if (fs.existsSync(WA)) follow('whatsapp', process.execPath, [WA, 'inbox'], (l) => l.startsWith('WHATSAPP'));
push('START: the driver just started. Load context, post one short WhatsApp status line, then continue.');
