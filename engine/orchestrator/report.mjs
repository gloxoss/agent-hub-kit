// report.mjs: the owner's periodic messages. Plain text. Quiet when nothing changed, one notice at night if idle,
// and hourly reminders (day and night) for numbered questions still unanswered. Sends are automatic-path messages
// (wa --auto): the WhatsApp budget merges them; replies to the owner never go through here.
import { createHash } from 'node:crypto';
import { digest } from './prompt.mjs';

const MIN = 60_000;

export function inQuietHours(range, now = new Date()) {
  const m = String(range ?? '').match(/^(\d\d):(\d\d)-(\d\d):(\d\d)$/);
  if (!m) return false;
  const cur = now.getHours() * 60 + now.getMinutes();
  const a = Number(m[1]) * 60 + Number(m[2]);
  const b = Number(m[3]) * 60 + Number(m[4]);
  return a <= b ? cur >= a && cur < b : cur >= a || cur < b;   // 23:00-08:00 wraps midnight
}

// The owner reads this on a phone: a few plain sentences, no job names, tokens, hours or commit text.
export function plainMessage(digestText, reason, doneBefore) {
  const n = (k) => Number((digestText.match(new RegExp(`${k} (\\d+)`)) || [])[1] ?? 0);
  const running = Number((digestText.match(/Running \((\d+)\)/) || [])[1] ?? 0);
  const done = n('ACCEPTED'), review = n('REVIEW'), open = n('OPEN') + n('ASSIGNED') + n('REWORK');
  const lines = [`${done} tasks are finished and accepted${doneBefore != null && done > doneBefore ? ` (${done - doneBefore} new since my last message)` : ''}.`];
  if (review) lines.push(`${review} more are built and waiting for a second check.`);
  if (open) lines.push(`${open} have not been finished yet.`);
  lines.push(running ? `${running} ${running === 1 ? 'is' : 'are'} being worked on right now.` : 'Nothing is being worked on right now.');
  if (reason) lines.push(reason);
  return { text: lines.join('\n'), done, running, review };
}

export function createReporter({ cfg, st, save, sendAuto, isIdle, why = () => '' }) {
  const o = cfg.orchestrator;
  return {
    // Call every minute. Sends at most one message per call.
    tick(now = Date.now()) {
      const quiet = inQuietHours(o.quietHours, new Date(now));
      const text = digest(cfg);
      const key = createHash('sha1').update(text.replace(/\d+ min/g, '')).digest('hex').slice(0, 12);
      const rep = (st.report ??= { key: null, lastAt: 0, heartbeatAt: now, quietNoticeFor: null });

      // 1. Unanswered numbered questions: remind every hour, day and night.
      const p = st.pending;
      if (p && now - (p.remindedAt ?? p.sentAt) >= 60 * MIN) {
        p.remindedAt = now;
        save();
        sendAuto(`Reminder (still waiting for your answer):\n${p.text}`);
        return 'reminder';
      }
      if (quiet) {
        // 2. Night: nothing routine; one notice per night if nothing is running.
        const night = new Date(now - 12 * 3600_000).toDateString();
        return null;
      }
      rep.quietNoticeFor = null;
      // 3. Change report at most every reportEveryMinutes, only if the fleet changed.
      // One plain message, only when something meaningful changed: more tasks accepted, or the stuck reason changed.
      // Otherwise silence, except one short reminder per 12 hours while nothing is moving.
      const reason = why() || (isIdle() && /REVIEW (\d+)/.test(text) ? 'Nothing can be accepted right now: the finished tasks need a second reviewer, and none is available. I retry by myself.' : '');
      const plain = plainMessage(text, reason, rep.done);
      const sig = `${plain.done}|${reason}`;
      const changed = sig !== rep.sig;
      const minGap = plain.done > (rep.done ?? 0) ? 30 : 180;
      if (changed && now - rep.lastAt >= minGap * MIN) {
        rep.sig = sig; rep.done = plain.done; rep.lastAt = now; rep.heartbeatAt = now; save();
        sendAuto(plain.text);
        return 'report';
      }
      // 4. Hourly heartbeat when nothing changed.
      // Two identical heartbeats are enough; after that the same line only repeats every heartbeatBackoffMinutes (default 6 h).
      if (isIdle() && now - rep.heartbeatAt >= (o.heartbeatMinutes ?? 720) * MIN) {
        rep.heartbeatAt = now; save();
        sendAuto(plainMessage(text, why(), rep.done).text + '\nNothing changed since my last message.');
        return 'heartbeat';
      }
      return null;
    },
    // Remember a question list sent to the owner; any owner message clears it.
    track(replyText, now = Date.now()) {
      // Only a real numbered question counts; "Decide: none" must not create hourly reminders.
      if (/^Decide:[\s\S]*^\s*\d+[.)]\s+\S/m.test(replyText)) { st.pending = { text: replyText.slice(replyText.search(/^Decide:/m)), sentAt: now }; save(); }
    },
    answered() { if (st.pending) { delete st.pending; save(); } },
  };
}

export function runSelfTest() {
  const wrap = (h, m) => new Date(2026, 9, 31, h, m);
  const checks = [
    ['23:30 is quiet', inQuietHours('23:00-08:00', wrap(23, 30))],
    ['03:00 is quiet', inQuietHours('23:00-08:00', wrap(3, 0))],
    ['08:00 not quiet', !inQuietHours('23:00-08:00', wrap(8, 0))],
    ['12:00 not quiet', !inQuietHours('23:00-08:00', wrap(12, 0))],
  ];
  const sent = [];
  const st = {};
  const cfg = { hubPath: '/nonexistent', root: '/nonexistent', orchestrator: { quietHours: '23:00-08:00', reportEveryMinutes: 15, heartbeatMinutes: 60 } };
  const rep = createReporter({ cfg, st, save() {}, sendAuto: (t) => sent.push(t), isIdle: () => true });
  rep.track('Headline\nDecide:\n1. Do X?\nReply: 1 yes 2 no', 0);
  checks.push(['tracks question', st.pending?.text.startsWith('Decide:')]);
  const noon = new Date(2026, 9, 31, 12, 0).getTime();
  st.pending.sentAt = noon - 61 * MIN;
  checks.push(['hourly reminder', rep.tick(noon) === 'reminder' && sent[0].startsWith('Reminder')]);
  const night = new Date(2026, 9, 31, 23, 30).getTime();
  delete st.pending;
  checks.push(['no night message', rep.tick(night) === null && rep.tick(night + MIN) === null]);
  rep.answered();
  let ok = true;
  for (const [name, pass] of checks) { console.log(`${pass ? 'PASS' : 'FAIL'} report: ${name}`); ok = ok && pass; }
  return ok;
}
