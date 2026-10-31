// burn.mjs: the quota-burn breaker. Compares what the fleet SPENT (worker and review jobs started) with what it
// FINISHED (tasks accepted) over a window. Many jobs and nothing accepted means quota is draining without progress:
// the driver then stops dispatching and tells the owner why, instead of silently burning Gemini/Claude allowance.
import fs from 'node:fs';
import path from 'node:path';

const readJsonl = (file, tail = 4000) => {
  try {
    return fs.readFileSync(file, 'utf8').trim().split('\n').slice(-tail).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
};

export const burnLimits = (cfg) => ({
  windowMinutes: 120,
  maxJobsNoAccept: 12,   // jobs in the window with zero accepted tasks
  maxBuildsPerTask: 4,   // one task built this many times in the window without being accepted
  ...(cfg.orchestrator?.burn ?? {}),
});

export function burnStats(hubPath, windowMinutes = 120, now = Date.now()) {
  const since = now - windowMinutes * 60_000;
  const jobs = readJsonl(path.join(hubPath, 'runs', 'jobs.jsonl')).filter((j) => Date.parse(j.t) >= since);
  const events = readJsonl(path.join(hubPath, 'events.jsonl'), 8000).filter((e) => e.t && Date.parse(e.t) >= since);
  const accepted = new Set(events.filter((e) => e.type === 'accept').map((e) => e.id));
  const builds = jobs.filter((j) => j.mode === 'run');
  const reviews = jobs.filter((j) => j.mode === 'review');
  const perTask = {};
  const perLane = {};
  for (const j of builds) {
    perTask[j.taskId] = (perTask[j.taskId] ?? 0) + 1;
    perLane[j.executor] = (perLane[j.executor] ?? 0) + 1;
  }
  const stuck = Object.entries(perTask).filter(([id]) => !accepted.has(id)).sort((a, b) => b[1] - a[1]);
  return { windowMinutes, builds: builds.length, reviews: reviews.length, accepted: accepted.size, perLane, stuck };
}

// null when healthy, else { kind, why }.
export function burnVerdict(stats, limits) {
  const jobs = stats.builds + stats.reviews;
  if (jobs >= limits.maxJobsNoAccept && stats.accepted === 0) {
    const lanes = Object.entries(stats.perLane).sort((a, b) => b[1] - a[1]).map(([l, n]) => `${l} ${n}`).join(', ');
    return { kind: 'no-progress', why: `${jobs} jobs in ${stats.windowMinutes} min (${stats.builds} builds, ${stats.reviews} reviews) and none accepted. Builds by lane: ${lanes || 'none'}. Most repeated: ${stats.stuck.slice(0, 3).map(([id, n]) => `${id} x${n}`).join(', ') || 'none'}.` };
  }
  const worst = stats.stuck[0];
  if (worst && worst[1] >= limits.maxBuildsPerTask) {
    return { kind: 'task-loop', why: `${worst[0]} was built ${worst[1]} times in ${stats.windowMinutes} min without being accepted.` };
  }
  return null;
}

// One line for the fleet digest: spent vs finished.
export const burnLine = (stats) => `Last ${Math.round(stats.windowMinutes / 60 * 10) / 10} h: ${stats.builds} builds, ${stats.reviews} reviews started, ${stats.accepted} tasks accepted`;

export function runSelfTest() {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || process.env.TEMP || '/tmp', 'burn-'));
  try {
    fs.mkdirSync(path.join(dir, 'runs'));
    const now = Date.now();
    const iso = (min) => new Date(now - min * 60_000).toISOString();
    const jobs = [];
    for (let i = 0; i < 9; i++) jobs.push({ id: `b${i}`, t: iso(10 + i), mode: 'run', executor: i % 2 ? 'gemini' : 'codex', taskId: i < 5 ? 'T-loop' : `T-${i}` });
    for (let i = 0; i < 4; i++) jobs.push({ id: `r${i}`, t: iso(5 + i), mode: 'review', executor: 'oc', taskId: `T-${i}` });
    jobs.push({ id: 'old', t: iso(500), mode: 'run', executor: 'gemini', taskId: 'T-old' });
    fs.writeFileSync(path.join(dir, 'runs', 'jobs.jsonl'), jobs.map((j) => JSON.stringify(j)).join('\n'));
    fs.writeFileSync(path.join(dir, 'events.jsonl'), '');
    const limits = burnLimits({});
    const s = burnStats(dir, 120, now);
    const v = burnVerdict(s, limits);
    fs.writeFileSync(path.join(dir, 'events.jsonl'), JSON.stringify({ t: iso(2), type: 'accept', id: 'T-1' }) + '\n');
    const s2 = burnStats(dir, 120, now);
    const checks = [
      ['counts builds and reviews, ignores old jobs', s.builds === 9 && s.reviews === 4],
      ['no-progress trips with zero accepts', v?.kind === 'no-progress' && /none accepted/.test(v.why)],
      ['names the repeated task', /T-loop x5/.test(v.why)],
      ['an accept clears the global breaker', burnVerdict(s2, limits)?.kind === 'task-loop'],
      ['task loop is detected', /T-loop was built 5 times/.test(burnVerdict(s2, limits).why)],
      ['healthy fleet gives null', burnVerdict({ builds: 3, reviews: 1, accepted: 2, perLane: {}, stuck: [] }, limits) === null],
      ['digest line', /3 builds, 1 reviews started, 2 tasks accepted/.test(burnLine({ windowMinutes: 120, builds: 3, reviews: 1, accepted: 2 }))],
    ];
    let ok = true;
    for (const [name, pass] of checks) { console.log(`${pass ? 'PASS' : 'FAIL'} burn: ${name}`); ok = ok && pass; }
    return ok;
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
