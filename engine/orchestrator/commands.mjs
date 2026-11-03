// commands.mjs: "/orch ..." commands from WhatsApp or --cmd. Handled by the driver itself: no agent quota is spent.
// Plain text replies (no emoji). Entries are registry ids; "agent@model" is accepted and mapped to the matching entry.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadAccounts, pick } from '../accounts.mjs';
import { isDown, turnsInLastHour, candidates } from './select.mjs';
import { burnStats, burnLimits, burnVerdict, burnLine } from './burn.mjs';
import { actionsOf } from './trace.mjs';

const HELP = 'Commands: /orch status | last | quotas | burn | use <id> | order <id,id,...|default> | pause | resume | reset | models | shot <route>';
const hhmm = (t) => new Date(t).toTimeString().slice(0, 5);

export function controlFile(cfg) { return path.join(cfg.hubPath, 'orch-control.json'); }
export function readControl(cfg) { try { return JSON.parse(fs.readFileSync(controlFile(cfg), 'utf8')); } catch { return {}; } }
export function writeControl(cfg, patch) {
  const next = { ...readControl(cfg), ...patch };
  for (const k of Object.keys(next)) if (next[k] === undefined) delete next[k];
  fs.writeFileSync(controlFile(cfg), JSON.stringify(next, null, 2) + '\n');
  return next;
}

// "agent · model", "agent@model" or an entry id -> registry id (or null).
export function resolveId(arg, accounts) {
  const a = String(arg ?? '').trim().replace(/\s*[·•]\s*/g, '@');
  if (!a) return null;
  const byId = accounts.find((e) => e.id === a);
  if (byId) return byId.id;
  const [cmd, model] = a.split('@');
  const byCmd = accounts.filter((e) => e.command === cmd && (!model || e.model === model));
  if (byCmd.length === 1) return byCmd[0].id;
  const byPrefix = accounts.filter((e) => e.id.startsWith(a));
  return byPrefix.length === 1 ? byPrefix[0].id : null;
}

export async function runCommand(text, ctx) {
  const { cfg, st, save } = ctx;
  const [verb = 'status', ...rest] = String(text).trim().replace(/^\/orch\s*/i, '').split(/\s+/);
  const arg = rest.join(' ').trim();
  const control = readControl(cfg);
  const accounts = loadAccounts(cfg.hubPath);
  const ranked = candidates({ role: 'orchestrator', st, hubDir: cfg.hubPath, control });

  switch ((verb || 'status').toLowerCase()) {
    case 'status': {
      const lines = pick({ role: 'orchestrator', hubDir: cfg.hubPath }).map((e, i) => {
        const down = isDown(st, e.id) ? `down until ${hhmm(Math.max(st.down?.[e.id] ?? 0, st.sessions?.[e.id]?.downUntil ?? 0))}${st.downWhy?.[e.id] ? `: ${st.downWhy[e.id]}` : ''}` : e.reason;
        return `${i + 1}. ${e.id} (${e.cost}) ${down}`;
      });
      return [
        `Orchestrator ${cfg.projectName} on ${cfg.nodeName}${control.paused ? ' (PAUSED)' : ''}`,
        `On duty: ${ranked[0]?.id ?? 'none available'}${st.current && st.current !== ranked[0]?.id ? ` (last turn: ${st.current})` : ''}`,
        st.burn?.tripped ? `Dispatching is HELD: ${st.burn.why} Send /orch resume to continue.` : 'Dispatching: on',
        `Manager turns in the last hour: ${turnsInLastHour(st)} (limit ${cfg.orchestrator.maxTurnsPerHour} for automatic wakes; your messages always get answered)`,
        'Order:', ...lines, HELP,
      ].join('\n');
    }
    case 'last': {
      // What the manager really did in its latest run, read from the saved run, not from its own words.
      let raw = '';
      try { raw = fs.readFileSync(path.join(cfg.hubPath, 'runs', 'last-turn.jsonl'), 'utf8'); } catch { /* no run yet */ }
      const a = actionsOf(raw, 10);
      return a.length ? ['*Last run: what I did*', ...a.map((x) => `• ${x}`)].join('\n') : 'My last run changed nothing and ran no commands, or there is no run saved yet.';
    }
    case 'burn': {
      const lim = burnLimits(cfg);
      const s = burnStats(cfg.hubPath, lim.windowMinutes);
      const v = burnVerdict(s, lim);
      return [burnLine(s), v ? `Warning: ${v.why}` : 'Spend and progress look healthy.', `Breaker trips at ${lim.maxJobsNoAccept} jobs with no accepted task, or ${lim.maxBuildsPerTask} builds of one task, within ${lim.windowMinutes} min.`].join('\n');
    }
    case 'quotas': {
      const rows = pick({ hubDir: cfg.hubPath }).map((e, i) => `${i + 1}. ${e.id} | ${e.command}${e.model ? ' ' + e.model : ''} | ${e.reason}`);
      return ['Allowance per account:', ...(rows.length ? rows : ['(no enabled accounts)'])].join('\n');
    }
    case 'use': {
      const id = resolveId(arg, accounts);
      if (!id) return `Unknown entry "${arg}". Ids: ${accounts.map((e) => e.id).join(', ')}`;
      delete st.down?.[id];
      if (st.sessions?.[id]) delete st.sessions[id].downUntil;
      save();
      writeControl(cfg, { order: [id, ...(control.order ?? []).filter((x) => x !== id)] });
      return `Next turn uses ${id} first.`;
    }
    case 'order': {
      if (/^default$/i.test(arg)) { writeControl(cfg, { order: undefined }); return 'Order reset: ranked by remaining allowance, free first.'; }
      const ids = arg.split(',').map((x) => resolveId(x, accounts));
      if (!arg || ids.includes(null)) return `Usage: /orch order id1,id2,... (or default). Ids: ${accounts.map((e) => e.id).join(', ')}`;
      writeControl(cfg, { order: ids });
      return `Order pinned: ${ids.join(' > ')} (others follow by allowance).`;
    }
    case 'pause': writeControl(cfg, { paused: true }); return 'Paused. Events are kept and handled after /orch resume. Your messages are still answered.';
    case 'resume': {
      writeControl(cfg, { paused: false });
      const wasHeld = st.burn?.tripped;
      if (wasHeld) {
        st.burn = { tripped: false, clearedAt: new Date().toISOString() }; save();
        try { fs.unlinkSync(path.join(cfg.hubPath, 'runs', 'burn-hold.json')); } catch { /* already released */ }
        ctx.resumeDispatch?.();
      }
      return `Resumed${wasHeld ? ' and dispatching is back on' : ''}. On duty: ${ranked[0]?.id ?? 'none available'}.`;
    }
    case 'reset': st.down = {}; st.downWhy = {}; for (const s of Object.values(st.sessions ?? {})) delete s.downUntil; save(); return 'All managers marked ready again.';
    case 'models': {
      const rows = accounts.map((e, i) => `${i + 1}. ${e.id} | ${e.command}${e.model ? ' ' + e.model : ''} | ${(e.roles ?? []).join('/')} | ${e.enabled ? 'enabled' : 'off'}`);
      let proxy = [];
      try { const r = await fetch('http://127.0.0.1:8080/v1/models'); proxy = (await r.json()).data.map((m) => m.id); } catch { /* proxy not on this machine */ }
      return ['Accounts:', ...rows, proxy.length ? `Models on the Antigravity proxy: ${proxy.join(', ')}` : null].filter(Boolean).join('\n');
    }
    case 'shot': {
      const shot = cfg.orchestrator.screenshotCommand;
      if (!shot) return 'No screenshotCommand set in the hub config (orchestrator.screenshotCommand).';
      if (!arg) return 'Usage: /orch shot <route>';
      const out = path.join(cfg.hubPath, 'runs', `shot-${Date.now()}.png`);
      const r = spawnSync(shot, [arg, out], { shell: true, cwd: cfg.root, encoding: 'utf8', timeout: 120_000, windowsHide: true });
      if (r.status !== 0 || !fs.existsSync(out)) return `Screenshot failed (exit ${r.status}): ${String(r.stderr ?? '').trim().slice(-200)}`;
      ctx.sendImage?.(out, `Screenshot of ${arg}`);
      return `Screenshot of ${arg} sent.`;
    }
    default: return HELP;
  }
}

export function runSelfTest() {
  const acc = [{ id: 'ag2-gemini', command: 'claude-ag2', model: 'gemini-3-flash' }, { id: 'codex', command: 'codex', model: null }];
  const checks = [
    ['resolve id', resolveId('codex', acc) === 'codex'],
    ['resolve cmd@model', resolveId('claude-ag2@gemini-3-flash', acc) === 'ag2-gemini'],
    ['resolve display form', resolveId('claude-ag2 · gemini-3-flash', acc) === 'ag2-gemini'],
    ['resolve prefix', resolveId('ag2', acc) === 'ag2-gemini'],
    ['unknown', resolveId('nope', acc) === null],
  ];
  let ok = true;
  for (const [name, pass] of checks) { console.log(`${pass ? 'PASS' : 'FAIL'} commands: ${name}`); ok = ok && pass; }
  return ok;
}
