// Shared event folding logic for hub.mjs and board.mjs
const TTL_MIN = 45;
const ago = (t) => Math.round((Date.now() - Date.parse(t)) / 60000);

export function fold(events) {
  let agents = {};
  let tasks = {};
  let messages = [];

  let startIndex = -1;
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].type === 'snapshot') {
      startIndex = i;
      const snap = events[i];
      const snapState = snap.state || snap;
      agents = JSON.parse(JSON.stringify(snapState.agents || {}));
      tasks = JSON.parse(JSON.stringify(snapState.tasks || {}));
      messages = JSON.parse(JSON.stringify(snapState.messages || []));
      break;
    }
  }

  const startLoop = startIndex === -1 ? 0 : startIndex + 1;
  for (let i = startLoop; i < events.length; i++) {
    const e = events[i];
    if (e.agent && agents[e.agent]) agents[e.agent].lastSeen = e.t;
    switch (e.type) {
      case 'snapshot':
        const snapState = e.state || e;
        agents = JSON.parse(JSON.stringify(snapState.agents || {}));
        tasks = JSON.parse(JSON.stringify(snapState.tasks || {}));
        messages = JSON.parse(JSON.stringify(snapState.messages || []));
        break;
      case 'join':
        agents[e.agent] = { id: e.agent, role: e.role, tool: e.tool, note: e.note, lastSeen: e.t, active: true };
        break;
      case 'leave':
        if (agents[e.agent]) agents[e.agent].active = false;
        for (const t of Object.values(tasks)) {
          if (t.claimedBy === e.agent) {
            t.claimedBy = null;
            t.files = [];
            if (t.status === 'CLAIMED') t.status = t.assignee ? 'ASSIGNED' : 'OPEN';
          }
        }
        break;
      case 'heartbeat':
        if (agents[e.agent]) agents[e.agent].note = e.note ?? agents[e.agent].note;
        break;
      case 'task-add':
        tasks[e.id] = {
          id: e.id,
          phase: e.phase,
          title: e.title,
          deps: e.deps ?? [],
          scope: e.scope ?? [],
          status: 'OPEN',
          assignee: null,
          claimedBy: null,
          files: [],
          history: []
        };
        break;
      case 'assign':
        tasks[e.id].assignee = e.to;
        if (['OPEN', 'REWORK'].includes(tasks[e.id].status) && !tasks[e.id].claimedBy) {
          tasks[e.id].status = 'ASSIGNED';
        }
        break;
      case 'claim':
        Object.assign(tasks[e.id], { claimedBy: e.agent, files: e.files, status: 'CLAIMED' });
        break;
      case 'files':
        tasks[e.id].files = [...new Set([...tasks[e.id].files, ...e.files])];
        break;
      case 'progress':
        tasks[e.id].lastNote = tasks[e.id].note = e.note;
        break;
      case 'block':
        Object.assign(tasks[e.id], { status: 'BLOCKED', lastNote: e.note, note: e.note });
        break;
      case 'release':
        Object.assign(tasks[e.id], {
          claimedBy: null,
          files: [],
          status: tasks[e.id].assignee ? 'ASSIGNED' : 'OPEN',
          lastNote: e.note,
          note: e.note
        });
        break;
      case 'done':
        Object.assign(tasks[e.id], {
          status: 'REVIEW',
          doneBy: e.agent,
          summary: e.summary,
          changed: e.files,
          verifyCmd: e.verify,
          claimedBy: null,
          files: []
        });
        break;
      case 'verify':
        Object.assign(tasks[e.id], {
          status: e.ok ? 'VERIFIED' : 'REWORK',
          verifiedBy: e.agent,
          verifyNote: e.note,
          note: e.note,
          report: e.report
        });
        break;
      case 'accept':
        Object.assign(tasks[e.id], {
          status: 'ACCEPTED',
          acceptNote: e.note,
          note: e.note,
          acceptedAt: e.t
        });
        break;
      case 'reject':
        Object.assign(tasks[e.id], { status: 'REWORK', lastNote: e.note, note: e.note });
        break;
      case 'edit':
        for (const k of ['deps', 'scope', 'title', 'needsVerify', 'strict']) {
          if (e[k] !== undefined) tasks[e.id][k] = e[k];
        }
        break;
      case 'cancel':
        Object.assign(tasks[e.id], {
          status: 'CANCELLED',
          claimedBy: null,
          files: [],
          lastNote: e.note,
          note: e.note
        });
        break;
      case 'say':
        messages.push(e);
        break;
    }
    if (e.id && tasks[e.id] && e.type !== 'task-add') {
      tasks[e.id].history.push(`${e.t.slice(5, 16)} ${e.type} ${e.agent ?? ''}`);
    }
  }
  for (const a of Object.values(agents)) {
    a.stale = a.active && ago(a.lastSeen) > TTL_MIN;
  }
  return { agents, tasks, messages };
}
