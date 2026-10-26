#!/usr/bin/env node
// Orchestrator driver: lets any agent CLI be the project's orchestrator, with failover.
// It watches the hub autoloop and the user's WhatsApp replies, hands each batch of events to the
// agent on duty (headless, same session across turns), and when that agent hits quota/auth limits
// it switches to the next one in the order, tells the user, and the new agent takes over from
// docs/HANDOFF.md + the hub + the shared brain (ORCHESTRATOR.md says how).
// Every agent keeps its own safety layer: Claude-family in auto mode, Codex in its workspace
// sandbox (network on for GitHub/WhatsApp), OpenCode with its configured permissions.
//
//   node orch-driver.mjs [repoDir] [--order a,b,c] [--no-autoloop]      run the driver
//   node orch-driver.mjs [repoDir] --say "message"     one turn with that message, then exit
//   node orch-driver.mjs [repoDir] --cmd "status|use <entry>|order a,b|pause|resume|reset|models"
//
// An order entry is "<agent>" or "<agent>@<model>", e.g. claude-ag2@claude-sonnet-4-6 then
// claude-ag2@gemini-3.8-flash-high: each entry fails over on its own, so a down model falls through
// to the next model of the same lane. Order: /orch override (orch-control.json), else --order, else
// config.json "orchestrator.order", else the default below. The same commands work from WhatsApp
// as "/orch status", "/orch use codex@gpt-6", ... (handled here, no agent quota spent).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
if (argv.includes('--help')) { console.log('usage: node orch-driver.mjs [repoDir] [--order a,b,c] [--no-autoloop] [--say "message"] [--cmd "status|use <entry>|order a,b|pause|resume|reset|models"]'); process.exit(0); }
const opt = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv.splice(i, 2)[1] : undefined; };
const orderArg = opt('--order');
const sayOnce = opt('--say');
const cmdOnce = opt('--cmd');
const withAutoloop = !argv.includes('--no-autoloop');
const ROOT = path.resolve(argv.find((a) => !a.startsWith('--')) ?? '.');
const HUB = ['.hub', '.agent-hub'].map((d) => path.join(ROOT, d)).find((d) => fs.existsSync(path.join(d, 'config.json')));
if (!HUB) { console.error(`no hub in ${ROOT}: run agentify first`); process.exit(1); }
const KIT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PLAYBOOK = path.join(KIT, 'engine', 'ORCHESTRATOR.md');
const REPO = path.basename(ROOT);
const NODE = (process.env.DEVBOX_NODE || os.hostname()).toLowerCase();
const CFG = JSON.parse(fs.readFileSync(path.join(HUB, 'config.json'), 'utf8')).orchestrator ?? {};
const DEFAULT_ORDER = ['claude', 'codex', 'claude-or', 'claude-ag2@claude-sonnet-4-6', 'claude-ag2@gemini-3.8-flash-high', 'claude-oc1'];
const BASE_ORDER = (orderArg?.split(',') ?? CFG.order ?? DEFAULT_ORDER).map((s) => s.trim()).filter(Boolean);
const CONTROL = path.join(HUB, 'orch-control.json');   // /orch overrides: { order?, paused? }
const control = () => { try { return JSON.parse(fs.readFileSync(CONTROL, 'utf8')); } catch { return {}; } };
const setControl = (patch) => fs.writeFileSync(CONTROL, JSON.stringify({ ...control(), ...patch }, null, 2));
const order = () => control().order ?? BASE_ORDER;
const BATCH_MS = (CFG.batchSeconds ?? 20) * 1000;
const IDLE_MS = (CFG.idleMinutes ?? 60) * 60_000;
const DOWN_MS = (CFG.downMinutes ?? 30) * 60_000;
const TURN_MS = (CFG.turnMinutes ?? 30) * 60_000;
const SILENCE_MS = (CFG.silenceMinutes ?? 5) * 60_000;
const STATE = path.join(HUB, 'orch-driver.json');
const LOG = path.join(HUB, 'runs', 'orchestrator.log');
const WA = path.join(os.homedir(), '.config', 'waha', 'wa.mjs');
const LIMIT = /usage limit|rate.?limit|quota|exhausted|insufficient balance|\b402\b|\b429\b|unauthori[sz]ed|invalid bearer|not logged in|credits?\b|overloaded|expired|no output for \d+ min/i;

// Driver state is per machine: keep it out of git without touching the repo's .gitignore.
try {
  const ex = path.join(ROOT, '.git', 'info', 'exclude');
  for (const file of [STATE, CONTROL]) {
    const rel = path.relative(ROOT, file).split(path.sep).join('/');
    if (!fs.readFileSync(ex, 'utf8').includes(rel)) fs.appendFileSync(ex, `\n${rel}\n`);
  }
} catch { /* worktree or no .git dir */ }
const st = (() => { try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { return { sessions: {}, down: {} }; } })();
const save = () => fs.writeFileSync(STATE, JSON.stringify(st, null, 2));
const log = (s) => { const line = `${new Date().toISOString().slice(5, 19)} ${s}`; console.log(line); fs.mkdirSync(path.dirname(LOG), { recursive: true }); fs.appendFileSync(LOG, line + '\n'); };
const notify = (text) => fs.existsSync(WA) && spawn(process.execPath, [WA, 'send', text], { cwd: ROOT, stdio: 'ignore', windowsHide: true });
st.until ??= {};
const healthy = (a) => !(st.until[a] > Date.now());
// How long an entry stays down: missing command 24h, a stated reset time until then, else DOWN_MS.
function downFor(r) {
  if (r.code === -1 && /ENOENT|not found/i.test(r.out)) return 24 * 60 * 60_000;
  const m = r.out.match(/resets (?:at )?(\d{1,2})(?::(\d\d))?\s*(am|pm)/i);
  if (m) {
    const t = new Date(); let h = Number(m[1]) % 12 + (m[3].toLowerCase() === 'pm' ? 12 : 0);
    t.setHours(h, Number(m[2] ?? 0), 0, 0); if (t < Date.now()) t.setDate(t.getDate() + 1);
    return Math.max(t - Date.now(), 60_000);
  }
  return DOWN_MS;
}
const until = (e) => new Date(st.until[e]).toTimeString().slice(0, 5);

// How each CLI family runs one headless turn and resumes the same session next time.
function command(entry, prompt, sid) {
  const [agent, model] = entry.split('@');
  if (agent.startsWith('codex')) {
    const opts = ['-c', 'sandbox_mode="workspace-write"', '-c', 'sandbox_workspace_write.network_access=true', '--skip-git-repo-check', ...(model ? ['-m', model] : [])];
    return sid ? [agent, ['exec', 'resume', ...opts, sid, prompt]] : [agent, ['exec', ...opts, '-C', ROOT, prompt]];
  }
  if (agent === 'opencode') return [agent, ['run', ...(model ? ['-m', model] : []), ...(sid ? ['-s', sid] : []), '--format', 'json', prompt]];
  // claude and claude-* launchers: auto mode keeps the safety review on every action. stream-json
  // makes progress visible, so a hung lane is caught by the silence watchdog instead of the turn limit.
  return [agent, ['-p', prompt, '--permission-mode', 'auto', '--output-format', 'stream-json', '--verbose', ...(model ? ['--model', model] : []),
    ...(sid ? ['--resume', sid] : ['--session-id', st.pending = crypto.randomUUID()])]];
}
const sessionFrom = (entry, out) => {
  const agent = entry.split('@')[0];
  if (agent.startsWith('codex')) return out.match(/session id:\s*([0-9a-f-]{36})/i)?.[1];
  if (agent === 'opencode') return out.match(/"sessionID"\s*:\s*"([^"]+)"/)?.[1];
  return st.pending;
};

// /orch commands from WhatsApp or --cmd: the user steers the driver without spending agent quota.
async function orchCommand(text) {
  const [verb = 'status', ...rest] = text.trim().split(/\s+/);
  const arg = rest.join(' ');
  const mins = (e) => Math.ceil((st.until[e] - Date.now()) / 60000);
  // WhatsApp-friendly: one entry per line, ✅ ready / ⛔ down, "agent · model".
  const pretty = (e) => e.replace('@', ' · ');
  const list = () => order().map((e, i) => `${i + 1}. ${healthy(e) ? '✅' : '⛔'} ${pretty(e)}${healthy(e) ? '' : `  (down until ${until(e)})`}`).join('\n');
  const onDuty = () => order().find(healthy);
  const HELP = '_/orch status · use · order · models · pause · resume · reset_';
  switch (verb) {
    case 'use': {
      if (!arg) return 'Usage: /orch use <agent>[@model]\ne.g. /orch use claude-ag2@gemini-3.8-flash-high';
      setControl({ order: [arg, ...order().filter((e) => e !== arg)] });
      delete st.until[arg]; save();
      return `👉 Next turn: *${pretty(arg)}*\nOrder:\n${list()}`;
    }
    case 'order': {
      const items = arg.split(/[,\s]+/).filter(Boolean);
      if (!items.length) return 'Usage: /orch order a,b,c   (or /orch order default)';
      setControl({ order: items[0] === 'default' ? undefined : items });
      return `🔁 New order:\n${list()}`;
    }
    case 'pause': setControl({ paused: true }); return '⏸️ Paused. Events are kept and handled after /orch resume.';
    case 'resume': setControl({ paused: false }); return `▶️ Resumed. On duty: *${pretty(onDuty() ?? 'none')}*`;
    case 'reset': st.until = {}; save(); return `♻️ Every agent marked ready again.\nOrder:\n${list()}`;
    case 'models': {
      const lines = ['*Models* (pick with /orch use <agent>@<model>)'];
      try {
        const ids = (await (await fetch('http://127.0.0.1:8080/v1/models')).json()).data.map((m) => m.id);
        lines.push('', '*claude-ag2@*', ...ids.map((id) => `• ${id}`));
      } catch { lines.push('', '*claude-ag2@*', '• (Antigravity proxy not reachable here)'); }
      lines.push('', '*claude@*', '• opus · sonnet · haiku', '', '*codex@*', '• a model of your ChatGPT plan, e.g. gpt-6',
        '', '*opencode@*', '• provider/model, e.g. opencode-go/glm-5.3-flash');
      return lines.join('\n');
    }
    default: {
      const c = control();
      return [`${c.paused ? '⏸️ *Paused*\n' : ''}On duty: *${pretty(onDuty() ?? 'none available')}*${st.current && st.current !== onDuty() ? `  (last turn: ${pretty(st.current)})` : ''}`,
        'Order:', list(), HELP].join('\n');
    }
  }
}

function turn(agent, prompt) {
  return new Promise((resolve) => {
    const [cmd, args] = command(agent, prompt, st.sessions[agent]);
    const child = spawn(cmd, args, { cwd: ROOT, env: { ...process.env, AGENT_PROJECT: REPO, PATH: [path.join(os.homedir(), '.claude-launchers'), path.join(os.homedir(), '.local', 'bin'), process.env.PATH].join(path.delimiter) }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: process.platform === 'win32' });  // no stdin: CLIs wait on an open pipe
    let out = '';
    let quietSince = Date.now();
    const take = (d) => { out += d; quietSince = Date.now(); fs.appendFileSync(LOG, d); };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    const timer = setTimeout(() => child.kill('SIGTERM'), TURN_MS);
    // An agent that prints nothing for SILENCE_MS is stuck (e.g. its provider keeps rate-limiting): fail over.
    const watchdog = setInterval(() => {
      if (Date.now() - quietSince > SILENCE_MS) { out += `\n[driver] no output for ${SILENCE_MS / 60000} min: rate limit or hang\n`; child.kill('SIGTERM'); }
    }, 15_000);
    const done = (code, text) => { clearTimeout(timer); clearInterval(watchdog); resolve({ code, out: text }); };
    child.on('error', (e) => done(-1, String(e.message)));
    child.on('close', (code) => done(code, out));
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
  const failed = [];
  for (const agent of order().filter(healthy)) {
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
      if (failed.length) notify(`⚠️ Switched to *${agent.replace('@', ' · ')}*\n${failed.join('\n')}`);
      st.pausedNote = null; save();
      busy = false;
      return;
    }
    const why = (r.out.match(LIMIT)?.[0] ?? `exit ${r.code}`).slice(0, 60);
    st.until[agent] = Date.now() + downFor(r);
    delete st.sessions[agent];   // start clean next time: the old session may be what failed
    save();
    const reason = r.code === -1 && /ENOENT/i.test(r.out) ? 'not installed here' : why;
    failed.push(`⛔ ${agent.replace('@', ' · ')}: ${reason} (until ${until(agent)})`);
    log(`${agent} unavailable (${reason}) until ${until(agent)}; next: ${order().filter(healthy)[0] ?? 'none'}`);
    takeover = agent;
  }
  // Nobody could take it. Say so once (not again until something changes or 3 hours pass).
  if (failed.length) {
    const next = Math.min(...order().map((e) => st.until[e] ?? Infinity));
    const note = `⏸️ No agent available right now, I retry at ${new Date(next).toTimeString().slice(0, 5)}.\n${failed.join('\n')}`;
    if (st.pausedNote?.text !== note.split('\n')[0] || Date.now() - st.pausedNote.at > 3 * 3600_000) {
      notify(note); st.pausedNote = { text: note.split('\n')[0], at: Date.now() }; save();
    }
  }
  busy = false;
  queue.unshift(...events);   // nobody could take it: keep it for the retry
}

const push = (line) => { lastEvent = Date.now(); queue.push(line); };

setInterval(() => {
  if (busy || control().paused) return;
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

if (cmdOnce) {
  console.log(await orchCommand(cmdOnce));
  process.exit(0);
}
if (sayOnce) {
  await handle([`USER (terminal): ${sayOnce}`]);
  process.exit(0);
}
log(`driver up for ${REPO} on ${NODE}; order: ${order().join(' → ')}`);
if (withAutoloop) follow('autoloop', process.execPath, [path.join(HUB, 'autoloop.mjs')]);
// "/orch ..." messages steer the driver itself; every other user message goes to the agent on duty.
if (fs.existsSync(WA)) follow('whatsapp', process.execPath, [WA, 'inbox'], (l) => {
  if (!l.startsWith('WHATSAPP')) return false;
  const m = l.match(/^WHATSAPP \d\d:\d\d: \/orch\b\s*(.*)$/i);
  if (!m) return true;
  orchCommand(m[1]).then((reply) => { log(`/orch ${m[1]} -> ${reply.split('\n')[0]}`); notify(reply); });
  return false;
});
push('START: the driver just started. Load context, post one short WhatsApp status line, then continue.');
