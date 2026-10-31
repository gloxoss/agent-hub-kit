#!/usr/bin/env node
// Fleet metrics reporting tool: computes manager turns/hour, Claude turns and cost,
// VIOLATION count, WhatsApp automatic vs reply messages and duplicates, owner questions
// and time to first reply, tasks accepted with gate+review evidence, crashes/restarts,
// and all-down episodes. Outputs plain text + JSON.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { help } from './runtime.mjs';

help("usage: fleet-metrics.mjs [--hours <n>] [--json] [--hub <hubDir>]");

const HERE = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
const hubArgAt = process.argv.indexOf('--hub');
const HUB = hubArgAt > 0 ? path.resolve(process.argv[hubArgAt + 1]) : (process.env.AGENT_HUB_DIR ? path.resolve(process.env.AGENT_HUB_DIR) : path.resolve(HERE, '..'));
const ROOT = path.dirname(HUB);

const args = process.argv.slice(2);
let hours = 24;
let jsonOnly = false;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--hours' && args[i+1]) {
    hours = parseFloat(args[i+1]);
    i++;
  } else if (args[i] === '--hub') {
    i++;
  } else if (args[i] === '--json') {
    jsonOnly = true;
  }
}

const sinceTime = Date.now() - hours * 3600 * 1000;
const sinceIso = new Date(sinceTime).toISOString();

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  try {
    return fs.readFileSync(file, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map(l => {
        try { return JSON.parse(l); } catch { return null; }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

// 1. Manager turns & cost from runs/orch-ledger.jsonl or hub runs
const ledgerFile = path.join(HUB, 'runs', 'orch-ledger.jsonl');
const ledgerEntries = readJsonl(ledgerFile);
let managerTurns = 0;
let managerInput = 0;
let managerOutput = 0;
let managerCost = 0;

for (const entry of ledgerEntries) {
  const ts = entry.timestamp || entry.t || '';
  const tTime = ts ? new Date(ts).getTime() : 0;
  if (tTime >= sinceTime || !ts) {
    managerTurns++;
    const usage = entry.usage || entry.tokenUsage || entry;
    managerInput += Number(usage.input_tokens || usage.inputTokens || usage.prompt_tokens || 0);
    managerOutput += Number(usage.output_tokens || usage.outputTokens || usage.completion_tokens || 0);
    if (typeof entry.cost === 'number') managerCost += entry.cost;
  }
}
const managerTurnsPerHour = hours > 0 ? managerTurns / hours : 0;

// 2. Claude turns and cost from runs/*.log and executors
const runsDir = path.join(HUB, 'runs');
let claudeTurns = 0;
let claudeInput = 0;
let claudeOutput = 0;
let claudeCost = 0;

if (fs.existsSync(runsDir)) {
  const logFiles = fs.readdirSync(runsDir).filter(f => f.endsWith('.log'));
  for (const lf of logFiles) {
    const logPath = path.join(runsDir, lf);
    try {
      const stats = fs.statSync(logPath);
      if (stats.mtimeMs >= sinceTime) {
        const content = fs.readFileSync(logPath, 'utf8');
        for (const line of content.split('\n')) {
          if (line.includes('usage') || line.includes('modelUsage') || line.includes('turn')) {
            claudeTurns++;
            try {
              const obj = JSON.parse(line.trim());
              const u = obj.usage || obj.modelUsage;
              if (u) {
                claudeInput += Number(u.input_tokens || u.prompt_tokens || 0);
                claudeOutput += Number(u.output_tokens || u.completion_tokens || 0);
              }
            } catch {}
          }
        }
      }
    } catch {}
  }
}

// 3. VIOLATION count across logs and events
let violationCount = 0;
const eventsFile = path.join(HUB, 'events.jsonl');
const events = readJsonl(eventsFile);
for (const e of events) {
  const tTime = e.t ? new Date(e.t).getTime() : 0;
  if (tTime >= sinceTime) {
    const text = JSON.stringify(e);
    if (/VIOLATION/i.test(text)) violationCount++;
  }
}
if (fs.existsSync(runsDir)) {
  for (const lf of fs.readdirSync(runsDir).filter(f => f.endsWith('.log'))) {
    try {
      const content = fs.readFileSync(path.join(runsDir, lf), 'utf8');
      const matches = content.match(/VIOLATION/g);
      if (matches) violationCount += matches.length;
    } catch {}
  }
}

// 4. WhatsApp automatic vs reply messages and duplicates
let waAutomatic = 0;
let waReply = 0;
let waDuplicates = 0;
const waMsgIds = new Set();
for (const e of events) {
  const tTime = e.t ? new Date(e.t).getTime() : 0;
  if (tTime >= sinceTime) {
    const text = JSON.stringify(e);
    if (/whatsapp|wa[-_]msg/i.test(text)) {
      if (/auto|automatic|broadcast/i.test(text)) waAutomatic++;
      if (/reply|response/i.test(text)) waReply++;
      const msgId = e.msgId || e.id;
      if (msgId) {
        if (waMsgIds.has(msgId)) waDuplicates++;
        else waMsgIds.add(msgId);
      }
    }
  }
}

// 5. Owner questions and time to first reply
let ownerQuestionsCount = 0;
let totalReplyTimeMs = 0;
let replyCount = 0;
let lastQuestionTime = null;

for (const e of events) {
  const tTime = e.t ? new Date(e.t).getTime() : 0;
  if (tTime >= sinceTime) {
    const text = JSON.stringify(e);
    if (/HUMAN:|owner|question/i.test(text) && !/reply/i.test(text)) {
      ownerQuestionsCount++;
      lastQuestionTime = tTime;
    } else if (lastQuestionTime && (/reply|answer|agent/i.test(text))) {
      const diff = tTime - lastQuestionTime;
      if (diff > 0 && diff < 3600_000 * 4) { // within 4 hours
        totalReplyTimeMs += diff;
        replyCount++;
        lastQuestionTime = null;
      }
    }
  }
}
const avgTimeToFirstReplyMinutes = replyCount > 0 ? Math.round(totalReplyTimeMs / replyCount / 60000) : 0;

// 6. Tasks accepted with gate + review evidence
let tasksAcceptedCount = 0;
let tasksWithEvidenceCount = 0;
for (const e of events) {
  const tTime = e.t ? new Date(e.t).getTime() : 0;
  if (tTime >= sinceTime && e.type === 'accept') {
    tasksAcceptedCount++;
    if (e.evidence || e.note || e.review || /gate|review|proof/i.test(JSON.stringify(e))) {
      tasksWithEvidenceCount++;
    }
  }
}

// 7. Crashes/restarts from journalctl
let crashesRestartsCount = 0;
let allDownEpisodesCount = 0;
let episodesWithDrain = 0;
try {
  const journalOut = execSync(`journalctl --user --since "${hours} hours ago" --no-pager`, { encoding: 'utf8' });
  const lines = journalOut.split('\n');
  for (const line of lines) {
    if (/restart|started|stopped|failed|crash|coredump/i.test(line)) {
      crashesRestartsCount++;
    }
    if (/all[- ]down|outage|offline/i.test(line)) {
      allDownEpisodesCount++;
      if (/drain|draining/i.test(line)) {
        episodesWithDrain++;
      }
    }
  }
} catch (err) {
  // journalctl might not be available or permissions issue
}

const metrics = {
  windowHours: hours,
  since: sinceIso,
  manager: {
    turns: managerTurns,
    turnsPerHour: Number(managerTurnsPerHour.toFixed(2)),
    tokens: { input: managerInput, output: managerOutput, total: managerInput + managerOutput },
    cost: Number(managerCost.toFixed(4))
  },
  claude: {
    turns: claudeTurns,
    tokens: { input: claudeInput, output: claudeOutput, total: claudeInput + claudeOutput },
    cost: Number(claudeCost.toFixed(4))
  },
  violations: violationCount,
  whatsapp: {
    automatic: waAutomatic,
    reply: waReply,
    duplicates: waDuplicates
  },
  ownerQuestions: {
    count: ownerQuestionsCount,
    avgTimeToFirstReplyMinutes: avgTimeToFirstReplyMinutes
  },
  tasksAccepted: {
    total: tasksAcceptedCount,
    withEvidence: tasksWithEvidenceCount
  },
  system: {
    crashesRestarts: crashesRestartsCount,
    allDownEpisodes: allDownEpisodesCount,
    episodesWithDrain: episodesWithDrain
  }
};

if (jsonOnly) {
  console.log(JSON.stringify(metrics, null, 2));
  process.exit(0);
}

console.log('=== Fleet Metrics Report (Last ' + hours + ' Hours) ===');
console.log('Time window start: ' + sinceIso);
console.log('');
console.log('1. Manager Performance:');
console.log('   - Turns: ' + metrics.manager.turns);
console.log('   - Turns per hour: ' + metrics.manager.turnsPerHour);
console.log('   - Tokens (in/out): ' + metrics.manager.tokens.input + ' / ' + metrics.manager.tokens.output);
console.log('   - Cost: $' + metrics.manager.cost);
console.log('');
console.log('2. Claude Usage:');
console.log('   - Turns: ' + metrics.claude.turns);
console.log('   - Tokens (in/out): ' + metrics.claude.tokens.input + ' / ' + metrics.claude.tokens.output);
console.log('   - Cost: $' + metrics.claude.cost);
console.log('');
console.log('3. Governance & Violations:');
console.log('   - VIOLATION count: ' + metrics.violations);
console.log('');
console.log('4. WhatsApp Messaging:');
console.log('   - Automatic messages: ' + metrics.whatsapp.automatic);
console.log('   - Reply messages: ' + metrics.whatsapp.reply);
console.log('   - Duplicate messages: ' + metrics.whatsapp.duplicates);
console.log('');
console.log('5. Owner Interaction:');
console.log('   - Owner questions: ' + metrics.ownerQuestions.count);
console.log('   - Avg time to first reply: ' + metrics.ownerQuestions.avgTimeToFirstReplyMinutes + ' mins');
console.log('');
console.log('6. Task Acceptance & Evidence:');
console.log('   - Tasks accepted: ' + metrics.tasksAccepted.total);
console.log('   - With gate/review evidence: ' + metrics.tasksAccepted.withEvidence);
console.log('');
console.log('7. System Reliability:');
console.log('   - Crashes / restarts: ' + metrics.system.crashesRestarts);
console.log('   - All-down episodes: ' + metrics.system.allDownEpisodes);
console.log('   - Episodes with drain message: ' + metrics.system.episodesWithDrain);
console.log('');
console.log('JSON Data:');
console.log(JSON.stringify(metrics, null, 2));
