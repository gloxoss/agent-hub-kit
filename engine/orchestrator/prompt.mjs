// prompt.mjs: what each manager turn is told. A short live digest of the fleet plus rules; no regex intent detection.
// No project names, paths or people live here: everything comes from the resolved config.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isCheap } from '../accounts.mjs';
import { burnStats, burnLine } from './burn.mjs';
import { runningLines } from './jobs-view.mjs';

const KIT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const PLAYBOOK = path.join(KIT, 'engine', 'ORCHESTRATOR.md');

const run = (cmd, args, cwd, ms = 15_000) => {
  try { return spawnSync(cmd, args, { cwd, encoding: 'utf8', timeout: ms, windowsHide: true }).stdout?.trim() ?? ''; } catch { return ''; }
};

// ~15 lines: running jobs, review queue, last accepts, last commit, hub task counts.
export function digest(cfg) {
  const hub = cfg.hubPath;
  const lines = [];
  const jobs = runningLines(hub, cfg.root);
  lines.push(jobs.length ? `Running (${jobs.length}):` : 'Running (0): nothing');
  lines.push(...jobs);
  const status = run(process.execPath, [path.join(hub, 'hub.mjs'), 'status'], cfg.root);
  const tasks = status.split('\n').find((l) => l.startsWith('tasks:'));
  if (tasks) lines.push(tasks.trim());
  try {
    const ev = fs.readFileSync(path.join(hub, 'events.jsonl'), 'utf8').trim().split('\n').slice(-4000).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    const accepts = ev.filter((e) => e.type === 'accept').slice(-3).map((e) => `${e.id} (${String(e.t).slice(11, 16)})`);
    lines.push(`Last accepts: ${accepts.join(', ') || 'none'}`);
  } catch { /* no events yet */ }
  try { lines.push(burnLine(burnStats(hub, 180))); } catch { /* no jobs yet */ }
  // The real reason work waits: which assistants cannot be used right now, and until when (from the engine's own records).
  try {
    const health = JSON.parse(fs.readFileSync(path.join(hub, 'runs', 'health.json'), 'utf8'));
    const out = Object.entries(health).filter(([, v]) => v && v.ok === false && Date.now() - v.at < 24 * 3600_000)
      .map(([k, v]) => {
        const back = String(v.detail ?? v.problem ?? '').match(/(?:try again at|resets? (?:in|at|on))\s+([A-Za-z0-9: ]{3,22})/i)?.[1];
        return `${k} (${/QUOTA|limit/i.test(String(v.detail ?? '') + String(v.problem ?? '')) ? 'out of quota' : 'failing'}${back ? `, back ${back.trim()}` : ''})`;
      });
    if (out.length) lines.push(`Unavailable assistants right now: ${out.join('; ')}. This is why finished tasks wait for an independent reviewer.`);
  } catch { /* no health record yet */ }
  const commit = run('git', ['log', '-1', '--format=%h %s'], cfg.root);
  if (commit) lines.push(`Last commit: ${commit.slice(0, 100)}`);
  return lines.join('\n');
}

const REPLY_RULES = `How to write to the owner (your final text is sent on WhatsApp by the driver; do NOT call wa send for it):
- SHAPE OF EVERY REPLY (WhatsApp, read on a phone):
  Line 1: the answer in one short sentence, wrapped in single asterisks so it shows bold, e.g. *Nothing is blocked now: 3 tasks were accepted.*
  Then a blank line, then 2 to 5 short bullets starting with "• ". Each bullet is one fact or one step, 15 words at most.
  If something needs the owner, add a bold line *Needs you* and number the questions under it.
  If there is more detail than fits, finish with: _Reply "details" for the full version._ and give the long version only when asked.
  When the owner asks to be explained something, write it in 3 short parts with bold labels (*What happened*, *Why*, *What I did*), each 1 to 3 bullets.
  Never write paragraphs longer than 2 lines. No tables. No emoji.
- Plain words, like a calm colleague. No greetings, no jargon.
- When the owner wrote to you, ANSWER THEIR MESSAGE. Their latest message decides the topic, even if work is running or you were just talking about something else. If they change the subject, follow the new subject. Never answer a question with a task list unless they asked for status.
- Task ids, worker names, tokens, hours and commit text appear only if the owner asked for them.
- If you cannot do what they ask (for example a screenshot, because this server has no browser), say that in one sentence and offer the nearest thing you can do (a plain description, the page address, or what to run on their PC). Never ignore a request.
- If you need an answer from them, end with: "Decide:" then numbered questions, then "Reply: 1 yes 2 no". Do not write "Decide: none".
- Turns started by an event (no owner message) stay silent (reply exactly NOOP) unless something changed that the owner must know.`;

export function rules(cfg, entry, hasOwner = false) {
  const edits = isCheap(entry)
    ? 'You run on a free model: you may make small edits yourself (briefs, config, docs, tiny fixes). Anything larger becomes a task for a worker.'
    : 'You run on a costly model: you NEVER write or edit project code. Plan, write task briefs under the hub, dispatch workers, review, accept. A turn that tries to write code is stopped.';
  return [
    `You are the orchestrator of "${cfg.projectName}" on machine "${cfg.nodeName}" (agent: ${entry.id}).`,
    hasOwner
      ? `The owner wrote to you. Answer THEM in this very turn, from the "Fleet now" status below. Read at most 2 files, and only if the question truly needs them; do not read the playbook (${PLAYBOOK}) and do not browse the hub. Never end this turn with NOOP.`
      : `Method and where all context lives: ${PLAYBOOK} (read it once at the start of a fresh session).`,
    edits,
    `Hub folder: ${path.relative(cfg.root, cfg.hubPath) || '.'}. Never read or print secrets (.env files, ~/.config/devbox, ~/.cli-proxy-api).`,
    cfg.orchestrator.screenshotCommand ? `Screenshots: run \`${cfg.orchestrator.screenshotCommand} <route> <out.png>\` then \`wa image <out.png> "<caption>"\`.` : null,
    cfg.orchestrator.browserAgentCommand ? `Browsing, page checks and visual reports: hand the task to the browser agent and relay its answer in plain words. It works read-only for the owner: page checks, screenshots, reports. Run: \`${cfg.orchestrator.browserAgentCommand} -p "<one clear task, with the page address>" --dangerously-skip-permissions --print-timeout 600s\` (owner approved auto-approve for this agent; it runs in an empty scratch folder and must only browse and report, never edit project files). If the command says it is not signed in, tell the owner exactly that.` : null,
    REPLY_RULES,
    'End every turn by updating docs/HANDOFF.md (under 40 lines: running, waiting for the owner, next 3 actions).',
  ].filter(Boolean).join('\n');
}

const block = (title, items) => (items.length ? `${title}\n${items.map((x, i) => `${i + 1}. ${x}`).join('\n')}` : '');

// First prompt of a session (or after rotation/takeover). `takeover` names the manager that handled the last turn.
export function bootstrapPrompt({ cfg, entry, events, owner = [], conversation = [], takeover = null, corrections = [] }) {
  return [
    rules(cfg, entry, owner.length > 0),
    takeover && !owner.length ? `You take over from ${takeover}. Read docs/HANDOFF.md first.` : null,
    owner.length ? block('The owner just wrote (answer this first, it decides the topic):', owner) : null,
    `Fleet now (background; use it only if the owner asks about status):\n${digest(cfg)}`,
    block('Owner conversation while you were busy (answered by the side responder; verify against the fleet and correct anything wrong):', conversation),
    corrections.length ? `Corrections to send first:\n${corrections.join('\n')}` : null,
    owner.length ? null : block('Owner messages:', owner),
    block('Events:', events),
  ].filter(Boolean).join('\n\n');
}

// Later turns of the same session: only what changed.
export function continuePrompt({ cfg, entry, events, owner = [], conversation = [] }) {
  return [
    owner.length ? block('The owner just wrote (answer this first, it decides the topic):', owner) : null,
    `Fleet now (background; use it only if the owner asks about status):\n${digest(cfg)}`,
    block('Owner conversation while you were busy (verify against the fleet and correct anything wrong):', conversation),
    block('Events:', events),
    `Handle these per the playbook. ${isCheap(entry) ? '' : 'You still do not edit code. '}Write to the owner in plain words as the rules say. If an owner message is listed above, answer that message first; reply NOOP only when there is no owner message and nothing the owner must know.`,
  ].filter(Boolean).join('\n\n');
}

export function responderPrompt({ cfg, ownerText, history = [] }) {
  return [
    `You answer the owner of "${cfg.projectName}" quickly while the manager is busy. Read-only: never dispatch, accept, edit or commit.`,
    `Fleet now:\n${digest(cfg)}`,
    block('Conversation so far:', history),
    `Owner: ${ownerText}`,
    `If an action is needed, write it to ${path.relative(cfg.root, cfg.hubPath)}/runs/responder-handoff.md for the manager and say so. Plain text, no emoji, cite task IDs and numbers.`,
  ].filter(Boolean).join('\n\n');
}

export function runSelfTest() {
  const cfg = { projectName: 'demo', nodeName: 'n1', hubPath: '/nonexistent/.hub', root: '/nonexistent', orchestrator: { screenshotCommand: null } };
  const cheap = { id: 'g', cost: 'free' };
  const costly = { id: 'c', cost: 'plan' };
  const a = bootstrapPrompt({ cfg, entry: costly, events: ['DECIDE T-1: x'], owner: ['status?'] });
  const b = bootstrapPrompt({ cfg, entry: cheap, events: [] });
  const checks = [
    ['costly never edits', a.includes('NEVER write or edit project code')],
    ['cheap may edit', b.includes('may make small edits')],
    ['events listed', a.includes('1. DECIDE T-1: x') && a.includes('The owner just wrote')],
    ['reply rules', a.includes('NOOP') && a.includes('Decide:')],
    ['no project leak', !new RegExp(['lan', 'go|Oss', 'ama|/home/dev/proj', 'ects'].join('')).test(a + b)],
    ['responder read-only', responderPrompt({ cfg, ownerText: 'hi' }).includes('Read-only')],
  ];
  let ok = true;
  for (const [name, pass] of checks) { console.log(`${pass ? 'PASS' : 'FAIL'} prompt: ${name}`); ok = ok && pass; }
  return ok;
}
