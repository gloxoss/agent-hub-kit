#!/usr/bin/env node
// Report competing heavy commands; optionally enforce project policy. Run: node <hub>/tools/build-guard.mjs [--once] [--enforce].
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { HUB, ROOT, CFG, help } from './runtime.mjs';

help('usage: build-guard.mjs [--once] [--enforce]; report-only by default, only project job descendants are eligible');
const enforce = process.argv.includes('--enforce');
const BUILD = /next(?:\.cmd)?"?\s+build|next[\\/]dist[\\/]bin[\\/]next"?\s+build|npm(?:-cli\.js)?"?\s+run\s+build(?::[\w-]+)?/i;
const HEAVY = /typescript[\\/]bin[\\/]tsc|vitest[\\/]|\btsc\b/i;
const SAFE = /build-guard|Read the file|append-system-prompt|opencode(?:\.exe)?"?\s+run|cursor-agent|claude(?:\.exe)?\s/i;
function rows() {
  if (process.platform === 'win32') {
    const text = execFileSync('powershell', ['-NoProfile', '-Command', 'Get-CimInstance Win32_Process | Where-Object { $_.CommandLine } | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress'], { encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
    return [JSON.parse(text)].flat().map((r) => ({ pid: r.ProcessId, parent: r.ParentProcessId, cmd: r.CommandLine }));
  }
  return execFileSync('ps', ['-eo', 'pid=,ppid=,args='], { encoding: 'utf8' }).trim().split('\n').map((line) => { const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/); return m && { pid: +m[1], parent: +m[2], cmd: m[3] }; }).filter(Boolean);
}
function sweep() {
  const all = rows(), byPid = new Map(all.map((r) => [r.pid, r]));
  const jobsFile = path.join(HUB, 'runs', 'jobs.jsonl');
  const jobs = fs.existsSync(jobsFile) ? fs.readFileSync(jobsFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  const roots = new Set(jobs.filter((j) => {
    try { return !fs.readFileSync(path.resolve(ROOT, j.log), 'utf8').includes('[dispatch] exit'); } catch { return false; }
  }).map((j) => j.pid));
  const ancestors = (r) => { const out = []; for (let i = 0; r && i < 30; i++, r = byPid.get(r.parent)) out.push(r); return out; };
  const owned = all.filter((r) => ancestors(r).some((a) => roots.has(a.pid) || a.cmd.includes(path.join(HUB, 'tools', 'heavy.mjs'))) && !SAFE.test(r.cmd));
  const heavy = owned.filter((r) => HEAVY.test(r.cmd));
  const candidates = owned.filter((r) => (CFG.guard?.banBuilds === true && BUILD.test(r.cmd)) || (heavy.length > 1 && HEAVY.test(r.cmd) && !ancestors(r).some((a) => /heavy\.mjs/.test(a.cmd))));
  for (const r of candidates) {
    console.log(`${enforce ? 'STOP' : 'REPORT'} ${r.pid}: ${r.cmd.slice(0, 160)}`);
    if (enforce) {
      if (process.platform === 'win32') execFileSync('taskkill', ['/PID', String(r.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      else process.kill(r.pid, 'SIGTERM');
    }
  }
  console.log(`build-guard: ${candidates.length} policy violations (${enforce ? 'enforce' : 'report only'})`);
}
try { sweep(); } catch (error) { console.error(`build-guard: ${error.message}`); process.exitCode = 1; }
if (!process.argv.includes('--once')) setInterval(() => { try { sweep(); } catch (error) { console.error(error.message); } }, CFG.guard?.intervalMs ?? 20_000);
