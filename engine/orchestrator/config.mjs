// config.mjs: Project-neutral configuration and hub resolution for orchestrator v2
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export function resolveConfig(startDir = process.cwd()) {
  let root = path.resolve(startDir);
  let current = root;
  let hubDir = null;
  let hubPath = null;

  while (true) {
    for (const candidate of ['.hub', '.agent-hub-orch', '.agent-hub']) {
      const p = path.join(current, candidate);
      if (fs.existsSync(p) && fs.statSync(p).isDirectory()) {
        hubDir = candidate;
        hubPath = p;
        root = current;
        break;
      }
    }
    if (hubPath) break;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  if (!hubPath) {
    for (const candidate of ['.hub', '.agent-hub-orch', '.agent-hub']) {
      const p = path.join(root, candidate);
      if (fs.existsSync(p)) {
        hubDir = candidate;
        hubPath = p;
        break;
      }
    }
    if (!hubPath) {
      hubDir = '.hub';
      hubPath = path.join(root, '.hub');
    }
  }

  let rawConfig = {};
  const configJsonPath = path.join(hubPath, 'config.json');
  if (fs.existsSync(configJsonPath)) {
    try {
      rawConfig = JSON.parse(fs.readFileSync(configJsonPath, 'utf8'));
    } catch {
      // ignore parse errors
    }
  } else {
    const rootConfigPath = path.join(root, 'config.json');
    if (fs.existsSync(rootConfigPath)) {
      try {
        rawConfig = JSON.parse(fs.readFileSync(rootConfigPath, 'utf8'));
      } catch {}
    }
  }

  const orchConfig = rawConfig.orchestrator || {};
  const defaults = {
    maxTurnsPerHour: 6,
    silenceMinutes: 5,
    turnMinutes: 20,
    rotate: { contextTokens: 75000, turns: 8 },
    quietHours: "23:00-08:00",
    screenshotCommand: null,
    reportEveryMinutes: 15,
    heartbeatMinutes: 60,
  };

  const orchestrator = {
    ...defaults,
    ...orchConfig,
    rotate: {
      ...defaults.rotate,
      ...(orchConfig.rotate || {}),
    },
  };

  const nodeName = process.env.DEVBOX_NODE || os.hostname() || 'devbox';
  const projectName = rawConfig.name || path.basename(root);

  return {
    root,
    hubDir,
    hubPath,
    nodeName,
    projectName,
    orchestrator,
    raw: rawConfig,
  };
}
