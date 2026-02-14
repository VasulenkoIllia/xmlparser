import 'dotenv/config';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { google } from 'googleapis';
import { normalizeRows } from '../scripts/normalize-core.mjs';

const TZ = process.env.TZ || 'UTC';
const LOCK_TTL_HOURS = Number(process.env.LOCK_TTL_HOURS || 12);
const LOCK_TTL_MS = LOCK_TTL_HOURS * 60 * 60 * 1000;

function resolveEnv(value) {
  if (typeof value === 'string' && /^\$[A-Z0-9_]+$/.test(value)) {
    const envVal = process.env[value.slice(1)];
    if (!envVal) throw new Error(`Env var ${value} is not set`);
    return envVal;
  }
  return value;
}

function deepResolve(obj) {
  if (Array.isArray(obj)) return obj.map(deepResolve);
  if (obj && typeof obj === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(obj)) out[k] = deepResolve(v);
    return out;
  }
  return resolveEnv(obj);
}

function loadConfig(configPath) {
  if (!configPath) {
    throw new Error('Pass config path: node services/run-normalize-sheet.mjs services/normalize_sheet.json');
  }
  const raw = fs.readFileSync(configPath, 'utf8');
  const cfg = deepResolve(JSON.parse(raw));
  const required = ['sourceSheetId', 'targetSheetId'];
  for (const key of required) if (!cfg[key]) throw new Error(`Config missing ${key}`);
  cfg.chunkRows = Number(cfg.chunkRows || process.env.CHUNK_ROWS || 1500);
  cfg.writeRetries = Number(cfg.writeRetries || process.env.WRITE_RETRIES || 3);
  cfg.retryDelayMs = Number(cfg.retryDelayMs || process.env.RETRY_DELAY_MS || 2000);
  return cfg;
}

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

async function withRetry(label, fn, attempts, baseDelayMs) {
  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const delay = baseDelayMs * Math.pow(2, i - 1);
      console.warn(`${label} failed (attempt ${i}/${attempts}): ${err.message}. Retry in ${delay}ms`);
      if (i < attempts) await sleep(delay);
    }
  }
  throw lastErr;
}

function colLetter(n) {
  let s = '';
  while (n) {
    n -= 1;
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26);
  }
  return s;
}

function isPidAlive(pid) {
  if (!pid || Number.isNaN(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return false;
  }
}

function parseLockFile(content) {
  if (!content) return { pid: null, ts: null };
  const parts = String(content).trim().split(/\s+/);
  const pid = Number(parts[0]);
  const ts = parts[1] ? Number(parts[1]) : null;
  return {
    pid: Number.isFinite(pid) ? pid : null,
    ts: Number.isFinite(ts) ? ts : null,
  };
}

function isStaleLock(lockPath, content) {
  const now = Date.now();
  const { ts } = parseLockFile(content);
  if (ts && now - ts > LOCK_TTL_MS) return true;
  try {
    const stat = fs.statSync(lockPath);
    return now - stat.mtimeMs > LOCK_TTL_MS;
  } catch (err) {
    return false;
  }
}

async function getSpreadsheet(sheets, spreadsheetId, retries, delayMs) {
  return withRetry('get spreadsheet', () => sheets.spreadsheets.get({ spreadsheetId }), retries, delayMs);
}

async function getFirstSheetTitle(sheets, spreadsheetId, retries, delayMs) {
  const doc = await getSpreadsheet(sheets, spreadsheetId, retries, delayMs);
  return doc.data.sheets?.[0]?.properties?.title || null;
}

async function ensureSheet(sheets, spreadsheetId, title, retries, delayMs, renameIfSingle = false) {
  const doc = await getSpreadsheet(sheets, spreadsheetId, retries, delayMs);
  const sheet = doc.data.sheets?.find((s) => s.properties?.title === title);
  if (sheet) return sheet;

  const onlySheet = doc.data.sheets?.length === 1 ? doc.data.sheets[0] : null;
  if (renameIfSingle && onlySheet?.properties?.sheetId) {
    await withRetry(
      'rename sheet',
      () =>
        sheets.spreadsheets.batchUpdate({
          spreadsheetId,
          requestBody: {
            requests: [
              {
                updateSheetProperties: {
                  properties: { sheetId: onlySheet.properties.sheetId, title },
                  fields: 'title',
                },
              },
            ],
          },
        }),
      retries,
      delayMs
    );
    const refreshed = await getSpreadsheet(sheets, spreadsheetId, retries, delayMs);
    return refreshed.data.sheets?.find((s) => s.properties?.title === title);
  }

  await withRetry(
    'add sheet',
    () =>
      sheets.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: { requests: [{ addSheet: { properties: { title } } }] },
      }),
    retries,
    delayMs
  );
  const refreshed = await getSpreadsheet(sheets, spreadsheetId, retries, delayMs);
  return refreshed.data.sheets?.find((s) => s.properties?.title === title);
}

async function resizeSheet(sheets, spreadsheetId, sheetObj, neededRows, neededCols, retries, delayMs) {
  if (!sheetObj) return;
  const { sheetId, gridProperties = {} } = sheetObj.properties || {};
  const currentRows = gridProperties.rowCount || 0;
  const currentCols = gridProperties.columnCount || 0;
  if (neededRows <= currentRows && neededCols <= currentCols) return;
  await withRetry(
    'resize sheet',
    () =>
      sheets.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: {
          requests: [
            {
              updateSheetProperties: {
                properties: {
                  sheetId,
                  gridProperties: {
                    rowCount: Math.max(currentRows, neededRows),
                    columnCount: Math.max(currentCols, neededCols),
                  },
                },
                fields: 'gridProperties(rowCount,columnCount)',
              },
            },
          ],
        },
      }),
    retries,
    delayMs
  );
}

async function clearSheet(sheets, spreadsheetId, sheetName, retries, delayMs) {
  await withRetry(
    'clear sheet',
    () => sheets.spreadsheets.values.clear({ spreadsheetId, range: `${sheetName}!A:ZZ` }),
    retries,
    delayMs
  );
}

async function writeSheet(sheets, spreadsheetId, sheetName, rows, chunkRows, retries, retryDelayMs) {
  const colCount = rows[0].length;
  let startRow = 1;
  for (let i = 0; i < rows.length; i += chunkRows) {
    const part = rows.slice(i, i + chunkRows);
    const endRow = startRow + part.length - 1;
    const range = `${sheetName}!A${startRow}:${colLetter(colCount)}${endRow}`;
    await withRetry(
      `write chunk ${i / chunkRows + 1}`,
      () =>
        sheets.spreadsheets.values.update({
          spreadsheetId,
          range,
          valueInputOption: 'USER_ENTERED',
          requestBody: { values: part },
        }),
      retries,
      retryDelayMs
    );
    startRow = endRow + 1;
  }
}

async function upsertMeta(sheets, cfg, spreadsheetId, sheetName, dateStr, timeStr, rowCount) {
  const metaName = cfg.metaSheetName || `${sheetName}_meta`;
  const metaProps = await ensureSheet(
    sheets,
    spreadsheetId,
    metaName,
    cfg.writeRetries,
    cfg.retryDelayMs
  );
  await resizeSheet(sheets, spreadsheetId, metaProps, 2, 6, cfg.writeRetries, cfg.retryDelayMs);
  const values = [['last_update_date', dateStr, 'last_update_time', timeStr, 'rows', rowCount]];
  await withRetry(
    'write meta',
    () =>
      sheets.spreadsheets.values.update({
        spreadsheetId,
        range: `${metaName}!A1:F1`,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values },
      }),
    cfg.writeRetries,
    cfg.retryDelayMs
  );

  const sheetId = metaProps?.properties?.sheetId;
  const rulesToDelete = (metaProps?.conditionalFormats || []).length || 0;
  const deleteRequests = [];
  for (let i = rulesToDelete - 1; i >= 0; i--) {
    deleteRequests.push({ deleteConditionalFormatRule: { sheetId, index: i } });
  }

  const range = {
    sheetId,
    startRowIndex: 0,
    endRowIndex: 1,
    startColumnIndex: 1,
    endColumnIndex: 2,
  };
  const greenRule = {
    addConditionalFormatRule: {
      index: 0,
      rule: {
        ranges: [range],
        booleanRule: {
          condition: {
            type: 'CUSTOM_FORMULA',
            values: [{ userEnteredValue: '=INT($B$1)=TODAY()' }],
          },
          format: { backgroundColor: { red: 0.8, green: 1, blue: 0.8 } },
        },
      },
    },
  };
  const redRule = {
    addConditionalFormatRule: {
      index: 0,
      rule: {
        ranges: [range],
        booleanRule: {
          condition: {
            type: 'CUSTOM_FORMULA',
            values: [{ userEnteredValue: '=INT($B$1)<>TODAY()' }],
          },
          format: { backgroundColor: { red: 1, green: 0.8, blue: 0.8 } },
        },
      },
    },
  };

  const requests = [...deleteRequests, greenRule, redRule];
  if (requests.length) {
    await withRetry(
      'meta formatting',
      () => sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests } }),
      cfg.writeRetries,
      cfg.retryDelayMs
    );
  }
}

async function main() {
  let lockPath = null;
  try {
    const configPath = process.argv[2];
    const cfg = loadConfig(configPath);

    const lockName = `normalize-lock-${cfg.name || cfg.targetSheetName || cfg.targetSheetId}.lock`;
    lockPath = path.join(os.tmpdir(), lockName);
    try {
      const fd = fs.openSync(lockPath, 'wx');
      fs.writeSync(fd, `${process.pid} ${Date.now()}`);
      fs.closeSync(fd);
    } catch (e) {
      let existing = null;
      try {
        existing = fs.readFileSync(lockPath, 'utf8');
      } catch (readErr) {
        existing = null;
      }

      const { pid } = parseLockFile(existing);
      if (pid && isPidAlive(pid)) {
        console.error(
          `Another run is in progress for ${cfg.name || cfg.targetSheetId} (pid ${pid}, lock ${lockPath}). Exit.`
        );
        process.exit(1);
      }

      if (isStaleLock(lockPath, existing)) {
        try {
          fs.unlinkSync(lockPath);
        } catch (unlinkErr) {
          console.error(`Lock appears stale but failed to remove ${lockPath}: ${unlinkErr.message}`);
          process.exit(1);
        }

        const fd = fs.openSync(lockPath, 'wx');
        fs.writeSync(fd, `${process.pid} ${Date.now()}`);
        fs.closeSync(fd);
      } else {
        console.error(`Another run is in progress for ${cfg.name || cfg.targetSheetId} (lock ${lockPath}). Exit.`);
        process.exit(1);
      }
    }

    const rawKey = process.env.GOOGLE_PRIVATE_KEY || '';
    const privateKey = rawKey.replace(/\\n/g, '\n');
    if (!process.env.GOOGLE_CLIENT_EMAIL || !privateKey) {
      throw new Error('Missing GOOGLE_CLIENT_EMAIL or GOOGLE_PRIVATE_KEY in env');
    }

    const auth = new google.auth.JWT({
      email: process.env.GOOGLE_CLIENT_EMAIL,
      key: privateKey,
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
      keyId: process.env.GOOGLE_PRIVATE_KEY_ID,
    });
    const sheets = google.sheets({ version: 'v4', auth });

    const sourceSheetName =
      cfg.sourceSheetName ||
      (await getFirstSheetTitle(sheets, cfg.sourceSheetId, cfg.writeRetries, cfg.retryDelayMs));
    if (!sourceSheetName) throw new Error('Source spreadsheet has no sheets.');

    let targetSheetName = cfg.targetSheetName || null;
    if (!targetSheetName) {
      if (cfg.targetSheetId === cfg.sourceSheetId) {
        targetSheetName = `${sourceSheetName}_normalized`;
      } else {
        targetSheetName = await getFirstSheetTitle(
          sheets,
          cfg.targetSheetId,
          cfg.writeRetries,
          cfg.retryDelayMs
        );
      }
    }
    if (!targetSheetName) throw new Error('Target spreadsheet has no sheets.');

    const inputRange = `${sourceSheetName}!A:ZZ`;
    const response = await withRetry(
      'read source sheet',
      () =>
        sheets.spreadsheets.values.get({
          spreadsheetId: cfg.sourceSheetId,
          range: inputRange,
          majorDimension: 'ROWS',
          valueRenderOption: 'FORMATTED_VALUE',
        }),
      cfg.writeRetries,
      cfg.retryDelayMs
    );
    const rows = response.data.values || [];
    if (!rows.length) throw new Error(`No data found in ${inputRange}`);

    const outputRows = normalizeRows(rows);

    const targetSheet = await ensureSheet(
      sheets,
      cfg.targetSheetId,
      targetSheetName,
      cfg.writeRetries,
      cfg.retryDelayMs,
      Boolean(cfg.targetSheetName)
    );
    await resizeSheet(
      sheets,
      cfg.targetSheetId,
      targetSheet,
      outputRows.length + 10,
      outputRows[0].length + 5,
      cfg.writeRetries,
      cfg.retryDelayMs
    );
    await clearSheet(sheets, cfg.targetSheetId, targetSheetName, cfg.writeRetries, cfg.retryDelayMs);
    await writeSheet(
      sheets,
      cfg.targetSheetId,
      targetSheetName,
      outputRows,
      cfg.chunkRows,
      cfg.writeRetries,
      cfg.retryDelayMs
    );

    const now = new Date();
    const dateStr = new Intl.DateTimeFormat('sv-SE', { timeZone: TZ }).format(now);
    const timeStr = new Intl.DateTimeFormat('en-GB', {
      timeZone: TZ,
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).format(now);
    await upsertMeta(sheets, cfg, cfg.targetSheetId, targetSheetName, dateStr, timeStr, outputRows.length - 1);

    console.log(
      `Normalize sheet: wrote ${outputRows.length - 1} rows to "${targetSheetName}" (${cfg.targetSheetId}).`
    );
  } catch (err) {
    console.error('Normalize failed:', err.message);
    if (err.response) {
      console.error('Response status:', err.response.status);
      console.error('Response data:', JSON.stringify(err.response.data, null, 2));
    }
    if (err.errors) console.error('Errors:', err.errors);
    process.exit(1);
  } finally {
    if (lockPath) {
      try {
        fs.unlinkSync(lockPath);
      } catch (e) {}
    }
  }
}

main();
