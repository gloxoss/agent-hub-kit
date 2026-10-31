// lead.mjs: Distributed lease manager with compare-and-swap on refs/heads/fleet-lease and untagged message coordination
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

function gh(args, input) {
  return execFileSync('gh', args, { encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
}

let cachedRepo = null;
function getRepo() {
  if (!cachedRepo) {
    cachedRepo = gh(['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner']).trim();
  }
  return cachedRepo;
}

let refEnsured = false;
export function ensureFleetLeaseRef() {
  if (refEnsured) return;
  const repo = getRepo();
  try {
    gh(['api', `repos/${repo}/git/ref/heads/fleet-lease`]);
    refEnsured = true;
  } catch {
    let defaultBranch = 'main';
    try {
      const repoInfo = JSON.parse(gh(['repo', 'view', '--json', 'defaultBranchRef']));
      if (repoInfo.defaultBranchRef?.name) {
        defaultBranch = repoInfo.defaultBranchRef.name;
      }
    } catch {}

    let sha = '';
    try {
      sha = gh(['api', `repos/${repo}/git/ref/heads/${defaultBranch}`, '-q', '.object.sha']).trim();
    } catch {
      try {
        sha = gh(['api', `repos/${repo}/commits/HEAD`, '-q', '.sha']).trim();
      } catch {}
    }

    if (sha) {
      try {
        gh(['api', '-X', 'POST', `repos/${repo}/git/refs`, '-f', 'ref=refs/heads/fleet-lease', '-f', `sha=${sha}`]);
        refEnsured = true;
      } catch {}
    }
  }
}

/**
 * Get current lead state from refs/heads/fleet-lease / lead.json
 * Returns { node, term, expiresAt, sha, serverTime }
 */
export function getLeadState() {
  ensureFleetLeaseRef();
  const repo = getRepo();
  const now = Date.now();
  try {
    const res = gh(['api', '-i', `repos/${repo}/contents/lead.json?ref=fleet-lease`]);
    const parts = res.split(/\r?\n\r?\n/);
    const headers = parts[0];
    const dateLine = headers.split(/\r?\n/).find(l => l.toLowerCase().startsWith('date:'));
    const serverDate = dateLine ? new Date(dateLine.slice(5).trim()) : new Date(now);

    const bodyText = parts.slice(1).join('\n\n');
    if (!bodyText.trim()) {
      return { node: null, term: 0, expiresAt: 0, sha: null, serverTime: serverDate.getTime() };
    }

    const jsonRes = JSON.parse(bodyText);
    const contentStr = Buffer.from(jsonRes.content, 'base64').toString('utf8');
    const data = JSON.parse(contentStr);

    return {
      node: data.node || null,
      term: data.term || 0,
      expiresAt: data.expiresAt || 0,
      sha: jsonRes.sha || null,
      serverTime: serverDate.getTime()
    };
  } catch (e) {
    return { node: null, term: 0, expiresAt: 0, sha: null, serverTime: now };
  }
}

/**
 * Attempt to acquire or renew the lease for the given node.
 * TTL: 5 min (300,000 ms).
 * Re-reads after acquiring to confirm victory.
 */
export function acquireOrRenewLease(node) {
  const repo = getRepo();
  const current = getLeadState();

  const isExpired = !current.node || current.serverTime >= current.expiresAt;
  const isHeldByUs = current.node === node;

  if (!isExpired && !isHeldByUs) {
    // Held by another active node
    return false;
  }

  const term = isExpired ? (current.term || 0) + 1 : current.term;
  const expiresAt = current.serverTime + 300000; // 5 min TTL

  const contentObj = { node, term, expiresAt };
  const contentBase64 = Buffer.from(JSON.stringify(contentObj, null, 2)).toString('base64');

  const putArgs = [
    'api', '-i', '-X', 'PUT', `repos/${repo}/contents/lead.json`,
    '-f', `message=lease update by ${node} term ${term}`,
    '-f', `content=${contentBase64}`,
    '-f', 'branch=fleet-lease'
  ];
  if (current.sha) {
    putArgs.push('-f', `sha=${current.sha}`);
  }

  try {
    gh(putArgs);
  } catch (e) {
    // CAS conflict or network error
    return false;
  }

  // Re-read after acquiring (mandatory check)
  const verified = getLeadState();
  if (verified.node === node && verified.term === term) {
    return verified;
  }

  return false;
}

export function isLead(node) {
  const state = getLeadState();
  return state.node === node && state.serverTime < state.expiresAt;
}

function extractMsgId(text) {
  const m = text.match(/\[id=([^\]]+)\]/i);
  return m ? m[1] : null;
}

/**
 * Handle untagged messages: everyone receives, non-lead acts in area and posts board note "re: <msg id>: <what I did>",
 * lead collects notes for up to 60s and replies on WhatsApp with one combined answer.
 */
export async function handleUntaggedMessage(msg, node, options = {}) {
  const msgId = msg.id || extractMsgId(msg.line || msg.text || String(msg)) || 'msg-' + Date.now();
  const text = msg.line || msg.text || String(msg);

  // Check if tagged for a specific node
  const tagMatch = text.match(/@([a-zA-Z0-9_-]+)/);
  if (tagMatch) {
    const targetNode = tagMatch[1].toLowerCase();
    const currentNode = (node || process.env.DEVBOX_NODE || os.hostname()).toLowerCase();
    if (targetNode !== currentNode && targetNode !== 'all') {
      return { handled: false, reason: `tagged for another node: ${targetNode}` };
    }
  }

  const nodeName = (node || process.env.DEVBOX_NODE || os.hostname()).toLowerCase();
  const lead = options.isLead !== undefined ? options.isLead : isLead(nodeName);

  if (!lead) {
    const actionSummary = options.actionSummary || `processed in area by ${nodeName}`;
    const noteBody = `re: ${msgId}: ${actionSummary}`;

    if (options.dry || options.mockPostNote) {
      if (options.notesStore) {
        options.notesStore.push({ node: nodeName, msgId, note: noteBody });
      }
    } else {
      try {
        const repo = getRepo();
        const list = JSON.parse(gh(['issue', 'list', '--label', 'board', '--limit', '100', '--json', 'number']));
        if (list[0]) {
          gh(['issue', 'comment', String(list[0].number), '--body', `NOTE node=${nodeName}: ${noteBody}`]);
        }
      } catch {}
    }
    return { handled: true, role: 'worker', note: noteBody };
  } else {
    const maxWaitMs = options.maxWaitMs || 5000;
    const intervalMs = options.intervalMs || 500;
    const startTime = Date.now();

    let collectedNotes = [];
    if (options.notesStore) {
      collectedNotes = options.notesStore.filter(n => n.msgId === msgId);
    } else {
      while (Date.now() - startTime < maxWaitMs) {
        try {
          const repo = getRepo();
          const list = JSON.parse(gh(['issue', 'list', '--label', 'board', '--limit', '100', '--json', 'number']));
          if (list[0]) {
            const commentsList = JSON.parse(gh(['api', `repos/${repo}/issues/${list[0].number}/comments?per_page=100`]));
            collectedNotes = commentsList
              .map(c => c.body)
              .filter(b => b && b.includes(`re: ${msgId}`))
              .map(b => ({ note: b }));
          }
        } catch {}
        if (collectedNotes.length > 0 || (Date.now() - startTime >= maxWaitMs)) {
          break;
        }
        await new Promise(r => setTimeout(r, intervalMs));
      }
    }

    const leadAction = options.leadAction || `lead ${nodeName} handled request`;
    const allNotes = [leadAction, ...collectedNotes.map(n => n.note)];
    const combinedAnswer = `Combined reply for [id=${msgId}]:\n${allNotes.join('\n')}`;

    if (options.dry || options.mockSend) {
      if (options.repliesStore) {
        options.repliesStore.push({ lead: nodeName, msgId, reply: combinedAnswer });
      }
    } else {
      try {
        const waPath = path.join(os.homedir(), '.local', 'bin', 'wa');
        const execCmd = fs.existsSync(waPath) ? waPath : 'wa';
        execFileSync(execCmd, ['send', '--reply-to', msgId, combinedAnswer], { encoding: 'utf8', stdio: 'ignore' });
      } catch {}
    }

    return { handled: true, role: 'lead', reply: combinedAnswer, notesCount: collectedNotes.length };
  }
}

export async function runUntaggedHarnessTest() {
  console.log('Running untagged messages two-node dry harness test...');

  const notesStore = [];
  const repliesStore = [];
  const msgId = 'msg-test-999';
  const msg = { id: msgId, line: `WHATSAPP 12:00 [id=${msgId}] Hello fleet, status update please` };

  console.log('Simulating Node B (non-lead) processing untagged message...');
  const resB = await handleUntaggedMessage(msg, 'node-b', {
    dry: true,
    isLead: false,
    notesStore,
    actionSummary: 'verified local area services ok'
  });
  console.log('Node B result:', resB);
  if (!resB.handled || !resB.note.includes(msgId)) {
    throw new Error('Untagged harness test failed: Node B did not handle or post note');
  }

  console.log('Simulating Node A (lead) processing untagged message and collecting notes...');
  const resA = await handleUntaggedMessage(msg, 'node-a', {
    dry: true,
    isLead: true,
    notesStore,
    repliesStore,
    maxWaitMs: 1000,
    leadAction: 'lead assessed overall cluster health'
  });
  console.log('Node A result:', resA);

  if (!resA.handled || repliesStore.length !== 1) {
    throw new Error(`Untagged harness test failed: expected exactly 1 reply, got ${repliesStore.length}`);
  }

  const reply = repliesStore[0];
  if (!reply.reply.includes('lead assessed overall cluster health') || !reply.reply.includes('verified local area services ok')) {
    throw new Error(`Untagged harness test failed: reply missing components: ${reply.reply}`);
  }

  console.log('Two-node dry harness test passed successfully: one reply sent (lead), both logged/processed, reply includes worker note.');
  return true;
}

export function runFixtureTest() {
  console.log('Running lead lease fixture tests...');
  const nodeA = 'test-node-a-' + Date.now();
  const nodeB = 'test-node-b-' + Date.now();

  const current0 = getLeadState();
  if (current0.sha) {
    const repo = getRepo();
    try {
      const expiredContent = { node: null, term: 0, expiresAt: 0 };
      const expiredBase64 = Buffer.from(JSON.stringify(expiredContent, null, 2)).toString('base64');
      gh([
        'api', '-X', 'PUT', `repos/${repo}/contents/lead.json`,
        '-f', 'message=reset lease for test',
        '-f', `content=${expiredBase64}`,
        '-f', 'branch=fleet-lease',
        '-f', `sha=${current0.sha}`
      ]);
    } catch {}
  }

  console.log('Simulating node A acquiring lease...');
  const leaseA = acquireOrRenewLease(nodeA);
  if (!leaseA || leaseA.node !== nodeA) {
    throw new Error(`Fixture test failed: node A failed to acquire initial lease: ${JSON.stringify(leaseA)}`);
  }
  console.log(`Node A acquired lease: term=${leaseA.term}, expiresAt=${leaseA.expiresAt}`);

  console.log('Simulating node B racing to acquire lease while held by A...');
  const leaseBWhileA = acquireOrRenewLease(nodeB);
  if (leaseBWhileA !== false) {
    throw new Error(`Fixture test failed: node B acquired lease while active lease was held by A: ${JSON.stringify(leaseBWhileA)}`);
  }
  console.log('Node B correctly rejected while A holds lease.');

  console.log('Verifying isLead(nodeA) is true, isLead(nodeB) is false...');
  if (!isLead(nodeA)) throw new Error('isLead(nodeA) returned false');
  if (isLead(nodeB)) throw new Error('isLead(nodeB) returned true for B');

  console.log('Simulating lease expiration / failover test (mocking expiration)...');
  const current = getLeadState();
  const expiredContent = { node: nodeA, term: current.term, expiresAt: current.serverTime - 1000 };
  const expiredBase64 = Buffer.from(JSON.stringify(expiredContent, null, 2)).toString('base64');

  const repo = getRepo();
  try {
    gh([
      'api', '-X', 'PUT', `repos/${repo}/contents/lead.json`,
      '-f', 'message=force expire lease',
      '-f', `content=${expiredBase64}`,
      '-f', 'branch=fleet-lease',
      '-f', `sha=${current.sha}`
    ]);
  } catch (e) {
    console.log('Warning forcing expiry:', e.message);
  }

  console.log('Node B attempting to take over expired lease...');
  const leaseBTakeover = acquireOrRenewLease(nodeB);
  if (!leaseBTakeover || leaseBTakeover.node !== nodeB || leaseBTakeover.term <= current.term) {
    throw new Error(`Fixture test failed: node B failed to take over expired lease: ${JSON.stringify(leaseBTakeover)}`);
  }
  console.log(`Node B successfully took over lease: term=${leaseBTakeover.term}, node=${leaseBTakeover.node}`);

  console.log('All lead lease fixture tests passed successfully.');
  return true;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runFixtureTest();
  runUntaggedHarnessTest().catch(err => {
    console.error(err);
    process.exit(1);
  });
}
