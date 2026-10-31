#!/usr/bin/env node
// Orchestrator service manager: Windows Task Scheduler integration & background supervisor.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
if (argv.includes('--help') || argv.includes('-h') || argv.length === 0) {
  console.log('usage: node orch-service.mjs install|uninstall|status|run <repoDir>');
  process.exit(0);
}

const action = argv[0];
const repoArg = argv[1] || '.';
const repoDir = path.resolve(repoArg);
const repoName = path.basename(repoDir);
const taskName = `agent-hub-orch-${repoName}`;
const toolsDir = path.dirname(fileURLToPath(import.meta.url));
const serviceScript = path.resolve(toolsDir, 'orch-service.mjs');
const driverScript = path.resolve(toolsDir, 'orch-driver.mjs');

// Find hub directory
const HUB = ['.agent-hub-orch', '.agent-hub', '.hub'].map((d) => path.join(repoDir, d)).find((d) => fs.existsSync(path.join(d, 'config.json')) || fs.existsSync(path.join(d, 'BOARD.md')));

if (process.platform !== 'win32') {
  if (action === 'install') {
    console.log(`[Linux/macOS] Windows Task Scheduler is not available on ${process.platform}.`);
    console.log(`To enable orchestrator daemon on Linux, use: devbox orch enable`);
    process.exit(0);
  } else if (action === 'uninstall') {
    console.log(`[Linux/macOS] No Windows scheduled task to uninstall.`);
    process.exit(0);
  } else if (action === 'status') {
    console.log(`[Linux/macOS] Checking orchestrator service status for ${repoDir}...`);
    if (HUB) {
      const logFile = path.join(HUB, 'runs', 'orchestrator.log');
      console.log(`Log path: ${logFile}`);
      if (fs.existsSync(logFile)) {
        const stats = fs.statSync(logFile);
        console.log(`Log size: ${stats.size} bytes, modified at ${stats.mtime}`);
      } else {
        console.log('No orchestrator log found yet.');
      }
    } else {
      console.log('No hub found in repoDir.');
    }
    process.exit(0);
  } else if (action !== 'run') {
    console.error(`unknown action: ${action}`);
    process.exit(1);
  }
}

if (action === 'install') {
  if (!fs.existsSync(repoDir)) {
    console.error(`Repository directory does not exist: ${repoDir}`);
    process.exit(1);
  }
  const psCommand = `
    $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument '-WindowStyle Hidden -Command "node \\\\\"${serviceScript.replace(/\\/g, '\\\\')}\\\\\" run \\\\\"${repoDir.replace(/\\/g, '\\\\')}\\\""'
    $trigger = New-ScheduledTaskTrigger -AtLogOn
    $principal = New-ScheduledTaskPrincipal -UserId "$env:USERNAME" -RunLevel Limited
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
    Register-ScheduledTask -TaskName '${taskName}' -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force
  `;
  const res = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psCommand], { encoding: 'utf8' });
  if (res.status !== 0) {
    console.error(`Failed to register scheduled task: ${res.stderr || res.stdout}`);
    process.exit(1);
  }
  console.log(`Successfully installed Windows Task Scheduler task: ${taskName}`);
  console.log(`Trigger: ONLOGON, RunLevel: Limited, Hidden Supervisor.`);
  process.exit(0);
}

if (action === 'uninstall') {
  const psCommand = `Unregister-ScheduledTask -TaskName '${taskName}' -Confirm:$false -ErrorAction SilentlyContinue`;
  const res = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psCommand], { encoding: 'utf8' });
  console.log(`Uninstalled scheduled task ${taskName} (if it existed).`);
  process.exit(0);
}

if (action === 'status') {
  const psCommand = `
    $task = Get-ScheduledTask -TaskName '${taskName}' -ErrorAction SilentlyContinue
    if ($task) {
      $info = Get-ScheduledTaskInfo -TaskName '${taskName}' -ErrorAction SilentlyContinue
      [PSCustomObject]@{
        TaskName = '${taskName}'
        State = $task.State
        LastRunTime = $info.LastRunTime
        LastResult = $info.LastResult
        NumberOfMissedRuns = $info.NumberOfMissedRuns
      } | Format-List
    } else {
      Write-Output "TASK_NOT_FOUND"
    }
  `;
  const res = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psCommand], { encoding: 'utf8' });
  console.log(res.stdout || res.stderr);
  if (HUB) {
    const logFile = path.join(HUB, 'runs', 'orchestrator.log');
    if (fs.existsSync(logFile)) {
      const stats = fs.statSync(logFile);
      console.log(`Orchestrator log: ${logFile} (${stats.size} bytes)`);
    }
  }
  process.exit(0);
}

if (action === 'run') {
  // Supervisor loop
  if (!HUB) {
    console.error(`No hub found in ${repoDir}`);
    process.exit(1);
  }
  const runsDir = path.join(HUB, 'runs');
  fs.mkdirSync(runsDir, { recursive: true });
  const logFile = path.join(runsDir, 'orchestrator.log');
  const logStream = fs.createWriteStream(logFile, { flags: 'a' });

  const writeLog = (msg) => {
    const line = `[${new Date().toISOString()}] [supervisor] ${msg}\n`;
    process.stdout.write(line);
    logStream.write(line);
  };

  writeLog(`Starting supervisor for repo: ${repoDir}`);
  const restartTimes = [];

  const runDriver = () => {
    // Check restart rate limit: max 5 restarts per 5 minutes (300,000 ms)
    const now = Date.now();
    while (restartTimes.length > 0 && now - restartTimes[0] > 300_000) {
      restartTimes.shift();
    }

    if (restartTimes.length >= 5) {
      writeLog(`Warning: 5 restarts reached within 5 minutes. Backing off for 60 seconds...`);
      setTimeout(runDriver, 60_000);
      return;
    }

    restartTimes.push(now);
    writeLog(`Launching orch-driver.mjs for ${repoDir}`);

    const child = spawn(process.execPath, [driverScript, repoDir], {
      cwd: repoDir,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    child.stdout.on('data', (data) => {
      process.stdout.write(data);
      logStream.write(data);
    });

    child.stderr.on('data', (data) => {
      process.stderr.write(data);
      logStream.write(data);
    });

    child.on('close', (code, signal) => {
      writeLog(`orch-driver exited with code ${code}, signal ${signal}. Waiting 5 seconds before restart...`);
      setTimeout(runDriver, 5_000);
    });

    child.on('error', (err) => {
      writeLog(`orch-driver failed to start: ${err.message}. Waiting 5 seconds before restart...`);
      setTimeout(runDriver, 5_000);
    });
  };

  runDriver();
  // Keep process alive
  process.on('SIGINT', () => {
    writeLog('Supervisor received SIGINT, shutting down.');
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    writeLog('Supervisor received SIGTERM, shutting down.');
    process.exit(0);
  });
} else {
  console.error(`Unknown action: ${action}. Use install, uninstall, status, or run.`);
  process.exit(1);
}
