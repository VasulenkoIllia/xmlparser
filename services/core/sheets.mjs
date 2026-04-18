import 'dotenv/config';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { google } from 'googleapis';

const TZ = process.env.TZ || 'UTC';
const LOCK_TTL_MS = Number(process.env.LOCK_TTL_HOURS || 12) * 60 * 60 * 1000;

// ─── Utilities ────────────────────────────────────────────────────────────────

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function writeResult(name, data) {
  try {
    fs.writeFileSync(path.join(os.tmpdir(), `feed-result-${name}.json`), JSON.stringify(data));
  } catch {}
}

export async function withRetry(label, fn, attempts, baseDelayMs) {
  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const delay = baseDelayMs * Math.pow(2, i - 1) + Math.floor(Math.random() * 500);
      console.warn(`${label} failed (attempt ${i}/${attempts}): ${err.message}. Retry in ${delay}ms`);
      if (i < attempts) await sleep(delay);
    }
  }
  throw lastErr;
}

export function colLetter(n) {
  let s = '';
  while (n) { n -= 1; s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26); }
  return s;
}

export function resolveEnv(value) {
  if (typeof value === 'string' && /^\$[A-Z0-9_]+$/.test(value)) {
    const v = process.env[value.slice(1)];
    if (!v) throw new Error(`Env var ${value} is not set`);
    return v;
  }
  return value;
}

export function deepResolve(obj) {
  if (Array.isArray(obj)) return obj.map(deepResolve);
  if (obj && typeof obj === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(obj)) out[k] = deepResolve(v);
    return out;
  }
  return resolveEnv(obj);
}

export function nowStrings() {
  const now = new Date();
  return {
    dateStr: new Intl.DateTimeFormat('sv-SE', { timeZone: TZ }).format(now),
    timeStr: new Intl.DateTimeFormat('en-GB', {
      timeZone: TZ, hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).format(now),
  };
}

// ─── Lock ─────────────────────────────────────────────────────────────────────

function isPidAlive(pid) {
  if (!pid || Number.isNaN(pid)) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function parseLockFile(content) {
  if (!content) return { pid: null, ts: null };
  const [rawPid, rawTs] = String(content).trim().split(/\s+/);
  const pid = Number(rawPid);
  const ts = rawTs ? Number(rawTs) : null;
  return {
    pid: Number.isFinite(pid) ? pid : null,
    ts: Number.isFinite(ts) ? ts : null,
  };
}

function isStaleLock(lockPath, content) {
  const now = Date.now();
  const { ts } = parseLockFile(content);
  if (ts && now - ts > LOCK_TTL_MS) return true;
  try { return now - fs.statSync(lockPath).mtimeMs > LOCK_TTL_MS; } catch { return false; }
}

export function acquireLock(name) {
  const lockPath = path.join(os.tmpdir(), `feed-lock-${name}.lock`);
  try {
    const fd = fs.openSync(lockPath, 'wx');
    fs.writeSync(fd, `${process.pid} ${Date.now()}`);
    fs.closeSync(fd);
    return lockPath;
  } catch {
    let existing = null;
    try { existing = fs.readFileSync(lockPath, 'utf8'); } catch {}

    const { pid } = parseLockFile(existing);
    const alive = pid ? isPidAlive(pid) : false;

    if (pid && alive) {
      throw new Error(`Another run is in progress for ${name} (pid ${pid}). Skipping.`);
    }
    if ((pid && !alive) || isStaleLock(lockPath, existing)) {
      fs.unlinkSync(lockPath);
      const fd = fs.openSync(lockPath, 'wx');
      fs.writeSync(fd, `${process.pid} ${Date.now()}`);
      fs.closeSync(fd);
      return lockPath;
    }
    throw new Error(`Lock exists for ${name} and appears active.`);
  }
}

export function releaseLock(lockPath) {
  if (!lockPath) return;
  try { fs.unlinkSync(lockPath); } catch {}
}

// ─── Google Sheets client ─────────────────────────────────────────────────────

export function createSheetsClient() {
  const privateKey = (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n');
  if (!process.env.GOOGLE_CLIENT_EMAIL || !privateKey) {
    throw new Error('Missing GOOGLE_CLIENT_EMAIL or GOOGLE_PRIVATE_KEY in env');
  }
  const auth = new google.auth.JWT({
    email: process.env.GOOGLE_CLIENT_EMAIL,
    key: privateKey,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    keyId: process.env.GOOGLE_PRIVATE_KEY_ID,
  });
  return google.sheets({ version: 'v4', auth });
}

// ─── Sheet operations ─────────────────────────────────────────────────────────

export async function getSpreadsheet(sheets, spreadsheetId, retries, delayMs) {
  return withRetry('get spreadsheet', () => sheets.spreadsheets.get({ spreadsheetId }), retries, delayMs);
}

export async function ensureSheet(sheets, spreadsheetId, title, retries, delayMs) {
  const doc = await getSpreadsheet(sheets, spreadsheetId, retries, delayMs);
  const existing = doc.data.sheets?.find((s) => s.properties?.title === title);
  if (existing) return existing;

  await withRetry('add sheet', () => sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: { requests: [{ addSheet: { properties: { title } } }] },
  }), retries, delayMs);

  const refreshed = await getSpreadsheet(sheets, spreadsheetId, retries, delayMs);
  return refreshed.data.sheets?.find((s) => s.properties?.title === title);
}

export async function ensureSheetWithRename(sheets, spreadsheetId, title, retries, delayMs, renameIfSingle = false) {
  const doc = await getSpreadsheet(sheets, spreadsheetId, retries, delayMs);
  const existing = doc.data.sheets?.find((s) => s.properties?.title === title);
  if (existing) return existing;

  const onlySheet = doc.data.sheets?.length === 1 ? doc.data.sheets[0] : null;
  if (renameIfSingle && onlySheet?.properties?.sheetId) {
    await withRetry('rename sheet', () => sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests: [{ updateSheetProperties: { properties: { sheetId: onlySheet.properties.sheetId, title }, fields: 'title' } }] },
    }), retries, delayMs);
    const refreshed = await getSpreadsheet(sheets, spreadsheetId, retries, delayMs);
    return refreshed.data.sheets?.find((s) => s.properties?.title === title);
  }

  await withRetry('add sheet', () => sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: { requests: [{ addSheet: { properties: { title } } }] },
  }), retries, delayMs);
  const refreshed = await getSpreadsheet(sheets, spreadsheetId, retries, delayMs);
  return refreshed.data.sheets?.find((s) => s.properties?.title === title);
}

export async function resizeSheet(sheets, spreadsheetId, sheetObj, neededRows, neededCols, retries, delayMs) {
  if (!sheetObj) return;
  const { sheetId, gridProperties = {} } = sheetObj.properties || {};
  const currentRows = gridProperties.rowCount || 0;
  const currentCols = gridProperties.columnCount || 0;
  if (neededRows <= currentRows && neededCols <= currentCols) return;
  await withRetry('resize sheet', () => sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: { requests: [{ updateSheetProperties: { properties: { sheetId, gridProperties: { rowCount: Math.max(currentRows, neededRows), columnCount: Math.max(currentCols, neededCols) } }, fields: 'gridProperties(rowCount,columnCount)' } }] },
  }), retries, delayMs);
}

export async function clearSheet(sheets, spreadsheetId, sheetName, retries, delayMs) {
  await withRetry('clear sheet', () => sheets.spreadsheets.values.clear({
    spreadsheetId, range: `${sheetName}!A:ZZ`,
  }), retries, delayMs);
}

export async function writeSheet(sheets, spreadsheetId, sheetName, rows, chunkRows, retries, delayMs) {
  const colCount = rows[0].length;
  let startRow = 1;
  for (let i = 0; i < rows.length; i += chunkRows) {
    const part = rows.slice(i, i + chunkRows);
    const endRow = startRow + part.length - 1;
    await withRetry(`write chunk ${i / chunkRows + 1}`, () => sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${sheetName}!A${startRow}:${colLetter(colCount)}${endRow}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: part },
    }), retries, delayMs);
    startRow = endRow + 1;
  }
}

export async function upsertMeta(sheets, spreadsheetId, metaSheetName, retries, delayMs, dateStr, timeStr, rowCount) {
  const metaProps = await ensureSheet(sheets, spreadsheetId, metaSheetName, retries, delayMs);
  await resizeSheet(sheets, spreadsheetId, metaProps, 2, 6, retries, delayMs);
  await withRetry('write meta', () => sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${metaSheetName}!A1:F1`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [['last_update_date', dateStr, 'last_update_time', timeStr, 'rows', rowCount]] },
  }), retries, delayMs);

  const sheetId = metaProps?.properties?.sheetId;
  const rulesToDelete = (metaProps?.conditionalFormats || []).length || 0;
  const deleteRequests = Array.from({ length: rulesToDelete }, (_, i) => ({
    deleteConditionalFormatRule: { sheetId, index: rulesToDelete - 1 - i },
  }));
  const range = { sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 1, endColumnIndex: 2 };
  const formatRequests = [
    { addConditionalFormatRule: { index: 0, rule: { ranges: [range], booleanRule: { condition: { type: 'CUSTOM_FORMULA', values: [{ userEnteredValue: '=INT($B$1)=TODAY()' }] }, format: { backgroundColor: { red: 0.8, green: 1, blue: 0.8 } } } } } },
    { addConditionalFormatRule: { index: 0, rule: { ranges: [range], booleanRule: { condition: { type: 'CUSTOM_FORMULA', values: [{ userEnteredValue: '=INT($B$1)<>TODAY()' }] }, format: { backgroundColor: { red: 1, green: 0.8, blue: 0.8 } } } } } },
  ];
  const requests = [...deleteRequests, ...formatRequests];
  if (requests.length) {
    await withRetry('meta formatting', () => sheets.spreadsheets.batchUpdate({
      spreadsheetId, requestBody: { requests },
    }), retries, delayMs);
  }
}
