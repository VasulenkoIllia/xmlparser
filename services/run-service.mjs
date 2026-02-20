import 'dotenv/config';
import fs from 'fs';
import axios from 'axios';
import { XMLParser } from 'fast-xml-parser';
import { google } from 'googleapis';
import os from 'os';
import path from 'path';
import { URLSearchParams } from 'url';

const TZ = process.env.TZ || 'UTC';
const LOCK_TTL_HOURS = Number(process.env.LOCK_TTL_HOURS || 12);
const LOCK_TTL_MS = LOCK_TTL_HOURS * 60 * 60 * 1000;

const DEFAULT_COLUMNS = [
  { type: 'field', header: 'price', from: ['price'] },
  { type: 'field', header: 'vendorCode', from: ['vendorCode'] },
  { type: 'picture_image', header: 'picture' },
  { type: 'pictures', header: 'picture_urls' },
  { type: 'field', header: 'name', from: ['name'] },
  { type: 'param', header: 'size', names: ['Розмір'] },
  { type: 'field', header: 'quantity', from: ['quantity_in_stock'] },
];

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

function loadConfig(path) {
  if (!path) throw new Error('Pass config path: node services/run-service.mjs services/lispo.json');
  const raw = fs.readFileSync(path, 'utf8');
  const cfg = deepResolve(JSON.parse(raw));
  const required = ['feedUrl', 'sheetId', 'sheetName'];
  for (const key of required) if (!cfg[key]) throw new Error(`Config missing ${key}`);
  cfg.chunkRows = Number(cfg.chunkRows || process.env.CHUNK_ROWS || 1500);
  cfg.writeRetries = Number(cfg.writeRetries || process.env.WRITE_RETRIES || 3);
  cfg.retryDelayMs = Number(cfg.retryDelayMs || process.env.RETRY_DELAY_MS || 2000);
  cfg.metaSheetName = cfg.metaSheetName || `${cfg.sheetName}_meta`;
  cfg.columns = cfg.columns || DEFAULT_COLUMNS;
  return cfg;
}

function arrayify(val) {
  if (Array.isArray(val)) return val;
  if (val === undefined || val === null) return [];
  return [val];
}

function getByPath(obj, pathStr) {
  if (!pathStr || typeof pathStr !== 'string') return undefined;
  const parts = pathStr.split('.');
  let cur = obj;
  for (const part of parts) {
    if (cur === undefined || cur === null) return undefined;
    cur = cur[part];
  }
  return cur;
}

function pickField(obj, keys) {
  for (const k of keys) {
    let val = obj[k];
    if (val === undefined && typeof k === 'string' && k.includes('.')) {
      val = getByPath(obj, k);
    }
    if (val !== undefined && val !== null) return val;
  }
  return '';
}

function pickParam(obj, names) {
  const params = arrayify(obj.param);
  for (const name of names) {
    for (const p of params) if (p['@_name'] === name) return p['#text'] || '';
  }
  return '';
}

function mergeCookies(cookieJar, setCookieHeaders) {
  const lines = arrayify(setCookieHeaders);
  for (const line of lines) {
    if (!line || typeof line !== 'string') continue;
    const firstPart = line.split(';', 1)[0];
    const idx = firstPart.indexOf('=');
    if (idx <= 0) continue;
    const key = firstPart.slice(0, idx).trim();
    const value = firstPart.slice(idx + 1).trim();
    if (key) cookieJar.set(key, value);
  }
}

function cookieHeader(cookieJar) {
  return Array.from(cookieJar.entries())
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');
}

function extractCsrfToken(html, tokenField = '_token') {
  if (!html || typeof html !== 'string') return null;
  const inputRegex = new RegExp(`name=["']${tokenField}["'][^>]*value=["']([^"']+)["']`, 'i');
  const inputMatch = html.match(inputRegex);
  if (inputMatch?.[1]) return inputMatch[1];

  const metaMatch = html.match(/<meta[^>]+name=["']csrf-token["'][^>]+content=["']([^"']+)["']/i);
  if (metaMatch?.[1]) return metaMatch[1];
  return null;
}

async function buildAuthCookieHeader(authCfg) {
  if (!authCfg) return '';
  if (authCfg.type !== 'form') throw new Error(`Unsupported auth type: ${authCfg.type}`);
  if (!authCfg.loginUrl) throw new Error('Auth config missing loginUrl');

  const usernameField = authCfg.usernameField || 'email';
  const passwordField = authCfg.passwordField || 'password';
  const tokenField = authCfg.tokenField || '_token';
  if (!authCfg.username || !authCfg.password) {
    throw new Error('Auth config missing username/password (or related env vars)');
  }

  const jar = new Map();

  const loginPage = await axios.get(authCfg.loginUrl, {
    timeout: 60_000,
    validateStatus: (s) => s >= 200 && s < 400,
  });
  mergeCookies(jar, loginPage.headers?.['set-cookie']);
  const token = extractCsrfToken(loginPage.data, tokenField);

  const formData = new URLSearchParams();
  if (token) formData.set(tokenField, token);
  formData.set(usernameField, authCfg.username);
  formData.set(passwordField, authCfg.password);
  const extraFields = authCfg.extraFields || {};
  for (const [k, v] of Object.entries(extraFields)) formData.set(k, String(v));

  const loginHeaders = {
    'Content-Type': 'application/x-www-form-urlencoded',
  };
  const initialCookie = cookieHeader(jar);
  if (initialCookie) loginHeaders.Cookie = initialCookie;

  const loginResp = await axios.post(authCfg.loginUrl, formData.toString(), {
    timeout: 60_000,
    headers: loginHeaders,
    maxRedirects: 0,
    validateStatus: (s) => (s >= 200 && s < 400) || s === 302,
  });
  mergeCookies(jar, loginResp.headers?.['set-cookie']);

  const finalCookie = cookieHeader(jar);
  if (!finalCookie) throw new Error('Auth failed: no cookies after login');
  return finalCookie;
}

function normalizeCellValue(val) {
  if (val === undefined || val === null) return val;
  if (Array.isArray(val)) {
    return val
      .map((v) => normalizeCellValue(v))
      .filter((v) => v !== undefined && v !== null && v !== '')
      .join('; ');
  }
  if (typeof val === 'object') {
    if (Object.prototype.hasOwnProperty.call(val, '#text')) return val['#text'];
    return JSON.stringify(val);
  }
  return val;
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

async function ensureSheet(sheets, spreadsheetId, title, retries, delayMs) {
  const doc = await withRetry(
    'get spreadsheet',
    () => sheets.spreadsheets.get({ spreadsheetId }),
    retries,
    delayMs
  );
  const sheet = doc.data.sheets?.find((s) => s.properties?.title === title);
  if (!sheet) {
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
    const refreshed = await withRetry(
      'refresh spreadsheet',
      () => sheets.spreadsheets.get({ spreadsheetId }),
      retries,
      delayMs
    );
    return refreshed.data.sheets?.find((s) => s.properties?.title === title);
  }
  return sheet;
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

function extractOffers(parsed) {
  // YML sometimes: <yml_catalog><offers><offer>
  let offers = parsed?.yml_catalog?.offers?.offer;
  if (offers) return offers;

  // YML canonical: <yml_catalog><shop><offers><offer>
  offers = parsed?.yml_catalog?.shop?.offers?.offer;
  if (offers) return offers;

  // XML variant: <xml_catalog><offers><offer>
  offers = parsed?.xml_catalog?.offers?.offer;
  if (offers) return offers;

  // XML variant: <xml_catalog><shop><offers><offer>
  offers = parsed?.xml_catalog?.shop?.offers?.offer;
  if (offers) return offers;

  // Sometimes <shop><offers><offer> without yml_catalog
  offers = parsed?.shop?.offers?.offer;
  if (offers) return offers;

  // Some feeds use <catalog><offers><offer>
  offers = parsed?.catalog?.offers?.offer;
  if (offers) return offers;

  // Simple products list: <products><product>
  offers = parsed?.products?.product;
  if (offers) return offers;

  return null;
}

async function fetchOffers(cfg) {
  const headers = {};
  if (cfg.auth) {
    const cookie = await buildAuthCookieHeader(cfg.auth);
    if (cookie) headers.Cookie = cookie;
  }

  const xml = (
    await axios.get(cfg.feedUrl, {
      timeout: 60_000,
      headers,
      responseType: 'text',
    })
  ).data;
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });
  const feed = parser.parse(xml);
  const offers = extractOffers(feed);
  if (!offers) {
    const rootKeys = Object.keys(feed || {});
    throw new Error(`No offers found in feed (root keys: ${rootKeys.join(', ')})`);
  }
  return Array.isArray(offers) ? offers : [offers];
}

function buildRows(offers, cfg) {
  const headers = cfg.columns.map((c) => c.header);
  const rows = [headers];

  offers.forEach((o) => {
    const pics = arrayify(o.picture);
    const firstPic = pics[0] || '';
    const rowNumber = rows.length + 1; // sheet row number (header = 1)

    const row = cfg.columns.map((c) => {
      let val = '';
      switch (c.type) {
        case 'field':
          val = pickField(o, c.from || []);
          break;
        case 'attribute':
          val = pickField(o, (c.from || []).map((k) => `@_${k}`)) || (c.key ? o[`@_${c.key}`] : '');
          break;
        case 'param':
          val = pickParam(o, c.names || []);
          break;
        case 'pictures':
          val = pics.join('; ');
          break;
        case 'picture_image':
          val = firstPic ? `=IMAGE("${firstPic}")` : '';
          break;
        case 'formula':
          if (c.template) {
            val = c.template.replaceAll('{row}', rowNumber);
          }
          break;
        default:
          val = '';
      }

      val = normalizeCellValue(val);

      if (val !== undefined && val !== null && val !== '') {
        let valStr = String(val);

        if (c.insideParensOnly) {
          const m = valStr.match(/\(([^)]*)\)/);
          valStr = m ? m[1].trim() : valStr.trim();
        }

        if (c.stripParens) {
          valStr = valStr.replace(/\s*\([^)]*\)/g, '').trim();
        }

        if (c.cleanContains) {
          const hit = (Array.isArray(c.cleanContains) ? c.cleanContains : [c.cleanContains]).some((s) =>
            valStr.includes(s)
          );
          valStr = hit ? '' : valStr;
        }

        val = valStr;
      }

      return val;
    });

    rows.push(row);
  });

  return rows;
}

async function clearSheet(sheets, spreadsheetId, sheetName, retries, delayMs) {
  await withRetry(
    'clear sheet',
    () => sheets.spreadsheets.values.clear({ spreadsheetId, range: `${sheetName}!A:ZZ` }),
    retries,
    delayMs
  );
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

async function upsertMeta(sheets, cfg, dateStr, timeStr, rowCount) {
  const metaProps = await ensureSheet(sheets, cfg.sheetId, cfg.metaSheetName, cfg.writeRetries, cfg.retryDelayMs);
  await resizeSheet(sheets, cfg.sheetId, metaProps, 2, 6, cfg.writeRetries, cfg.retryDelayMs);
  const values = [['last_update_date', dateStr, 'last_update_time', timeStr, 'rows', rowCount]];
  await withRetry(
    'write meta',
    () =>
      sheets.spreadsheets.values.update({
        spreadsheetId: cfg.sheetId,
        range: `${cfg.metaSheetName}!A1:F1`,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values },
      }),
    cfg.writeRetries,
    cfg.retryDelayMs
  );

  // conditional formatting on date cell B1
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
    startColumnIndex: 1, // B
    endColumnIndex: 2,   // B only
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
      () => sheets.spreadsheets.batchUpdate({ spreadsheetId: cfg.sheetId, requestBody: { requests } }),
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

    // per-service lock to avoid concurrent runs on the same feed
    const lockName = `feed-lock-${cfg.name || cfg.sheetName}.lock`;
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
      const alive = pid ? isPidAlive(pid) : false;
      if (pid && alive) {
        console.error(
          `Another run is in progress for ${cfg.name || cfg.sheetName} (pid ${pid}, lock ${lockPath}). Exit.`
        );
        process.exit(1);
      }

      // If PID from lock is dead, reclaim lock immediately (no need to wait TTL).
      if ((pid && !alive) || isStaleLock(lockPath, existing)) {
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
        console.error(`Another run is in progress for ${cfg.name || cfg.sheetName} (lock ${lockPath}). Exit.`);
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

  const offers = await withRetry(
    'fetch feed',
    () => fetchOffers(cfg),
    cfg.writeRetries,
    cfg.retryDelayMs
  );
  const rows = buildRows(offers, cfg);

  const sheetProps = await ensureSheet(sheets, cfg.sheetId, cfg.sheetName, cfg.writeRetries, cfg.retryDelayMs);
  await resizeSheet(sheets, cfg.sheetId, sheetProps, rows.length + 10, rows[0].length + 5, cfg.writeRetries, cfg.retryDelayMs);
  await clearSheet(sheets, cfg.sheetId, cfg.sheetName, cfg.writeRetries, cfg.retryDelayMs);
    await writeSheet(sheets, cfg.sheetId, cfg.sheetName, rows, cfg.chunkRows, cfg.writeRetries, cfg.retryDelayMs);

    const now = new Date();
    const dateStr = new Intl.DateTimeFormat('sv-SE', { timeZone: TZ }).format(now); // yyyy-mm-dd
    const timeStr = new Intl.DateTimeFormat('en-GB', {
      timeZone: TZ,
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).format(now);
    await upsertMeta(sheets, cfg, dateStr, timeStr, rows.length - 1);

    console.log(
      `Service ${cfg.name || configPath}: updated sheet "${cfg.sheetName}" with ${rows.length - 1} offers, ${rows[0].length} columns.`
    );
  } catch (err) {
    console.error('Update failed:', err.message);
    if (err.response) {
      console.error('Response status:', err.response.status);
      console.error('Response data:', JSON.stringify(err.response.data, null, 2));
    }
    if (err.errors) console.error('Errors:', err.errors);
    process.exit(1);
  }
  finally {
    if (lockPath) {
      try { fs.unlinkSync(lockPath); } catch (e) {}
    }
  }
}

main();
