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
  const commit = run('git', ['log', '-1', '--format=%h %s'], cfg.root);
  if (commit) lines.push(`Last commit: ${commit.slice(0, 100)}`);
  return lines.join('\n');
}

const REPLY_RULES = `Reply format (your final text is sent to the owner on WhatsApp by the driver; do NOT call wa send for it):
- Plain text, no emoji, no filler, no greetings. Cite task IDs, commit hashes, worker names, numbers.
- First line: a one-line headline. Then a numbered list: "1. <task> | <who> | <minutes> | <state>".
- Questions for the owner: a line "Decide:" then numbered questions, ending with "Reply: 1 yes 2 no".
- When the owner wrote to you, ALWAYS answer in plain words (a greeting gets a short greeting back plus the one-line state of the fleet; a question gets the answer from the live data). Never reply NOOP to an owner message.
- NOOP is only for turns that no owner message started and where nothing needs the owner.`;

export function rules(cfg, entry) {
  const edits = isCheap(entry)
    ? 'You run on a free model: you may make small edits yourself (briefs, config, docs, tiny fixes). Anything larger becomes a task for a worker.'
    : 'You run on a costly model: you NEVER write or edit project code. Plan, write task briefs under the hub, dispatch workers, review, accept. A turn that tries to write code is stopped.';
  return [
    `You are the orchestrator of "${cfg.projectName}" on machine "${cfg.nodeName}" (agent: ${entry.id}).`,
    `Method and where all context lives: ${PLAYBOOK} (read it once at the start of a fresh session).`,
    edits,
    `Hub folder: ${path.relative(cfg.root, cfg.hubPath) || '.'}. Never read or print secrets (.env files, ~/.config/devbox, ~/.cli-proxy-api).`,
    cfg.orchestrator.screenshotCommand ? `Screenshots: run \`${cfg.orchestrator.screenshotCommand} <route> <out.png>\` then \`wa image <out.png> "<caption>"\`.` : null,
    REPLY_RULES,
    'End every turn by updating docs/HANDOFF.md (under 40 lines: running, waiting for the owner, next 3 actions).',
  ].filter(Boolean).join('\n');
}

const block = (title, items) => (items.length ? `${title}\n${items.map((x, i) => `${i + 1}. ${x}`).join('\n')}` : '');

// First prompt of a session (or after rotation/takeover). `takeover` names the manager that handled the last turn.
export function bootstrapPrompt({ cfg, entry, events, owner = [], conversation = [], takeover = null, corrections = [] }) {
  return [
    rules(cfg, entry),
    takeover ? `You take over from ${takeover}. Read docs/HANDOFF.md first.` : null,
    `Fleet now:\n${digest(cfg)}`,
    block('Owner conversation while you were busy (answered by the side responder; verify against the fleet and correct anything wrong):', conversation),
    corrections.length ? `Corrections to send first:\n${corrections.join('\n')}` : null,
    block('Owner messages:', owner),
    block('Events:', events),
  ].filter(Boolean).join('\n\n');
}

// Later turns of the same session: only what changed.
export function continuePrompt({ cfg, entry, events, owner = [], conversation = [] }) {
  return [
    `Fleet now:\n${digest(cfg)}`,
    block('Owner conversation while you were busy (verify against the fleet and correct anything wrong):', conversation),
    block('Owner messages:', owner),
    block('Events:', events),
    `Handle these per the playbook. ${isCheap(entry) ? '' : 'You still do not edit code. '}Final text rules: plain, numbered. If an owner message is listed above, answer it in words. NOOP only when there is no owner message and nothing for the owner. Update docs/HANDOFF.md.`,
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
    ['events listed', a.includes('1. DECIDE T-1: x') && a.includes('Owner messages:')],
    ['reply rules', a.includes('NOOP') && a.includes('Decide:')],
    ['no project leak', !new RegExp(['lan', 'go|Oss', 'ama|/home/dev/proj', 'ects'].join('')).test(a + b)],
    ['responder read-only', responderPrompt({ cfg, ownerText: 'hi' }).includes('Read-only')],
  ];
  let ok = true;
  for (const [name, pass] of checks) { console.log(`${pass ? 'PASS' : 'FAIL'} prompt: ${name}`); ok = ok && pass; }
  return ok;
}
