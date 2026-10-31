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

export function createReporter({ cfg, st, save, sendAuto, isIdle }) {
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
        if (isIdle() && rep.quietNoticeFor !== night) {
          rep.quietNoticeFor = night; save();
          sendAuto('Nothing is running. Reply with a task when you want work to start.');
          return 'quiet-notice';
        }
        return null;
      }
      rep.quietNoticeFor = null;
      // 3. Change report at most every reportEveryMinutes, only if the fleet changed.
      if (key !== rep.key && now - rep.lastAt >= (o.reportEveryMinutes ?? 15) * MIN) {
        rep.key = key; rep.lastAt = now; rep.heartbeatAt = now; save();
        sendAuto(`Fleet update\n${text}`);
        return 'report';
      }
      // 4. Hourly heartbeat when nothing changed.
      if (now - rep.heartbeatAt >= (o.heartbeatMinutes ?? 60) * MIN) {
        rep.heartbeatAt = now; save();
        sendAuto(`No change in the last hour.\n${text}${isIdle() ? '\nNothing is running; reply with a task to start work.' : ''}`);
        return 'heartbeat';
      }
      return null;
    },
    // Remember a question list sent to the owner; any owner message clears it.
    track(replyText, now = Date.now()) {
      if (/^Decide:/m.test(replyText)) { st.pending = { text: replyText.slice(replyText.search(/^Decide:/m)), sentAt: now }; save(); }
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
  checks.push(['night notice once', rep.tick(night) === 'quiet-notice' && rep.tick(night + MIN) === null]);
  rep.answered();
  let ok = true;
  for (const [name, pass] of checks) { console.log(`${pass ? 'PASS' : 'FAIL'} report: ${name}`); ok = ok && pass; }
  return ok;
}
