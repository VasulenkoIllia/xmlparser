import 'dotenv/config';
import fs from 'fs';
import {
  writeResult, withRetry, deepResolve,
  acquireLock, releaseLock, createSheetsClient, getSpreadsheet,
  ensureSheetWithRename, resizeSheet, clearSheet, writeSheet, upsertMeta, nowStrings,
} from './core/sheets.mjs';
import { notifyError } from './core/telegram.mjs';
import { normalizeRows } from '../scripts/normalize-core.mjs';

// ─── Config ───────────────────────────────────────────────────────────────────

function loadConfig(configPath) {
  if (!configPath) throw new Error('Pass config path: node services/run-normalize-sheet.mjs services/rabona.json');
  const cfg = deepResolve(JSON.parse(fs.readFileSync(configPath, 'utf8')));
  for (const key of ['sourceSheetId', 'targetSheetId']) {
    if (!cfg[key]) throw new Error(`Config missing: ${key}`);
  }
  cfg.chunkRows    = Number(cfg.chunkRows    || process.env.CHUNK_ROWS    || 1500);
  cfg.writeRetries = Number(cfg.writeRetries || process.env.WRITE_RETRIES || 3);
  cfg.retryDelayMs = Number(cfg.retryDelayMs || process.env.RETRY_DELAY_MS || 2000);
  return cfg;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  let lockPath = null;
  let cfg = null;
  const startTime = Date.now();

  try {
    cfg = loadConfig(process.argv[2]);
    const feedId = cfg.name || 'rabona';
    lockPath = acquireLock(`normalize-${feedId}`);

    const sheets = createSheetsClient();
    const r = cfg.writeRetries;
    const d = cfg.retryDelayMs;

    const sourceSheetName =
      cfg.sourceSheetName ||
      (await getSpreadsheet(sheets, cfg.sourceSheetId, r, d)).data.sheets?.[0]?.properties?.title;
    if (!sourceSheetName) throw new Error('Source spreadsheet has no sheets.');

    let targetSheetName = cfg.targetSheetName ?? null;
    if (!targetSheetName) {
      targetSheetName = cfg.targetSheetId === cfg.sourceSheetId
        ? `${sourceSheetName}_normalized`
        : (await getSpreadsheet(sheets, cfg.targetSheetId, r, d)).data.sheets?.[0]?.properties?.title;
    }
    if (!targetSheetName) throw new Error('Target spreadsheet has no sheets.');

    const response = await withRetry('read source sheet', () => sheets.spreadsheets.values.get({
      spreadsheetId: cfg.sourceSheetId,
      range: `${sourceSheetName}!A:ZZ`,
      majorDimension: 'ROWS',
      valueRenderOption: 'FORMATTED_VALUE',
    }), r, d);

    const inputRows = response.data.values || [];
    if (!inputRows.length) throw new Error(`No data in ${sourceSheetName}`);

    const outputRows = normalizeRows(inputRows);
    const targetSheet = await ensureSheetWithRename(sheets, cfg.targetSheetId, targetSheetName, r, d, Boolean(cfg.targetSheetName));
    await resizeSheet(sheets, cfg.targetSheetId, targetSheet, outputRows.length + 10, outputRows[0].length + 5, r, d);
    await clearSheet(sheets, cfg.targetSheetId, targetSheetName, r, d);
    await writeSheet(sheets, cfg.targetSheetId, targetSheetName, outputRows, cfg.chunkRows, r, d);

    const { dateStr, timeStr } = nowStrings();
    const metaName = cfg.metaSheetName || `${targetSheetName}_meta`;
    await upsertMeta(sheets, cfg.targetSheetId, metaName, r, d, dateStr, timeStr, outputRows.length - 1);

    const rowCount = outputRows.length - 1;
    writeResult(feedId, { ok: true, rows: rowCount, duration: Date.now() - startTime });
    console.log(`Normalize ${feedId}: wrote ${rowCount} rows to "${targetSheetName}".`);
  } catch (err) {
    const feedId = cfg?.name || process.argv[2] || 'normalize';
    console.error('Normalize failed:', err.message);
    if (err.response) {
      console.error('Response status:', err.response.status);
      console.error('Response data:', JSON.stringify(err.response.data, null, 2));
    }
    if (err.errors) console.error('Errors:', err.errors);
    writeResult(feedId, { ok: false, error: err.message, duration: Date.now() - startTime });
    await notifyError(feedId, err);
    process.exit(1);
  } finally {
    releaseLock(lockPath);
  }
}

main();
