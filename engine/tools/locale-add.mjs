#!/usr/bin/env node
// Merge translation keys under a shared lock. Run: node <hub>/tools/locale-add.mjs <keys.json> [--force].
import fs from 'node:fs';
import path from 'node:path';
import { CFG, ROOT, projectPath, help, lock } from './runtime.mjs';

help('usage: locale-add.mjs <keys.json> [--force]; config.locales = { path: "locales", languages: ["en"] }');
const [input, ...flags] = process.argv.slice(2);
if (!input) throw new Error('usage: locale-add.mjs <keys.json> [--force]');
const languages = CFG.locales?.languages ?? ['en'];
if (!languages.length || languages.some((l) => !/^[a-zA-Z0-9_-]+$/.test(l))) throw new Error('invalid configured languages');
const entries = JSON.parse(fs.readFileSync(path.resolve(ROOT, input), 'utf8'));
if (!entries || Array.isArray(entries) || typeof entries !== 'object') throw new Error('keys must be an object');
const release = lock('locale');
try {
  let written = 0, same = 0;
  const pending = [];
  for (const lang of languages) {
    const file = projectPath(path.join(CFG.locales?.path ?? 'locales', `${lang}.json`));
    const raw = fs.readFileSync(file, 'utf8');
    const data = JSON.parse(raw);
    const eol = raw.includes('\r\n') ? '\r\n' : '\n';
    const indent = raw.match(/\n([\t ]+)"/)?.[1] ?? '  ';
    for (const [key, texts] of Object.entries(entries)) {
      const parts = key.split('.');
      if (parts.some((p) => !p || ['__proto__', 'constructor', 'prototype'].includes(p))) throw new Error(`unsafe key: ${key}`);
      const value = texts?.[lang];
      if (typeof value !== 'string' || !value.trim()) throw new Error(`${key}: missing "${lang}" text`);
      let node = data;
      for (const p of parts.slice(0, -1)) {
        if (Object.hasOwn(node, p) && (!node[p] || typeof node[p] !== 'object' || Array.isArray(node[p]))) throw new Error(`${key}: ${p} is not a namespace`);
        if (!Object.hasOwn(node, p)) node[p] = {};
        node = node[p];
      }
      const leaf = parts.at(-1);
      if (Object.hasOwn(node, leaf) && node[leaf] === value) { same++; continue; }
      if (Object.hasOwn(node, leaf) && !flags.includes('--force')) throw new Error(`${lang}:${key} already has different text; use --force to replace`);
      node[leaf] = value; written++;
    }
    pending.push([file, JSON.stringify(data, null, indent).replace(/\n/g, eol) + (raw.endsWith('\n') ? eol : '')]);
  }
  // Validate every language before writing any: a conflict cannot leave partial translations.
  for (const [file, text] of pending) fs.writeFileSync(file, text);
  console.log(`locale-add: ${written} written, ${same} unchanged`);
} finally { release(); }
