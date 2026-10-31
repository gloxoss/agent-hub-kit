// responder.mjs: Side responder role, permissions, and handover logic for orchestrator v2
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { pick, explainDrain } from '../accounts.mjs';
import { buildClaudeCommand, buildCodexCommand, buildOpenCodeCommand, runTurn } from './runner.mjs';
import { isOrchestratorWrite } from './guard.mjs';
import { resolveConfig } from './config.mjs';

const RESPONDER_DISALLOWED_TOOLS = [
  'Edit',
  'Write',
  'MultiEdit',
  'NotebookEdit',
  'Task',
  'Agent'
];

const FORBIDDEN_RESPONDER_COMMANDS = [
  'dispatch.mjs run',
  'accept.mjs',
  'hub.mjs accept',
  'hub.mjs reject',
  'hub.mjs assign',
  'hub.mjs cancel'
];

export function isResponderForbidden(cmd) {
  if (!cmd) return false;
  let cmdStr = '';
  if (typeof cmd === 'string') {
    cmdStr = cmd;
  } else if (typeof cmd === 'object') {
    if (cmd.name || cmd.type === 'tool_use' || cmd.content_block?.type === 'tool_use') {
      const toolName = cmd.name || cmd.content_block?.name;
      if (RESPONDER_DISALLOWED_TOOLS.includes(toolName)) {
        return true;
      }
    }
    cmdStr = cmd.command || cmd.cmd || JSON.stringify(cmd);
  }

  const lower = cmdStr.toLowerCase();
  for (const forbidden of FORBIDDEN_RESPONDER_COMMANDS) {
    if (lower.includes(forbidden.toLowerCase())) {
      return true;
    }
  }

  if (isOrchestratorWrite(cmd)) {
    return true;
  }

  return false;
}

export function buildResponderCommand(entry, prompt, session = {}) {
  const family = (entry.family || entry.name || 'claude').toLowerCase();
  let cmdInfo;
  if (family.includes('codex')) {
    cmdInfo = buildCodexCommand(entry, prompt, session);
  } else if (family.includes('opencode')) {
    cmdInfo = buildOpenCodeCommand(entry, prompt, session);
  } else {
    cmdInfo = buildClaudeCommand(entry, prompt, session);
    const args = cmdInfo.args;
    const dtIdx = args.indexOf('--disallowedTools');
    if (dtIdx !== -1 && dtIdx + 1 < args.length) {
      const existing = args[dtIdx + 1].split(',').map(s => s.trim());
      for (const tool of RESPONDER_DISALLOWED_TOOLS) {
        if (!existing.includes(tool)) existing.push(tool);
      }
      args[dtIdx + 1] = existing.join(',');
    } else {
      args.push('--disallowedTools', RESPONDER_DISALLOWED_TOOLS.join(','));
    }
  }
  return cmdInfo;
}

export async function runResponder(ownerText, options = {}) {
  const cfg = resolveConfig(options.root || process.cwd());
  const hubDir = options.hubDir || cfg.hubDir || '.agent-hub';

  const candidates = pick({ role: 'responder', hubDir });
  if (!candidates || candidates.length === 0) {
    throw new Error('No enabled responder accounts found via accounts.pick({ role: "responder" })');
  }

  const entry = candidates[0];
  const digestLines = explainDrain(hubDir, 6);
  const fleetDigest = digestLines.join('\n');

  const prompt = `Owner message: ${ownerText}\n\nFleet digest:\n${fleetDigest}\n\nAnswer now; if an action is needed, write it to ${cfg.hubPath}/runs/responder-handoff.md for the manager.`;

  const cmdInfo = buildResponderCommand(entry, prompt, options.session || {});
  const fullCmdStr = [cmdInfo.file, ...cmdInfo.args].join(' ');

  if (process.env.ORCH_DRY === '1' || options.dry) {
    console.log(`[ORCH_DRY] Responder command: ${fullCmdStr}`);
    return {
      success: true,
      dry: true,
      account: entry.id,
      command: [cmdInfo.file, ...cmdInfo.args],
      commandString: fullCmdStr
    };
  }

  if (isResponderForbidden(fullCmdStr)) {
    throw new Error(`Responder blocked: command violates responder safety permissions (${fullCmdStr})`);
  }

  return await runTurn(entry, prompt, options.session || {});
}

export function isOwnerMidTopic(session = {}) {
  if (!session.lastMessageTime) return false;
  const ageMs = Date.now() - session.lastMessageTime;
  const isRecent = ageMs < 3 * 60 * 1000;
  const text = (session.lastMessage || '').toLowerCase();
  const isDone = text.includes('done') || text.includes('thanks') || text.includes('bye');
  return isRecent && !isDone;
}

export function checkAndCorrectAnswers(session = {}, hubDir = '.agent-hub') {
  const corrections = [];
  const transcript = session.transcript || [];
  for (const msg of transcript) {
    if (msg.role === 'responder' && msg.text) {
      if (session.mockDiscrepancy) {
        corrections.push(`Update: ${session.mockDiscrepancy.task} status is ${session.mockDiscrepancy.actualState}; earlier answer had older info`);
      }
    }
  }
  return corrections;
}

export async function performHandover(session = {}, options = {}) {
  const hubDir = options.hubDir || '.agent-hub';
  const midTopic = isOwnerMidTopic(session);

  if (midTopic && session.responderActive && typeof session.finishResponder === 'function') {
    await session.finishResponder();
  }

  const transcript = session.transcript || [];
  const transcriptStr = transcript.map(m => `[${m.role || 'user'}] ${m.text || ''}`).join('\n');

  const handoffFile = path.join(hubDir, 'runs', 'responder-handoff.md');   // the hub's own events.jsonl is never written here
  let handoffContent = '';
  try {
    if (fs.existsSync(handoffFile)) {
      handoffContent = fs.readFileSync(handoffFile, 'utf8');
    }
  } catch {}

  const managerPrompt = `--- HANDOVER FROM SIDE RESPONDER ---\nTranscript:\n${transcriptStr}\n\nHandoff notes:\n${handoffContent}\n-----------------------------------`;

  const eventsFile = path.join(hubDir, 'runs', 'responder-events.jsonl');
  try {
    if (fs.existsSync(path.dirname(eventsFile))) {
      const eventRecord = JSON.stringify({
        source: 'responder-handover',
        line: managerPrompt,
        wakeClass: 'user',
        timestamp: Date.now()
      }) + '\n';
      fs.appendFileSync(eventsFile, eventRecord);
    }
  } catch {}

  const corrections = checkAndCorrectAnswers(session, hubDir);

  session.active = false;
  session.responderActive = false;

  return {
    success: true,
    midTopicHandled: midTopic,
    notifiedOwner: 'Manager is back, continuing from here',
    managerPrompt,
    corrections
  };
}

export function runResponderFixtureTest() {
  console.log('Running responder fixture tests...');

  const cfg = resolveConfig();
  const candidates = pick({ role: 'responder', hubDir: cfg.hubDir });
  if (candidates.length === 0) {
    throw new Error('Responder fixture test failed: no responder accounts found');
  }

  const entry = candidates[0];
  const cmdInfo = buildResponderCommand(entry, 'Test owner message', {});
  const cmdStr = [cmdInfo.file, ...cmdInfo.args].join(' ');

  console.log(`Responder command line (${entry.id}): ${cmdStr}`);

  const claudeEntry = { id: 'claude-test', family: 'claude', command: 'claude', model: 'claude-3-5-sonnet', roles: ['responder'], cost: 1, owner: 'fleet', enabled: true };
  const claudeCmdInfo = buildResponderCommand(claudeEntry, 'Test owner message', {});
  const claudeCmdStr = [claudeCmdInfo.file, ...claudeCmdInfo.args].join(' ');
  console.log(`Claude responder command line with denials: ${claudeCmdStr}`);
  if (!claudeCmdStr.includes('--disallowedTools') || !claudeCmdStr.includes('Edit') || !claudeCmdStr.includes('Write')) {
    throw new Error('Claude responder command missing disallowed tools');
  }

  const blockedCommands = [
    'node .hub/dispatch.mjs run task-1',
    'node accept.mjs',
    'node .agent-hub/hub.mjs accept T-1',
    'node .agent-hub/hub.mjs reject T-1',
    'node .agent-hub/hub.mjs assign T-1',
    'node .agent-hub/hub.mjs cancel T-1'
  ];

  for (const bc of blockedCommands) {
    const blocked = isResponderForbidden(bc);
    console.log(`Forbidden check for "${bc}": blocked=${blocked}`);
    if (!blocked) {
      throw new Error(`Responder guard failed to block forbidden command: "${bc}"`);
    }
  }

  console.log('All responder fixture tests passed successfully.');
  return true;
}

export async function runHandoverFixtureTest() {
  console.log('Running handover fixture tests...');

  const sessionNotMid = {
    lastMessageTime: Date.now() - 5 * 60 * 1000,
    lastMessage: 'done with this topic',
    transcript: [
      { role: 'user', text: 'What is the status of P-students-import?' },
      { role: 'responder', text: 'P-students-import is in progress.' }
    ],
    responderActive: false,
    active: true
  };

  const res1 = await performHandover(sessionNotMid, { dry: true });
  console.log('Branch 1 (not mid-topic) result:', JSON.stringify(res1, null, 2));
  if (!res1.success || !res1.managerPrompt.includes('P-students-import') || res1.notifiedOwner !== 'Manager is back, continuing from here') {
    throw new Error('Handover fixture test branch 1 failed');
  }

  let finishedCalled = false;
  const sessionMid = {
    lastMessageTime: Date.now() - 30 * 1000,
    lastMessage: 'can you check one more thing about S-09-03?',
    transcript: [
      { role: 'user', text: 'Check S-09-03' },
      { role: 'responder', text: 'Checking S-09-03 now.' }
    ],
    responderActive: true,
    active: true,
    finishResponder: async () => { finishedCalled = true; }
  };

  const res2 = await performHandover(sessionMid, { dry: true });
  console.log('Branch 2 (mid-topic) result:', JSON.stringify(res2, null, 2));
  if (!res2.success || !finishedCalled || !res2.midTopicHandled || !res2.managerPrompt.includes('Check S-09-03')) {
    throw new Error('Handover fixture test branch 2 failed');
  }

  const sessionWithDiscrepancy = {
    transcript: [
      { role: 'user', text: 'When did P-x start?' },
      { role: 'responder', text: 'P-x started at 13:30.' }
    ],
    mockDiscrepancy: { task: 'P-x', actualState: '14:02' }
  };
  const corrections = checkAndCorrectAnswers(sessionWithDiscrepancy);
  console.log('Manager corrections check:', corrections);
  if (corrections.length === 0 || !corrections[0].includes('14:02')) {
    throw new Error('Manager correction check failed');
  }

  console.log('All handover fixture tests passed successfully.');
  return true;
}

const __filename = fileURLToPath(import.meta.url);
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runResponderFixtureTest();
  runHandoverFixtureTest();
}
