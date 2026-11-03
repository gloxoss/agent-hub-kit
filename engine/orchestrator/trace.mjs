// trace.mjs: turn a manager's raw run (stream of tool calls) into 'what I did' lines the owner can check.
// Plain words only; nothing is invented: every line comes from a command or file the manager really touched.

const parse = (stdout) => {
  const out = [];
  for (const line of String(stdout ?? '').split(/\r?\n/)) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    try { out.push(JSON.parse(t)); } catch { /* not JSON */ }
  }
  return out;
};

// Every tool call as { tool, command?, file? }.
export function callsOf(stdout) {
  const calls = [];
  for (const e of parse(stdout)) {
    if (e.type === 'assistant' && Array.isArray(e.message?.content)) {
      for (const c of e.message.content) {
        if (c?.type !== 'tool_use') continue;
        const i = c.input ?? {};
        calls.push({ tool: c.name, command: i.command ?? i.cmd ?? '', file: i.file_path ?? i.path ?? '' });
      }
    } else if (e.type === 'item.completed' && e.item?.type === 'command_execution') {
      calls.push({ tool: 'Bash', command: e.item.command ?? '', file: '' });
    }
  }
  return calls;
}

const base = (p) => String(p).replace(/\\/g, '/').split('/').pop();

// A Bash command in plain words, or null when it is only plumbing.
export function describeCommand(cmd) {
  const c = String(cmd);
  let m;
  if ((m = c.match(/hub\.mjs\s+add\s+(\S+)/))) return `Created task ${m[1]}`;
  if ((m = c.match(/hub\.mjs\s+(assign|cancel|reject|kick)\s+(\S+)/))) return `${{ assign: 'Assigned', cancel: 'Cancelled', reject: 'Sent back', kick: 'Released the worker of' }[m[1]]} ${m[2]}`;
  if (/hub\.mjs\s+gc\b/.test(c)) return 'Cleaned up idle workers';
  if ((m = c.match(/accept\.mjs\s+(\S+)/))) return `Accepted ${m[1]}`;
  if ((m = c.match(/dispatch\.mjs\s+review\s+(\S+)\s+(\S+)/))) return `Started a review of ${m[1]} on ${m[2]}`;
  if ((m = c.match(/dispatch\.mjs\s+run\s+(\S+)\s+(\S+)(?:\s+(\S+))?/))) return `Started work on ${m[3] ?? m[2]} on ${m[1]}`;
  if (/shot\.mjs/.test(c)) return 'Took a screenshot';
  if (/\bagy(-rotate)?\b/.test(c)) return 'Asked the browser agent';
  if (/wa(\.mjs)?\s+(image|file)/.test(c)) return 'Sent you a file';
  if (/(hub\.mjs\s+status|dispatch\.mjs\s+list|quota\.mjs|board\.mjs)/.test(c)) return 'Checked the fleet';
  if (/config\.json|orch-control|executors\.json|accounts\.json/.test(c) && />|tee|sed -i|writeFile/.test(c)) return 'Changed a setting';
  return null;
}

// Up to `max` lines, oldest first, no duplicates.
export function actionsOf(stdout, max = 6) {
  const lines = [];
  let reads = 0;
  for (const c of callsOf(stdout)) {
    let d = null;
    if (c.tool === 'Bash') d = describeCommand(c.command);
    else if (/^(Edit|Write|MultiEdit)$/.test(c.tool) && c.file) d = `Wrote ${base(c.file)}`;
    else if (c.tool === 'Read' && c.file) reads += 1;
    if (d && !lines.includes(d)) lines.push(d);
  }
  if (reads) lines.push(`Read ${reads} file${reads === 1 ? '' : 's'} to answer`);
  return lines.slice(0, max);
}

export const traceBlock = (stdout) => {
  const a = actionsOf(stdout);
  return a.length ? `\n\n*What I did*\n${a.map((x) => `• ${x}`).join('\n')}` : '';
};

export function runSelfTest() {
  const ev = (cmd) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: cmd } }] } });
  const stdout = [
    ev('node .agent-hub-orch/hub.mjs status --agent orchestrator-1'),
    ev('node .agent-hub-orch/hub.mjs add P-new-page --phase build --title x'),
    ev('node .agent-hub-orch/dispatch.mjs review P-old codex'),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/a/b.md' } }] } }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Write', input: { file_path: '/p/docs/HANDOFF.md' } }] } }),
  ].join('\n');
  const a = actionsOf(stdout);
  const checks = [
    ['task creation', a.includes('Created task P-new-page')],
    ['review start', a.includes('Started a review of P-old on codex')],
    ['status check', a.includes('Checked the fleet')],
    ['file write and read count', a.includes('Wrote HANDOFF.md') && a.includes('Read 1 file to answer')],
    ['empty run has no block', traceBlock('') === ''],
    ['block shape', traceBlock(stdout).startsWith('\n\n*What I did*\n• ')],
  ];
  let ok = true;
  for (const [n, p] of checks) { console.log(`${p ? 'PASS' : 'FAIL'} trace: ${n}`); ok = ok && p; }
  return ok;
}
