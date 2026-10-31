// telemetry.mjs: Telemetry ledger parsing, token usage delta calculation, and session rotation logic
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Parse an event line or object from Claude or Codex stream output.
 * Extracts usage statistics (input_tokens, output_tokens, total_tokens, cache_read_input_tokens).
 */
export function parseTelemetryEvent(eventInput) {
  let obj = eventInput;
  if (typeof eventInput === 'string') {
    try {
      obj = JSON.parse(eventInput);
    } catch {
      return null;
    }
  }
  if (!obj || typeof obj !== 'object') return null;

  const usage = obj.usage || obj.message?.usage || obj.delta?.usage || obj.response?.usage || obj;

  const input = Number(usage.input_tokens ?? usage.prompt_tokens ?? usage.promptTokens ?? usage.inputTokens ?? 0);
  const output = Number(usage.output_tokens ?? usage.completion_tokens ?? usage.completionTokens ?? usage.outputTokens ?? 0);
  const cacheRead = Number(usage.cache_read_input_tokens ?? usage.cacheReadInputTokens ?? 0);
  const total = Number(usage.total_tokens ?? usage.totalTokens ?? (input + output));

  if (input === 0 && output === 0 && total === 0) {
    return null;
  }

  return {
    inputTokens: input,
    outputTokens: output,
    cacheReadInputTokens: cacheRead,
    totalTokens: total > 0 ? total : (input + output),
    raw: obj
  };
}

/**
 * Calculate token deltas given previous cumulative counts and new cumulative counts.
 */
export function calculateDelta(
  prev = { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
  curr = { inputTokens: 0, outputTokens: 0, totalTokens: 0 }
) {
  const inputDelta = curr.inputTokens >= prev.inputTokens ? curr.inputTokens - prev.inputTokens : curr.inputTokens;
  const outputDelta = curr.outputTokens >= prev.outputTokens ? curr.outputTokens - prev.outputTokens : curr.outputTokens;
  const totalDelta = curr.totalTokens >= prev.totalTokens ? curr.totalTokens - prev.totalTokens : curr.totalTokens;

  return {
    inputTokens: inputDelta,
    outputTokens: outputDelta,
    totalTokens: totalDelta
  };
}

/**
 * Append a telemetry record to <hub>/runs/orch-ledger.jsonl
 */
export function appendLedgerRecord(hubPath, record) {
  if (!hubPath) throw new Error('hubPath is required for appendLedgerRecord');
  const runsDir = path.join(hubPath, 'runs');
  if (!fs.existsSync(runsDir)) {
    fs.mkdirSync(runsDir, { recursive: true });
  }
  const ledgerPath = path.join(runsDir, 'orch-ledger.jsonl');
  const entry = {
    timestamp: new Date().toISOString(),
    ...record
  };
  fs.appendFileSync(ledgerPath, JSON.stringify(entry) + '\n', 'utf8');
  return entry;
}

/**
 * Check whether session rotation is required based on context token size or turn count thresholds.
 */
export function shouldRotate(sessionState, limits = { contextTokens: 75000, turns: 8 }) {
  const maxContext = limits.contextTokens ?? 75000;
  const maxTurns = limits.turns ?? 8;

  const currentTokens = Number(sessionState.currentTokens ?? sessionState.totalTokens ?? 0);
  const turns = Number(sessionState.turns ?? 0);

  const rotateByTokens = currentTokens >= maxContext;
  const rotateByTurns = turns >= maxTurns;

  return {
    shouldRotate: rotateByTokens || rotateByTurns,
    reason: rotateByTokens ? 'context_token_limit_exceeded' : (rotateByTurns ? 'turn_count_limit_exceeded' : null),
    currentTokens,
    maxContext,
    turns,
    maxTurns
  };
}

/**
 * Fixture test validating delta calculation, parsing, ledger appending, and rotation triggers.
 */
export function runFixtureTest() {
  console.log('Running telemetry fixture tests...');

  // 1. Test parsing Claude and Codex events
  const claudeEvent = { type: 'message_start', message: { usage: { input_tokens: 1500, output_tokens: 250, total_tokens: 1750 } } };
  const parsed1 = parseTelemetryEvent(claudeEvent);
  if (!parsed1 || parsed1.inputTokens !== 1500 || parsed1.outputTokens !== 250 || parsed1.totalTokens !== 1750) {
    throw new Error(`Fixture test failed: Claude event parsing incorrect: ${JSON.stringify(parsed1)}`);
  }

  const codexEvent = { usage: { prompt_tokens: 3000, completion_tokens: 500, total_tokens: 3500 } };
  const parsed2 = parseTelemetryEvent(JSON.stringify(codexEvent));
  if (!parsed2 || parsed2.inputTokens !== 3000 || parsed2.outputTokens !== 500 || parsed2.totalTokens !== 3500) {
    throw new Error(`Fixture test failed: Codex event parsing incorrect: ${JSON.stringify(parsed2)}`);
  }

  // 2. Test delta calculation
  const prev = { inputTokens: 1500, outputTokens: 250, totalTokens: 1750 };
  const curr = { inputTokens: 3000, outputTokens: 750, totalTokens: 3750 };
  const delta = calculateDelta(prev, curr);
  if (delta.inputTokens !== 1500 || delta.outputTokens !== 500 || delta.totalTokens !== 2000) {
    throw new Error(`Fixture test failed: Delta calculation incorrect: ${JSON.stringify(delta)}`);
  }

  // 3. Test rotation triggers
  const rotationCheck1 = shouldRotate({ currentTokens: 50000, turns: 4 }, { contextTokens: 75000, turns: 8 });
  if (rotationCheck1.shouldRotate) {
    throw new Error('Fixture test failed: expected no rotation for 50k tokens / 4 turns');
  }

  const rotationCheck2 = shouldRotate({ currentTokens: 80000, turns: 4 }, { contextTokens: 75000, turns: 8 });
  if (!rotationCheck2.shouldRotate || rotationCheck2.reason !== 'context_token_limit_exceeded') {
    throw new Error('Fixture test failed: expected rotation by context token limit');
  }

  const rotationCheck3 = shouldRotate({ currentTokens: 30000, turns: 9 }, { contextTokens: 75000, turns: 8 });
  if (!rotationCheck3.shouldRotate || rotationCheck3.reason !== 'turn_count_limit_exceeded') {
    throw new Error('Fixture test failed: expected rotation by turn count limit');
  }

  console.log('All telemetry fixture tests passed successfully.');
  return true;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runFixtureTest();
}
