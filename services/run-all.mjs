import 'dotenv/config';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { notifySummary } from './core/telegram.mjs';

const FEED_DELAY_MS = Number(process.env.FEED_DELAY_MS || 15_000);
const REGISTRY_PATH = process.env.REGISTRY_PATH || 'services/registry.json';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function loadRegistry() {
  const raw = fs.readFileSync(REGISTRY_PATH, 'utf8');
  return JSON.parse(raw);
}

function readResult(name) {
  const file = path.join(os.tmpdir(), `feed-result-${name}.json`);
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    try { fs.unlinkSync(file); } catch {}
    return data;
  } catch {
    return null;
  }
}

function parseArgs() {
  const args = process.argv.slice(2);
  const result = { dryRun: false, names: [] };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--dry-run') result.dryRun = true;
    else if (args[i] === '--name' && args[i + 1]) result.names.push(args[++i]);
  }
  return result;
}

async function runFeed(entry) {
  const start = Date.now();
  const runner =
    entry.runner === 'normalize'
      ? 'services/run-normalize-sheet.mjs'
      : 'services/run-service.mjs';

  return new Promise((resolve) => {
    const proc = spawn('node', [runner, entry.config], {
      stdio: 'inherit',
      env: process.env,
    });

    proc.on('close', (code) => {
      const duration = Date.now() - start;
      const stored = readResult(entry.name) || {};
      resolve({
        name: entry.name,
        ok: code === 0,
        duration,
        rows: stored.rows ?? null,
        error: code !== 0 ? (stored.error || `exit code ${code}`) : null,
      });
    });
  });
}

async function main() {
  const { dryRun, names } = parseArgs();
  const registry = loadRegistry();

  let feeds = registry.filter((e) => e.enabled !== false);
  if (names.length > 0) {
    feeds = feeds.filter((e) => names.includes(e.name));
    if (feeds.length === 0) {
      console.error(`[run-all] No feeds found for: ${names.join(', ')}`);
      process.exit(1);
    }
  }

  if (dryRun) {
    console.log(`[run-all] Dry run — would execute ${feeds.length} feeds:`);
    feeds.forEach((f, i) => console.log(`  ${i + 1}. ${f.name}  (${f.config})`));
    return;
  }

  console.log(`[run-all] Starting ${feeds.length} feeds, delay between feeds: ${FEED_DELAY_MS}ms`);
  const runStart = Date.now();
  const results = [];

  for (let i = 0; i < feeds.length; i++) {
    const entry = feeds[i];
    console.log(`\n[run-all] [${i + 1}/${feeds.length}] ${entry.name}`);
    const result = await runFeed(entry);
    results.push(result);

    const status = result.ok ? 'OK' : 'FAILED';
    const rows = result.rows != null ? ` (${result.rows} rows)` : '';
    console.log(`[run-all] → ${status} in ${(result.duration / 1000).toFixed(1)}s${rows}`);

    if (i < feeds.length - 1) {
      await sleep(FEED_DELAY_MS);
    }
  }

  const totalSec = ((Date.now() - runStart) / 1000).toFixed(0);
  const failed = results.filter((r) => !r.ok).length;
  console.log(
    `\n[run-all] Finished in ${totalSec}s — ${results.length - failed}/${results.length} OK`
  );

  if (failed > 0) {
    await notifySummary(results);
  }

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('[run-all] Fatal:', err.message);
  process.exit(1);
});
