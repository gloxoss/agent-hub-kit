#!/usr/bin/env node
// Orchestrator driver v2: runs one project's manager agent, with failover, on a small set of modules.
//   node orch-driver.mjs [repoDir]                 run the daemon (one per project; a lock file prevents two)
//   node orch-driver.mjs [repoDir] --cmd "status"  run one /orch command and print the reply
//   node orch-driver.mjs [repoDir] --say "text"    one manager turn with an owner message; reply printed, not sent
//   flags: --no-autoloop  --no-wa  --help          ORCH_DRY=1 prints the chosen agent and its command, runs nothing
// Flow: events (autoloop + owner WhatsApp) -> wake filter -> select (quota-ranked) -> runner (caps, guard) -> reply/ledger/report.
// Costly managers never write code; a side responder answers the owner while the manager is busy.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { resolveConfig } from '../orchestrator/config.mjs';
import { loadState, saveState } from '../orchestrator/state.mjs';
import { EventIntake, ownerText } from '../orchestrator/events.mjs';
import { candidates, markDown, recordTurn, turnsInLastHour, ownerClaudeNotice, outageMessage, downKey } from '../orchestrator/select.mjs';
import { runTurn } from '../orchestrator/runner.mjs';
import { extractReply, extractSessionId, turnStats, failureOf } from '../orchestrator/reply.mjs';
import { bootstrapPrompt, continuePrompt, responderPrompt, digest } from '../orchestrator/prompt.mjs';
import { runCommand, readControl } from '../orchestrator/commands.mjs';
import { createReporter } from '../orchestrator/report.mjs';
import { shouldRotate, appendLedgerRecord } from '../orchestrator/telemetry.mjs';
import { burnStats, burnLimits, burnVerdict } from '../orchestrator/burn.mjs';

const argv = process.argv.slice(2);
if (argv.includes('--help')) {
  console.log('usage: node orch-driver.mjs [repoDir] [--cmd "status|quotas|use <id>|order ...|pause|resume|reset|models|shot <route>"] [--say "text"] [--no-autoloop] [--no-wa]');
  process.exit(0);
}
const opt = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv.splice(i, 2)[1] : undefined; };
const cmdOnce = opt('--cmd');
const sayOnce = opt('--say');
const noAutoloop = argv.includes('--no-autoloop');
const noWa = argv.includes('--no-wa');
const DRY = process.env.ORCH_DRY === '1';

// Only the few vault values the driver and its agents need; never the whole vault.
try {
  for (const line of fs.readFileSync(path.join(os.homedir(), '.config', 'devbox', 'vault', 'env'), 'utf8').split(/\r?\n/)) {
    const m = line.match(/^(CLIPROXY_[A-Z]+|CLAUDE_CODE_OAUTH_TOKEN|OPENROUTER_API_KEY|DEEPSEEK_API_KEY)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
} catch { /* no vault on this machine */ }

const cfg = resolveConfig(path.resolve(argv.find((a) => !a.startsWith('--')) ?? '.'));
process.chdir(cfg.root);
const o = cfg.orchestrator;
const st = loadState(cfg.hubPath);
st.sessions = Object.fromEntries(Object.entries(st.sessions ?? {}).filter(([, v]) => v && typeof v === 'object'));   // drop pre-v2 string sessions
const save = () => saveState(cfg.hubPath, st);
const LOG = path.join(cfg.hubPath, 'runs', 'orchestrator.log');
const WA = path.join(os.homedir(), '.config', 'waha', 'wa.mjs');
const log = (s) => {
  const line = `${new Date().toISOString().slice(5, 19)} ${s}`;
  console.log(line);
  try { fs.mkdirSync(path.dirname(LOG), { recursive: true }); fs.appendFileSync(LOG, line + '\n'); } catch { /* log is best effort */ }
};

// WhatsApp. Replies to the owner use the plain path (never throttled or deduplicated); everything else is --auto (budgeted, merged).
let toTerminal = false;
function wa(args) {
  if (toTerminal || noWa || DRY || !fs.existsSync(WA)) return;
  spawnSync(process.execPath, [WA, ...args], { cwd: cfg.root, env: { ...process.env, AGENT_PROJECT: cfg.projectName }, timeout: 60_000, windowsHide: true });
}
const sendReply = (text) => (toTerminal ? console.log(text) : wa(['send', text]));
const sendAuto = (text) => (toTerminal ? console.log(text) : wa(['send', '--auto', text]));
const sendImage = (file, caption) => wa(['image', file, caption]);

let intake = null;
const ctx = { cfg, st, save, sendImage, resumeDispatch: () => intake?.resumeAutoloop() };
const control = () => readControl(cfg);
let busy = false;
const queue = [];        // system events waiting for the manager
const ownerQueue = [];   // owner messages waiting for the manager
const history = [];      // owner <-> side-responder conversation to hand to the manager
const quotaBurst = [];
const reporter = createReporter({ cfg, st, save, sendAuto, isIdle: () => !busy && /Running \(0\)/.test(digest(cfg)) });

// Side responder: answers the owner at once while the manager is busy. Read-only (edit tools denied for every responder).
async function respondWhileBusy(text) {
  history.push(`owner: ${text}`);
  const entry = candidates({ role: 'responder', st, hubDir: cfg.hubPath, control: control() })[0];
  if (!entry) { sendReply('Got it. The manager is busy and no side helper is free; I will answer after its current step.'); return; }
  const res = await runTurn({ ...entry, cost: 'plan' }, responderPrompt({ cfg, ownerText: text, history: history.slice(-6) }), { id: crypto.randomUUID() });
  const fail = failureOf(res);
  if (fail) { markDown(st, entry.id, fail.downMs, fail.reason); save(); sendReply('Got it. The manager is busy; I will answer after its current step.'); return; }
  const reply = extractReply(res.stdout, entry.family) || 'Received. The manager will answer after its current step.';
  history.push(`responder: ${reply}`);
  sendReply(reply);
  log(`responder ${entry.id} answered the owner while the manager was busy`);
  const handoff = path.join(cfg.hubPath, 'runs', 'responder-handoff.md');
  if (fs.existsSync(handoff) && fs.readFileSync(handoff, 'utf8').trim()) queue.push('OWNER-CHAT: the side responder left notes for you in runs/responder-handoff.md; act on them.');
}

// One manager turn. Tries the ranked managers in order; failovers are silent; an all-down outage is announced once.
async function managerTurn({ events, owner }) {
  busy = true;
  const failed = [];
  try {
    for (const entry of candidates({ role: 'orchestrator', st, hubDir: cfg.hubPath, control: control() })) {
      const sess = st.sessions[entry.id] ?? {};
      const fresh = !sess.sid || shouldRotate({ currentTokens: sess.contextTokens ?? 0, turns: sess.turns ?? 0 }, o.rotate).shouldRotate;
      const convo = history.splice(0);
      const takeover = st.current && st.current !== entry.id ? st.current : null;
      const prompt = fresh ? bootstrapPrompt({ cfg, entry, events, owner, conversation: convo, takeover }) : continuePrompt({ cfg, entry, events, owner, conversation: convo });
      const newId = crypto.randomUUID();
      log(`turn -> ${entry.id}${fresh ? ' (new session)' : ''}: ${events.length} event(s), ${owner.length} owner message(s)`);
      const res = await runTurn(entry, prompt, fresh ? { id: newId } : { sid: sess.sid });
      const fail = failureOf(res);
      if (fail) {
        markDown(st, entry.id, fail.downMs, fail.reason);
        delete st.sessions[entry.id];
        history.unshift(...convo);
        save();
        failed.push(`${entry.id}: ${fail.reason}`);
        log(`${entry.id} unavailable (${fail.reason}) until ${new Date(st.down[entry.id]).toTimeString().slice(0, 5)}`);
        continue;
      }
      const stats = turnStats(res.stdout, entry.family);
      const sid = (fresh ? extractSessionId(res.stdout, entry.family) ?? newId : sess.sid);
      st.sessions[entry.id] = { sid, turns: fresh ? 1 : (sess.turns ?? 0) + 1, contextTokens: stats.contextTokens, lastAt: Date.now() };
      st.current = entry.id;
      st.alertKey = null;
      recordTurn(st, entry.id);
      save();
      appendLedgerRecord(cfg.hubPath, { entry: entry.id, session: sid, usage: stats.usage, cost: stats.costUsd ?? 0, contextTokens: stats.contextTokens, wake: owner.length ? 'owner' : 'system' });
      const notice = ownerClaudeNotice(entry, st);
      if (notice && !st.noticedOwnerClaude) { sendAuto(notice); st.noticedOwnerClaude = true; save(); }
      if (entry.owner !== 'user') st.noticedOwnerClaude = false;
      const reply = extractReply(res.stdout, entry.family);
      if (reply && !/^NOOP\b/i.test(reply)) { (owner.length ? sendReply : sendAuto)(reply); reporter.track(reply); }
      else if (owner.length) sendReply(`${entry.id} read your message but gave no answer, so nothing was changed. Ask again, or use /orch status, /orch quotas, /orch use <id>.`);
      return;
    }
    // Nobody could take the turn: keep the work, tell the owner once per distinct outage.
    queue.unshift(...events);
    ownerQueue.unshift(...owner);
    const key = downKey(st);
    if (owner.length) sendReply(outageMessage({ st, hubDir: cfg.hubPath }));
    else if (st.alertKey !== key) { sendAuto(outageMessage({ st, hubDir: cfg.hubPath })); st.alertKey = key; save(); }
    log(`no manager available (${failed.join('; ') || 'all marked down'})`);
  } finally { busy = false; }
}

async function tick() {
  if (busy) return;
  const owner = ownerQueue.splice(0);
  const events = control().paused ? [] : queue.splice(0);
  if (!owner.length && !events.length) return;
  if (!owner.length && turnsInLastHour(st) >= o.maxTurnsPerHour) { queue.unshift(...events); return; }   // budget: only owner messages bypass the cap
  try { await managerTurn({ events, owner }); } catch (e) { busy = false; log(`turn error: ${e.message}`); }
}

function onOwner(text) {
  reporter.answered();
  if (/^\/orch\b/i.test(text)) { runCommand(text, ctx).then(sendReply).catch((e) => sendReply(`Command failed: ${e.message}`)); return; }
  if (busy) { respondWhileBusy(text).catch((e) => log(`responder error: ${e.message}`)); return; }
  ownerQueue.push(text);
  setImmediate(tick);
}

async function main() {
  if (cmdOnce !== undefined) { console.log(await runCommand(cmdOnce, ctx)); return; }
  if (sayOnce !== undefined) { toTerminal = true; await managerTurn({ events: [], owner: [sayOnce] }); return; }

  const lock = path.join(cfg.hubPath, 'orch-driver.lock');
  try {
    const other = Number(fs.readFileSync(lock, 'utf8'));
    if (other && other !== process.pid) { process.kill(other, 0); console.log(`another driver (pid ${other}) already runs ${cfg.projectName}; exiting`); process.exit(0); }
  } catch { /* no lock, or the old owner is gone */ }
  fs.writeFileSync(lock, String(process.pid));
  const unlock = () => { try { if (fs.readFileSync(lock, 'utf8') === String(process.pid)) fs.unlinkSync(lock); } catch { /* already gone */ } };
  process.on('exit', unlock);
  process.on('exit', () => intake?.stop());   // the driver's own helpers die with it; running workers are not touched
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(0));

  log(`driver up for ${cfg.projectName} on ${cfg.nodeName}`);
  intake = new EventIntake(cfg, { autoloop: !noAutoloop, whatsapp: !noWa }).start({ holdAutoloop: Boolean(st.burn?.tripped) });
  if (st.burn?.tripped) log(`dispatching stays held from before the restart: ${st.burn.why}`);
  intake.on('wake', (ev) => {
    if (ev.wakeClass === 'user') return onOwner(ownerText(ev.line));
    if (ev.wakeClass === 'quota') {   // autoloop already moves work on a lane quota hit; wake only on a burst
      quotaBurst.push(ev.at); while (quotaBurst.length && ev.at - quotaBurst[0] > 30 * 60_000) quotaBurst.shift();
      if (quotaBurst.length >= 5) { quotaBurst.length = 0; queue.push('QUOTA burst: five lane quota failures in 30 minutes; check allowance and lanes.'); }
      return;
    }
    if (['decide', 'sync', 'start'].includes(ev.wakeClass)) queue.push(ev.line);
  });
  setInterval(() => tick().catch((e) => log(`tick error: ${e.message}`)), 20_000);
  // Quota-burn breaker: many jobs and nothing accepted means allowance is draining without progress. Hold dispatch, tell the owner why.
  setInterval(() => {
    try {
      if (st.burn?.tripped || noAutoloop) return;
      const lim = burnLimits(cfg);
      const verdict = burnVerdict(burnStats(cfg.hubPath, lim.windowMinutes), lim);
      if (!verdict) return;
      if (verdict.kind === 'no-progress') {
        intake?.pauseAutoloop();
        st.burn = { tripped: true, at: new Date().toISOString(), why: verdict.why };
        save();
        log(`burn breaker tripped: ${verdict.why}`);
        sendAuto(`Dispatching is paused to protect your quota.\n${verdict.why}\nRunning workers finish; nothing new starts. Check why nothing is being accepted, then send /orch resume.`);
      } else if (st.burn?.loopKey !== verdict.why) {
        st.burn = { ...(st.burn ?? {}), loopKey: verdict.why };
        save();
        sendAuto(`Warning: ${verdict.why} The autoloop stops it after its rework limit; reply if you want it held now.`);
      }
    } catch (e) { log(`burn check error: ${e.message}`); }
  }, 5 * 60_000);
  setInterval(() => { try { reporter.tick(); } catch (e) { log(`report error: ${e.message}`); } }, 120_000);
  if (turnsInLastHour(st) === 0) queue.push('START: the driver just started. Load context and report where things stand.');
}

main().catch((e) => { console.error(e); process.exit(1); });
