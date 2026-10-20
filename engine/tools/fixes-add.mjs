#!/usr/bin/env node
// Append audit fix records under a shared lock. Run: node <hub>/tools/fixes-add.mjs "ID | fixed | files | proof" [...].
import fs from 'node:fs';
import path from 'node:path';
import { auditPath, help, lock } from './runtime.mjs';

help('usage: fixes-add.mjs "<ID> | fixed / false alarm / checked / blocked | files | proof" [...]');
const lines = process.argv.slice(2).map((s) => s.trim()).filter(Boolean);
if (!lines.length || lines.some((l) => /[\r\n]/.test(l) || !/^[A-Za-z][A-Za-z0-9_-]*\s+\|\s*(fixed|false alarm|checked|blocked)\b[^|]*\|[^|]*\|.+$/.test(l))) throw new Error('wrong fix record format; run --help');
const release = lock('fixes');
try {
  const file = auditPath('fixes');
  const raw = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '# Fix records\n\n';
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  const have = new Set(raw.split(/\r?\n/).map((l) => l.split('|')[0].trim()));
  const fresh = lines.filter((l) => { const id = l.split('|')[0].trim(); if (have.has(id)) return false; have.add(id); return true; });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fresh.length) fs.writeFileSync(file, raw + (raw.endsWith('\n') ? '' : eol) + fresh.join(eol) + eol);
  console.log(`fixes-add: ${fresh.length} added, ${lines.length - fresh.length} already recorded`);
} finally { release(); }
