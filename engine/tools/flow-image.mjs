#!/usr/bin/env node
/**
 * flow-image.mjs — Terminal wrapper for Google Flow image generation via flow-mcp.
 *
 * Usage:
 *   node flow-image.mjs --prompt "..." [--ref path.webp] [--aspect 1:1|4:3|3:4|16:9] [--count n] --out <dir>
 *
 * Flags:
 *   --prompt <text>      Prompt describing the image to generate (required)
 *   --ref <path>         Optional path to a reference image (e.g. webp, png, jpeg)
 *   --aspect <ratio>     Aspect ratio: 1:1, 4:3, 3:4, 16:9 (default: 1:1)
 *   --count <n>          Number of images to generate (default: 1)
 *   --out <dir>          Target directory for downloaded images (required)
 *   --delay <ms>         Pause in milliseconds between successive generations (default: 5000)
 *   --model <name>       Image model name (default: "latest")
 *   --status             Check Flow authentication and project status and exit
 *   -h, --help           Show this help message and exit
 */

import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, appendFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FLOW_MCP_DIR = process.env.FLOW_MCP_DIR || 'C:/Users/OMEN/tools/flow-mcp';
const FLOW_MCP_SERVER = path.join(FLOW_MCP_DIR, 'dist', 'index.js');
const FLOW_MCP_HOME = process.env.FLOW_MCP_HOME || path.join(FLOW_MCP_DIR, 'data');
const FLOW_MCP_OUTPUT = process.env.FLOW_MCP_OUTPUT || path.join(FLOW_MCP_DIR, 'output');

function printHelp() {
  console.log(`
Google Flow Terminal Image Generator (flow-image.mjs)

Usage:
  node flow-image.mjs --prompt "..." [options] --out <dir>

Options:
  --prompt <string>     Image generation prompt in English (required)
  --ref <path>          Path to reference image (e.g. .webp, .png, .jpg)
  --aspect <ratio>      Aspect ratio: 1:1, 4:3, 3:4, 16:9 (default: 1:1)
  --count <n>           Number of images to generate (default: 1)
  --out <dir>           Directory to save images and SOURCES.md (required)
  --delay <ms>          Delay between generations in milliseconds (default: 5000)
  --model <name>        Model name (default: "latest")
  --status              Check connection and login status only
  -h, --help            Show this help text

Examples:
  node flow-image.mjs --status
  node flow-image.mjs --prompt "Minimalist ergonomic wheelchair in warm studio lighting" --aspect 1:1 --out ./output
  node flow-image.mjs --prompt "Modern hospital room with morning light" --ref ./reference.webp --aspect 16:9 --count 2 --out ./renders
`);
}

function parseArgs(argv) {
  const args = {
    aspect: '1:1',
    count: 1,
    delay: 5000,
    model: 'latest',
  };

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') {
      args.help = true;
    } else if (arg === '--status') {
      args.statusOnly = true;
    } else if (arg === '--prompt') {
      args.prompt = argv[++i];
    } else if (arg.startsWith('--prompt=')) {
      args.prompt = arg.slice('--prompt='.length);
    } else if (arg === '--ref') {
      args.ref = argv[++i];
    } else if (arg.startsWith('--ref=')) {
      args.ref = arg.slice('--ref='.length);
    } else if (arg === '--aspect') {
      args.aspect = argv[++i];
    } else if (arg.startsWith('--aspect=')) {
      args.aspect = arg.slice('--aspect='.length);
    } else if (arg === '--count') {
      args.count = parseInt(argv[++i], 10);
    } else if (arg.startsWith('--count=')) {
      args.count = parseInt(arg.slice('--count='.length), 10);
    } else if (arg === '--out') {
      args.out = argv[++i];
    } else if (arg.startsWith('--out=')) {
      args.out = arg.slice('--out='.length);
    } else if (arg === '--delay') {
      args.delay = parseInt(argv[++i], 10);
    } else if (arg.startsWith('--delay=')) {
      args.delay = parseInt(arg.slice('--delay='.length), 10);
    } else if (arg === '--model') {
      args.model = argv[++i];
    } else if (arg.startsWith('--model=')) {
      args.model = arg.slice('--model='.length);
    } else {
      console.error(`Unknown argument: ${arg}`);
      process.exit(1);
    }
  }

  return args;
}

class McpClient {
  constructor(serverScript, env = {}) {
    this.serverScript = serverScript;
    this.env = env;
    this.child = null;
    this.msgId = 1;
    this.pending = new Map();
    this.buffer = '';
  }

  async start() {
    if (!existsSync(this.serverScript)) {
      throw new Error(`MCP server not found at: ${this.serverScript}. Run build in flow-mcp first.`);
    }

    this.child = spawn('node', [this.serverScript], {
      env: { ...process.env, ...this.env },
      stdio: ['pipe', 'pipe', 'inherit'],
    });

    this.child.stdout.on('data', (chunk) => {
      this.buffer += chunk.toString();
      const lines = this.buffer.split('\n');
      this.buffer = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.id !== undefined && this.pending.has(msg.id)) {
            const { resolve, reject } = this.pending.get(msg.id);
            this.pending.delete(msg.id);
            if (msg.error) {
              reject(new Error(msg.error.message || JSON.stringify(msg.error)));
            } else {
              resolve(msg.result);
            }
          }
        } catch (err) {
          console.error('[mcp-parse-error]', err);
        }
      }
    });

    this.child.on('error', (err) => {
      console.error('[mcp-error]', err);
    });

    // Handshake
    await this.call('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'flow-image', version: '1.0.0' },
    });

    this.notify('notifications/initialized');
  }

  notify(method, params = {}) {
    if (!this.child) throw new Error('Client not started');
    const payload = JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n';
    this.child.stdin.write(payload);
  }

  call(method, params = {}) {
    if (!this.child) throw new Error('Client not started');
    const id = this.msgId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
      this.child.stdin.write(payload);
    });
  }

  async callTool(name, args = {}) {
    const res = await this.call('tools/call', { name, arguments: args });
    if (res.isError) {
      throw new Error(res.content?.[0]?.text || `Tool ${name} failed`);
    }
    const rawText = res.content?.[0]?.text;
    try {
      return JSON.parse(rawText);
    } catch {
      return rawText;
    }
  }

  stop() {
    if (this.child) {
      this.child.kill();
      this.child = null;
    }
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const args = parseArgs(process.argv);

  if (args.help) {
    printHelp();
    process.exit(0);
  }

  const client = new McpClient(FLOW_MCP_SERVER, {
    FLOW_MCP_HOME,
    FLOW_MCP_OUTPUT,
  });

  try {
    await client.start();

    // 1. Check status
    const status = await client.callTool('flow_status', { detailed: false });
    const flow = status?.flow || {};

    if (args.statusOnly) {
      console.log('Flow Status:');
      console.log(`- URL: ${flow.url || 'unknown'}`);
      console.log(`- Signed in: ${flow.signedIn ? 'YES' : 'NO'}`);
      console.log(`- In project: ${flow.inProject ? 'YES' : 'NO'}`);
      if (flow.hint) console.log(`- Hint: ${flow.hint}`);
      client.stop();
      process.exit(0);
    }

    if (!args.prompt) {
      console.error('Error: --prompt is required.');
      printHelp();
      process.exit(1);
    }

    if (!args.out) {
      console.error('Error: --out directory is required.');
      printHelp();
      process.exit(1);
    }

    const validAspects = ['1:1', '4:3', '3:4', '16:9', '9:16'];
    if (!validAspects.includes(args.aspect)) {
      console.error(`Error: Invalid aspect ratio "${args.aspect}". Must be one of: ${validAspects.join(', ')}`);
      process.exit(1);
    }

    if (args.ref && !existsSync(args.ref)) {
      console.error(`Error: Reference file not found: ${args.ref}`);
      process.exit(1);
    }

    if (!flow.signedIn) {
      console.error('\n[Error] Google Flow is not signed in.');
      console.error('Please open the dedicated Chrome profile and sign in:');
      console.error(`  FLOW_MCP_HOME="${FLOW_MCP_HOME}" node "${path.join(FLOW_MCP_DIR, 'dist', 'login.js')}"`);
      console.error('After logging in and opening a project, re-run this tool.\n');
      process.exit(2);
    }

    if (!flow.inProject) {
      console.error('\n[Error] Google Flow is signed in, but no Flow project is open.');
      console.error('Please open or create a Flow project in the Flow Chrome window, then re-run.\n');
      process.exit(2);
    }

    const outDir = path.resolve(process.cwd(), args.out);
    mkdirSync(outDir, { recursive: true });

    const refPath = args.ref ? path.resolve(process.cwd(), args.ref) : undefined;
    const count = Math.max(1, args.count || 1);

    console.log(`\nGenerating ${count} image(s)...`);
    console.log(`- Prompt: "${args.prompt}"`);
    console.log(`- Aspect: ${args.aspect}`);
    console.log(`- Model: ${args.model}`);
    if (refPath) console.log(`- Reference: ${refPath}`);
    console.log(`- Output: ${outDir}\n`);

    const sourcesFile = path.join(outDir, 'SOURCES.md');
    if (!existsSync(sourcesFile)) {
      appendFileSync(sourcesFile, '# Generated Image Sources\n\n| Date | File | Model | Aspect | Prompt |\n|---|---|---|---|---|\n');
    }

    for (let i = 0; i < count; i++) {
      if (i > 0 && args.delay > 0) {
        console.log(`Waiting ${args.delay / 1000}s before next generation to avoid hammering Flow...`);
        await sleep(args.delay);
      }

      console.log(`[${i + 1}/${count}] Submitting scene generation...`);
      const scene = {
        prompt: args.prompt,
        type: 'image',
        aspect_ratio: args.aspect,
        model: args.model === 'latest' ? undefined : args.model,
        max_credits: 0,
        reference_images: refPath ? [refPath] : undefined,
      };

      const genRes = await client.callTool('flow_generate', {
        project: 'flow-cli',
        scenes: [scene],
      });

      const jobIds = genRes?.job_ids || genRes?.jobs?.map((j) => j.id) || [];
      if (!jobIds.length) {
        console.error('Failed: No job IDs returned by flow_generate:', genRes);
        continue;
      }

      const jobId = jobIds[0];
      console.log(`Job queued (${jobId}). Waiting for generation to complete...`);

      // Poll flow_wait
      let finished = false;
      let finalJob = null;
      let attempts = 0;
      const maxAttempts = 60; // Up to ~5 minutes

      while (!finished && attempts++ < maxAttempts) {
        await sleep(4000);
        const waitRes = await client.callTool('flow_wait', {
          job_ids: [jobId],
          timeout_seconds: 30,
        });

        finished = Boolean(waitRes?.finished);
        const jobs = waitRes?.jobs || [];
        const job = jobs.find((j) => j.id === jobId) || jobs[0];
        if (job) {
          finalJob = job;
          if (job.status === 'failed') {
            throw new Error(`Generation failed: ${job.error || 'Unknown error'}`);
          }
          if (job.progress) {
            process.stdout.write(`\rProgress: ${job.progress}...   `);
          }
        }
      }

      console.log('\nGeneration completed!');

      const downloadedFiles = finalJob?.files || [];
      if (!downloadedFiles.length) {
        console.warn('Warning: Job finished but no files were recorded in job result.');
      } else {
        for (const srcFile of downloadedFiles) {
          if (existsSync(srcFile)) {
            const fileName = path.basename(srcFile);
            const destFile = path.join(outDir, fileName);
            copyFileSync(srcFile, destFile);
            console.log(`Saved: ${destFile}`);

            // Append to SOURCES.md
            const now = new Date().toISOString();
            const logLine = `| ${now.slice(0, 10)} | ${fileName} | ${args.model} | ${args.aspect} | ${args.prompt.replace(/\|/g, '\\|')} |\n`;
            appendFileSync(sourcesFile, logLine);
          } else {
            console.warn(`Generated file not found on disk at: ${srcFile}`);
          }
        }
      }
    }

    console.log('\nAll requested generations completed successfully.');
    client.stop();
  } catch (err) {
    console.error('\nExecution error:', err.message || err);
    client.stop();
    process.exit(1);
  }
}

main();
