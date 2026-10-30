# Section 05: Runtime and ops

## Overview
The orchestrator runs as a service that restarts itself and resumes, logs are kept 7 days, new work pauses
when memory or disk is low, and the disk is enlarged.

## Risk: [yellow] - systemd user units need linger and delegated controllers; disk resize is an owner step.

## Dependencies
- Depends on: none
- Blocks: section-13
- Parallel batch: 1

## TDD Test Stubs
- Test: `kill -9` of the driver → it is running again within 15 s and resumes its queue.
- Test: with `buildMinFreeMB` above free RAM, dispatch prints "not dispatched: low memory" and starts nothing.
- Test: logrotate dry run rotates `runs/*.log` older than a day and keeps 7.
- Test: a schedule-worker idle-connection error is logged without taking down Next; the 3401 systemd unit restarts after a killed dev server.

## Tasks

<task type="auto" id="05-01">
  <name>Orchestrator as a restartable service</name>
  <files>devbox: bin/devbox (orch start/stop/enable), services/orch/orch@.service (new), services/orch/schoolos-3401.service (new); SchoolOS: lango-app/src/addons/advanced-reporting/services/schedule-worker.ts</files>
  <action>
    Replace the tmux-only start with a systemd user unit template `orch@<project>.service`: `ExecStart` runs the driver
    directly (no tmux), output appended to `<hub>/runs/orchestrator.log`,
    `Restart=always`, `RestartSec=5`, `StartLimitIntervalSec=300`, `StartLimitBurst=5`, `MemoryHigh=800M`, `MemoryMax=1G`.
    `devbox orch start|stop|enable|disable|status <p>` call `systemctl --user`. `devbox orch attach <p>` opens the dashboard
    (section 11) or `tail -f` of the log until then. Keep `devbox orch chat` (interactive Claude in tmux) unchanged. For the
    SchoolOS pilot, also supervise the port-3401 Next dev server with a persistent systemd unit, not a naked background shell.
    Catch idle PostgreSQL disconnects around schedule-worker reads, log the failure and continue serving; one transient
    schedule query must not terminate Next.
  </action>
  <verify>`devbox orch enable lango…` then `kill -9 $(pgrep -f orch-driver)` → `systemctl --user is-active orch@lango…` active again within 15 s; `schoolos-3401` restarts and serves `/fr/login`; injected idle-DB failure is logged and the process stays active.</verify>
  <done>Crashes and reboots bring the orchestrator back by itself.</done>
</task>

<task type="auto" id="05-02">
  <name>Log retention</name>
  <files>devbox: modules/90-services.sh, services/logrotate/agent-hub (new)</files>
  <action>
    Install a user-level logrotate config (run by a daily user timer) for `~/projects/*/.hub/runs/*.log` and
    `~/projects/*/.agent-hub*/runs/*.log`: `daily rotate 7 compress delaycompress missingok notifempty copytruncate`.
    Document the journald admin step (SystemMaxUse=200M, MaxRetentionSec=7day) as an [USER] note in the module output.
  </action>
  <verify>`logrotate -d` with the config shows the expected rotations; the user timer is listed by `systemctl --user list-timers`.</verify>
  <done>Logs never fill the disk; 7 days stay available.</done>
</task>

<task type="auto" id="05-03">
  <name>Memory and disk gate before dispatch</name>
  <files>engine/dispatch.mjs (resource gate ~379 and review gate ~424 only), engine/config.json</files>
  <action>
    Defaults `resources.buildMinFreeMB: 2048`, `resources.minFreeDiskGB: 5`. Add a disk check (`fs.statfs` on ROOT) next to
    the RAM gate for both build and review. When blocked print `not dispatched: low memory (X MB free)` / `low disk (Y GB free)`
    so the autoloop retries later; the orchestrator gets a `RESOURCE` line once per hour at most.
  </action>
  <verify>Set the thresholds above current free values in a copy → dispatch refuses with the message; reset → dispatches.</verify>
  <done>The server never starts new work it has no room for.</done>
</task>

<task type="checkpoint" id="05-04">
  <name>Owner: enlarge the server disk</name>
  <files>none (Oracle console + server admin)</files>
  <action>
    Send the owner: "Disk is at NN%. In Oracle Console → Block Storage → Boot volumes → dev-box boot volume → Edit → size 100 GB → Save.
    Then reply 'resized'." After the reply, the executor runs (as admin, `ssh vps`): `lsblk`, `sudo growpart /dev/sda 1`,
    `sudo resize2fs /dev/sda1`, `df -h /` (adjust device names from lsblk). If lsblk shows no new size, ask the owner for a reboot.
  </action>
  <verify>`df -h /` shows about 100 GB total.</verify>
  <done>The server has room for one working copy per builder.</done>
</task>

<task type="auto" id="05-05">
  <name>Stop workers that run twice their normal time</name>
  <files>engine/autoloop.mjs (running-job check), engine/dispatch.mjs (job duration history)</files>
  <action>
    Keep per executor+phase median durations in `<hub>/runs/durations.json` (updated when a job ends). In the autoloop tick,
    a RUNNING job older than 2x its median (minimum 20 min, default 45 min when no history) is stopped (process tree kill),
    its lane kicked, and the task re-dispatched to a different healthy builder with a brief note "stopped after N min
    (2x normal)". Print `MOVED <id>: slow` (report buffer, not a wake).
  </action>
  <verify>Fixture: a fake job with a 10-min median running 25 min is stopped and re-queued to another executor.</verify>
  <done>A stuck worker never holds a task for hours.</done>
</task>

<task type="auto" id="05-06">
  <name>Run the manager on the Windows PC as a restarting background task</name>
  <files>engine/tools/orch-service.mjs (new)</files>
  <action>
    `node orch-service.mjs install|uninstall|status <repoDir>`: on Windows create a Task Scheduler task (`schtasks /Create /SC ONLOGON
    /RL LIMITED /TN agent-hub-orch-<repo>`) that starts a small hidden supervisor (`node orch-service.mjs run <repoDir>`, launched
    with `wscript`/`powershell -WindowStyle Hidden` so no window appears) which runs `orch-driver.mjs` and restarts it 5 s after any
    exit, max 5 restarts per 5 min, appending to `<hub>/runs/orchestrator.log`. On Linux print the `devbox orch enable` command
    instead. Supports `--help` (selftest rule).
  </action>
  <verify>On the PC: `install` then end the driver process in Task Manager → it is back within 10 s; `status` shows running; no console window appears.</verify>
  <done>The PC's manager survives crashes and restarts at login, like the servers'.</done>
</task>
