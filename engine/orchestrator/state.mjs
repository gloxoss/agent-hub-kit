// state.mjs: Crash-safe atomic state management for orchestrator v2
import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_STATE = {
  sessions: {},
  until: null,
  current: null,
  ledgerPointer: null,
  lastAlertKey: null,
  turnsThisHour: 0,
  updatedAt: null,
};

export function getStateFilePath(hubPath) {
  return path.join(hubPath, 'orch-driver.json');
}

export function loadState(hubPath) {
  const filePath = getStateFilePath(hubPath);
  if (!fs.existsSync(filePath)) {
    return { ...DEFAULT_STATE };
  }
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    if (!content.trim()) return { ...DEFAULT_STATE };
    const parsed = JSON.parse(content);
    return {
      ...DEFAULT_STATE,
      ...parsed,
      sessions: parsed.sessions || {},
    };
  } catch (err) {
    const backupPath = `${filePath}.corrupt-${Date.now()}`;
    try {
      if (fs.existsSync(filePath)) {
        fs.copyFileSync(filePath, backupPath);
      }
    } catch {}
    return { ...DEFAULT_STATE };
  }
}

export function saveState(hubPath, state) {
  const filePath = getStateFilePath(hubPath);
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const payload = {
    ...DEFAULT_STATE,
    ...state,
    updatedAt: new Date().toISOString(),
  };

  const tmpPath = `${filePath}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  fs.renameSync(tmpPath, filePath);
  return payload;
}
