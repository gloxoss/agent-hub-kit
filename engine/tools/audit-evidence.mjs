#!/usr/bin/env node
// Check every finding in an audit file quotes code that really exists.
//
//   node .agent-hub/tools/audit-evidence.mjs <file.md> [more.md ...]
//
// For each `### <id> · <P#> · <category>` block:
//   1. `- Evidence:` must cite `path:line` in backticks  (else BAD no evidence)
//   2. the cited file must exist under the repo root     (else BAD file not found)
//   3. the next `> quote` line must exist                (else BAD no quote)
//   4. the quote must match the cited line, or any line within 3 lines either side,
//      after trimming and collapsing whitespace          (else BAD quote not at line N)
// Duplicate ids are BAD too. Prints `OK  <id>` / `BAD <id>  <reason>` per finding, then
// `<n> findings, <m> bad`. Exit: 0 all good, 1 some bad, 2 usage or unreadable input.
import { fileURLToPath } from 'node:url';
import { help, auditPath, CFG as CONFIG, hubDir, projectPath } from './runtime.mjs';
import fs from 'node:fs';
import path from 'node:path';

help("usage: audit-evidence.mjs <file.md> [more.md ...]");

const HERE = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
const ROOT = path.resolve(HERE, '..', '..');

const collapse = (s) => s.replace(/\s+/g, ' ').trim();

// Split the file into finding blocks, each block running to the next heading or EOF.
function findingBlocks(lines) {
  const blocks = [];
  let cur = null;
  for (const line of lines) {
    if (/^###\s/.test(line)) {
      if (cur) blocks.push(cur);
      cur = { id: line.replace(/^###\s+/, '').split('·')[0].trim(), lines: [] };
    } else if (cur && /^#{1,3}\s/.test(line)) {
      blocks.push(cur);
      cur = null;
    } else if (cur) {
      cur.lines.push(line);
    }
  }
  if (cur) blocks.push(cur);
  return blocks;
}

// Check one block against the repo. Returns null when fine, else the BAD reason.
function checkBlock(block) {
  const evIdx = block.lines.findIndex((l) => /^\s*(?:[-*]\s*)?(?:\*\*)?\s*evidence\s*:/i.test(l));
  if (evIdx < 0) return 'no evidence';
  const cited = block.lines[evIdx].match(/`([^`]+):(\d+)`/);
  if (!cited) return 'no evidence';
  const [, relPath, lineNo] = cited;
  const n = Number(lineNo);

  let fileLines;
  try {
    fileLines = fs.readFileSync(projectPath(relPath), 'utf8').split(/\r?\n/);
  } catch {
    return 'file not found';
  }

  let quote = null;
  for (let i = evIdx + 1; i < block.lines.length; i++) {
    if (/^\s*>/.test(block.lines[i])) { quote = collapse(block.lines[i].replace(/^\s*>\s*/, '')); break; }
  }
  if (!quote) return 'no quote';

  const from = Math.max(1, n - 3);
  const to = Math.min(fileLines.length, n + 3);
  for (let i = from; i <= to; i++) {
    if (collapse(fileLines[i - 1]).includes(quote)) return null;
  }

  let nearest = 0;
  for (let i = 1; i <= fileLines.length; i++) {
    if (collapse(fileLines[i - 1]).includes(quote) && (!nearest || Math.abs(i - n) < Math.abs(nearest - n))) nearest = i;
  }
  return nearest ? `quote not at line ${n} (nearest at line ${nearest})` : `quote not at line ${n}`;
}

const files = process.argv.slice(2);
if (!files.length) {
  console.error('usage: audit-evidence.mjs <file.md> [more.md ...]');
  process.exit(2);
}

let totalBad = 0;
let readFailed = false;
const seen = new Set();
for (const file of files) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    console.error(`cannot read ${file}: ${e.message}`);
    readFailed = true;
    continue;
  }

  let count = 0;
  let bad = 0;
  for (const block of findingBlocks(text.split(/\r?\n/))) {
    count++;
    const dup = seen.has(block.id);
    seen.add(block.id);
    const reason = checkBlock(block) ?? (dup ? 'duplicate id' : null);
    if (reason) { bad++; console.log(`BAD ${block.id}  ${reason}`); }
    else console.log(`OK  ${block.id}`);
  }
  totalBad += bad;
  console.log(`${count} findings, ${bad} bad`);
}

process.exitCode = readFailed ? 2 : totalBad ? 1 : 0;
