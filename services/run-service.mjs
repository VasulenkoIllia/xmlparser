import 'dotenv/config';
import fs from 'fs';
import axios from 'axios';
import { XMLParser } from 'fast-xml-parser';
import xlsx from 'xlsx';
import os from 'os';
import path from 'path';
import { URLSearchParams } from 'url';
import {
  sleep, writeResult, withRetry, colLetter, deepResolve,
  acquireLock, releaseLock, createSheetsClient,
  ensureSheet, resizeSheet, clearSheet, writeSheet, upsertMeta, nowStrings,
} from './core/sheets.mjs';
import { notifyError, notifyWarn } from './core/telegram.mjs';

// ─── Config ───────────────────────────────────────────────────────────────────

// Some feeds sit behind Cloudflare/WAF that reject the default `axios/x.y` User-Agent
// with HTTP 403. Present a browser-like UA so those requests pass the bot check.
const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'uk-UA,uk;q=0.9,en;q=0.8',
};

const DEFAULT_COLUMNS = [
  { type: 'field',         header: 'price',        from: ['price'] },
  { type: 'field',         header: 'vendorCode',    from: ['vendorCode'] },
  { type: 'picture_image', header: 'picture' },
  { type: 'pictures',      header: 'picture_urls' },
  { type: 'field',         header: 'name',          from: ['name'] },
  { type: 'param',         header: 'size',          names: ['Розмір'] },
  { type: 'field',         header: 'quantity',      from: ['quantity_in_stock'] },
];

function loadConfig(configPath) {
  if (!configPath) throw new Error('Pass config path: node services/run-service.mjs services/lispo.json');
  const cfg = deepResolve(JSON.parse(fs.readFileSync(configPath, 'utf8')));
  for (const key of ['feedUrl', 'sheetId', 'sheetName']) {
    if (!cfg[key]) throw new Error(`Config missing: ${key}`);
  }
  cfg.chunkRows    = Number(cfg.chunkRows    || process.env.CHUNK_ROWS    || 1500);
  cfg.writeRetries = Number(cfg.writeRetries || process.env.WRITE_RETRIES || 3);
  cfg.retryDelayMs = Number(cfg.retryDelayMs || process.env.RETRY_DELAY_MS || 2000);
  cfg.metaSheetName  = cfg.metaSheetName  || `${cfg.sheetName}_meta`;
  cfg.columns        = cfg.columns        || DEFAULT_COLUMNS;
  cfg.sourceFormat   = String(cfg.sourceFormat || 'xml').toLowerCase();
  return cfg;
}

// ─── Value helpers ────────────────────────────────────────────────────────────

function arrayify(val) {
  if (Array.isArray(val)) return val;
  return val === undefined || val === null ? [] : [val];
}

function getByPath(obj, pathStr) {
  if (!pathStr || typeof pathStr !== 'string') return undefined;
  let cur = obj;
  for (const part of pathStr.split('.')) {
    if (cur === undefined || cur === null) return undefined;
    cur = cur[part];
  }
  return cur;
}

function pickField(obj, keys) {
  for (const k of keys) {
    const val = k.includes('.') ? getByPath(obj, k) : obj[k];
    if (val !== undefined && val !== null) return val;
  }
  return '';
}

function pickFieldList(obj, options = {}) {
  const items = arrayify(pickField(obj, options.from || []));
  const ignored = new Set((options.ignoreValues || []).map((v) => String(v).trim().toLowerCase()));
  const seen = new Set();
  const values = [];
  for (const item of items) {
    let value = options.valueFrom === '.'
      ? item
      : options.valueFrom
      ? getByPath(item, options.valueFrom)
      : options.attr
      ? item?.[`@_${options.attr}`]
      : item;
    if (value === undefined || value === null) continue;
    const s = String(value).trim();
    if (!s || ignored.has(s.toLowerCase())) continue;
    if (options.unique !== false && seen.has(s)) continue;
    seen.add(s);
    values.push(s);
  }
  return values.join(options.separator || '; ');
}

function pickParam(obj, names, options = {}) {
  const params = arrayify(obj.param);
  const ignored = new Set((options.ignoreValues || []).map((v) => String(v).trim().toLowerCase()));
  if (options.joinMatched) {
    const wanted = new Set(names);
    const seen = new Set();
    const values = [];
    for (const p of params) {
      const value = String(p?.['#text'] ?? '').trim();
      if (!wanted.has(p?.['@_name']) || !value || ignored.has(value.toLowerCase()) || seen.has(value)) continue;
      seen.add(value);
      values.push(value);
    }
    return values.join(options.separator || '; ');
  }
  for (const name of names) {
    for (const p of params) {
      const value = String(p?.['#text'] ?? '').trim();
      if (p['@_name'] === name && value && !ignored.has(value.toLowerCase())) return value;
    }
  }
  return '';
}

function toNumberIfPossible(val) {
  if (typeof val === 'number') return Number.isFinite(val) ? val : '';
  if (typeof val !== 'string') return val;
  const trimmed = val.trim();
  if (!trimmed) return '';
  let n = trimmed.replace(/\s+/g, '');
  if (/^-?\d{1,3}(?:,\d{3})+(?:\.\d+)?$/.test(n)) {
    n = n.replace(/,/g, '');
  } else if (/^-?\d{1,3}(?:\.\d{3})+(?:,\d+)?$/.test(n)) {
    n = n.replace(/\./g, '').replace(',', '.');
  } else {
    n = n.replace(',', '.');
  }
  if (!/^-?\d+(?:\.\d+)?$/.test(n)) return val;
  const num = Number(n);
  return Number.isFinite(num) ? num : val;
}

function normalizeValueMapKey(val, mode) {
  const raw = String(val ?? '').replace(/\u00a0/g, ' ').trim();
  if (!raw) return '';
  switch (mode) {
    case 'size_cm':
      return raw.replace(/\s+/g, ' ')
        .replace(/(\d+(?:[.,]\d+)?)\s*см$/i, '$1 см')
        .replace(/^(\d+(?:[.,]\d+)?)\s*см$/i, (_, num) => `${String(num).replace('.', ',')} см`)
        .toLowerCase();
    case 'lower': return raw.toLowerCase();
    default:      return raw;
  }
}

function applyValueMap(val, col) {
  if (!col?.valueMap || val === undefined || val === null || val === '') return val;
  const key = normalizeValueMapKey(val, col.valueMapNormalize);
  if (Array.isArray(col.valueMap)) {
    const matches = col.valueMap
      .filter(Boolean)
      .filter((e) => normalizeValueMapKey(Array.isArray(e) ? e[0] : e.from, col.valueMapNormalize) === key)
      .map((e) => Array.isArray(e) ? e[1] : e.to);
    if (!matches.length) return val;
    return matches.length === 1 ? matches[0] : matches.join(col.valueMapSeparator || '; ');
  }
  for (const [from, to] of Object.entries(col.valueMap)) {
    if (normalizeValueMapKey(from, col.valueMapNormalize) === key) return to;
  }
  return val;
}

function isLikelyNumericColumn(col) {
  if (col?.asText)   return false;
  if (col?.asNumber) return true;
  const positive = ['price','drop','discount','quantity','stock','rrc','retail','wholesale','contract','semi_wholesale','amount','sum','cost','цена','ціна','дроп','зниж','скид','кільк','колич','залишк','остат'];
  const negative = ['vendorcode','vendor_code','barcode','uuid','categoryid','currencyid','id','code','sku','model','url','name','picture','color','size','розмір','размер','колір','цвет'];
  const candidates = [col?.header, ...(col?.from || []), col?.key].filter(Boolean).map((s) => String(s).toLowerCase()).join(' ');
  if (!candidates) return false;
  return positive.some((h) => candidates.includes(h)) && !negative.some((h) => candidates.includes(h));
}

function normalizeCellValue(val) {
  if (val === undefined || val === null) return val;
  if (Array.isArray(val)) return val.map(normalizeCellValue).filter((v) => v !== undefined && v !== null && v !== '').join('; ');
  if (typeof val === 'object') return Object.prototype.hasOwnProperty.call(val, '#text') ? val['#text'] : JSON.stringify(val);
  return val;
}

// ─── Auth ─────────────────────────────────────────────────────────────────────

function mergeCookies(jar, headers) {
  for (const line of arrayify(headers)) {
    if (!line || typeof line !== 'string') continue;
    const first = line.split(';', 1)[0];
    const idx = first.indexOf('=');
    if (idx > 0) jar.set(first.slice(0, idx).trim(), first.slice(idx + 1).trim());
  }
}

function cookieHeader(jar) {
  return Array.from(jar.entries()).map(([k, v]) => `${k}=${v}`).join('; ');
}

function extractCsrfToken(html, tokenField = '_token') {
  if (!html || typeof html !== 'string') return null;
  const m = html.match(new RegExp(`name=["']${tokenField}["'][^>]*value=["']([^"']+)["']`, 'i'))
    || html.match(/<meta[^>]+name=["']csrf-token["'][^>]+content=["']([^"']+)["']/i);
  return m?.[1] ?? null;
}

async function buildAuthCookieHeader(authCfg) {
  if (!authCfg) return '';
  if (authCfg.type !== 'form') throw new Error(`Unsupported auth type: ${authCfg.type}`);
  if (!authCfg.loginUrl) throw new Error('Auth config missing loginUrl');
  if (!authCfg.username || !authCfg.password) throw new Error('Auth config missing username/password');

  const usernameField = authCfg.usernameField || 'email';
  const passwordField = authCfg.passwordField || 'password';
  const tokenField    = authCfg.tokenField    || '_token';
  const jar = new Map();

  const loginPage = await axios.get(authCfg.loginUrl, { timeout: 60_000, headers: { ...BROWSER_HEADERS }, validateStatus: (s) => s < 400 });
  mergeCookies(jar, loginPage.headers?.['set-cookie']);
  const token = extractCsrfToken(loginPage.data, tokenField);

  const formData = new URLSearchParams();
  if (token) formData.set(tokenField, token);
  formData.set(usernameField, authCfg.username);
  formData.set(passwordField, authCfg.password);
  for (const [k, v] of Object.entries(authCfg.extraFields || {})) formData.set(k, String(v));

  const headers = { ...BROWSER_HEADERS, 'Content-Type': 'application/x-www-form-urlencoded' };
  const cookie = cookieHeader(jar);
  if (cookie) headers.Cookie = cookie;

  const resp = await axios.post(authCfg.loginUrl, formData.toString(), {
    timeout: 60_000, headers, maxRedirects: 0, validateStatus: (s) => s < 400 || s === 302,
  });
  mergeCookies(jar, resp.headers?.['set-cookie']);

  const finalCookie = cookieHeader(jar);
  if (!finalCookie) throw new Error('Auth failed: no cookies after login');
  return finalCookie;
}

// ─── Feed fetching ────────────────────────────────────────────────────────────

function extractOffers(parsed) {
  const paths = [
    ['yml_catalog', 'offers', 'offer'],
    ['yml_catalog', 'shop', 'offers', 'offer'],
    ['xml_catalog', 'offers', 'offer'],
    ['xml_catalog', 'shop', 'offers', 'offer'],
    ['shop', 'offers', 'offer'],
    ['catalog', 'offers', 'offer'],
    ['products', 'product'],
    ['rss', 'channel', 'item'],   // Google Merchant / WooCommerce RSS feeds
  ];
  for (const parts of paths) {
    let cur = parsed;
    for (const p of parts) { cur = cur?.[p]; if (!cur) break; }
    if (cur) return Array.isArray(cur) ? cur : [cur];
  }
  return null;
}

function isAdmToolsChallenge(payload) {
  return typeof payload === 'string' && payload.includes('adm.tools') && payload.includes('Захищена сторінка');
}

async function fetchOffers(cfg) {
  const headers = { ...BROWSER_HEADERS };
  if (cfg.auth) headers.Cookie = await buildAuthCookieHeader(cfg.auth);

  if (cfg.sourceFormat === 'xlsx') {
    const ext = (() => { try { return path.extname(new URL(cfg.feedUrl).pathname); } catch { return '.xlsx'; } })() || '.xlsx';
    const tmp = path.join(os.tmpdir(), `feed-${cfg.name || cfg.sheetName}-${process.pid}${ext}`);
    try {
      const data = (await axios.get(cfg.feedUrl, { timeout: 60_000, headers, responseType: 'arraybuffer' })).data;
      fs.writeFileSync(tmp, Buffer.from(data));
      const wb = xlsx.readFile(tmp, { cellDates: true });
      const sheetName = cfg.sourceSheetName || wb.SheetNames[0];
      if (!sheetName || !wb.Sheets[sheetName]) throw new Error(`Sheet not found${sheetName ? `: ${sheetName}` : ''}`);
      const rows = xlsx.utils.sheet_to_json(wb.Sheets[sheetName], {
        defval: '', raw: false,
        range: cfg.sourceHeaderRow ? Number(cfg.sourceHeaderRow) : undefined,
      });
      return Array.isArray(rows) ? rows : [];
    } finally {
      try { fs.unlinkSync(tmp); } catch {}
    }
  }

  let xml;
  try {
    xml = (await axios.get(cfg.feedUrl, { timeout: 60_000, headers, responseType: 'text' })).data;
  } catch (err) {
    if (err?.response?.status === 429 && isAdmToolsChallenge(err?.response?.data)) {
      throw new Error('Blocked by adm.tools (HTTP 429). Feed requires IP allowlist or alternative URL.');
    }
    throw err;
  }

  if (isAdmToolsChallenge(xml)) {
    throw new Error('Received adm.tools anti-bot page instead of feed XML.');
  }

  const feed = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' }).parse(xml);
  const offers = extractOffers(feed);
  if (!offers) throw new Error(`No offers found in feed (root keys: ${Object.keys(feed || {}).join(', ')})`);
  return Array.isArray(offers) ? offers : [offers];
}

// ─── Row building ─────────────────────────────────────────────────────────────

function buildRows(offers, cfg) {
  const headers      = cfg.columns.map((c) => c.header);
  const numericFlags = cfg.columns.map((c) => isLikelyNumericColumn(c));
  const rows = [headers];

  for (const o of offers) {
    const pics = arrayify(o.picture);
    const rowNumber = rows.length + 1;

    const row = cfg.columns.map((c, idx) => {
      let val = '';
      switch (c.type) {
        case 'field':         val = pickField(o, c.from || []); break;
        case 'field_list':    val = pickFieldList(o, c); break;
        case 'attribute':     val = pickField(o, (c.from || []).map((k) => `@_${k}`)) || (c.key ? o[`@_${c.key}`] : ''); break;
        case 'param':         val = pickParam(o, c.names || [], c); break;
        case 'pictures':      val = pics.join('; '); break;
        case 'picture_image': { const u = c.from ? pickField(o, c.from) : pics[0]; val = u ? `=IMAGE("${u}")` : ''; break; }
        case 'formula':       val = c.template ? c.template.replaceAll('{row}', rowNumber) : ''; break;
      }

      val = normalizeCellValue(val);
      val = applyValueMap(val, c);

      if ((c.insideParensOnly || c.stripParens || c.cleanContains || c.removeAfterLastSpace) && val !== '' && val != null) {
        let s = String(val);
        if (c.insideParensOnly) { const m = s.match(/\(([^)]*)\)/); s = m ? m[1].trim() : s.trim(); }
        if (c.stripParens)      s = s.replace(/\s*\([^)]*\)/g, '').trim();
        if (c.cleanContains)    s = (Array.isArray(c.cleanContains) ? c.cleanContains : [c.cleanContains]).some((w) => s.includes(w)) ? '' : s;
        if (c.removeAfterLastSpace) s = s.replace(/\s+\S+$/, '').trim();
        val = s;
      }

      if (c.extractNumber && val !== '' && val != null) {
        const m = String(val).match(/-?\d[\d\s]*(?:[.,]\d+)?/);
        val = m ? m[0].replace(/\s/g, '') : val;
      }
      if (numericFlags[idx]) val = toNumberIfPossible(val);
      return val;
    });

    let expanded = [row];
    for (let ci = 0; ci < cfg.columns.length; ci++) {
      const sep = cfg.columns[ci].explodeBySeparator;
      if (!sep) continue;
      expanded = expanded.flatMap((r) => {
        const cell = r[ci];
        if (cell === undefined || cell === null || cell === '') return [r];
        const parts = String(cell).split(String(sep)).map((p) => p.trim()).filter(Boolean);
        if (parts.length <= 1) return [r];
        return parts.map((p) => { const next = [...r]; next[ci] = p; return next; });
      });
    }
    rows.push(...expanded);
  }

  return rows;
}

// ─── Resize + format (single batchUpdate) ────────────────────────────────────

async function resizeAndFormat(sheets, spreadsheetId, sheetObj, neededRows, neededCols, columns, dataRowCount, retries, delayMs) {
  if (!sheetObj) return;
  const { sheetId, gridProperties = {} } = sheetObj.properties || {};
  const currentRows = gridProperties.rowCount || 0;
  const currentCols = gridProperties.columnCount || 0;
  const requests = [];

  if (neededRows > currentRows || neededCols > currentCols) {
    requests.push({ updateSheetProperties: { properties: { sheetId, gridProperties: { rowCount: Math.max(currentRows, neededRows), columnCount: Math.max(currentCols, neededCols) } }, fields: 'gridProperties(rowCount,columnCount)' } });
  }

  if (sheetId !== undefined && sheetId !== null) {
    const endRowIndex = Math.max(2, dataRowCount + 1);
    for (let i = 0; i < columns.length; i++) {
      if (isLikelyNumericColumn(columns[i])) {
        requests.push({ repeatCell: { range: { sheetId, startRowIndex: 1, endRowIndex, startColumnIndex: i, endColumnIndex: i + 1 }, cell: { userEnteredFormat: { numberFormat: { type: 'NUMBER' } } }, fields: 'userEnteredFormat.numberFormat' } });
      }
    }
  }

  if (!requests.length) return;
  await withRetry('resize and format', () => sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests } }), retries, delayMs);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  let lockPath = null;
  let cfg = null;
  const startTime = Date.now();

  try {
    cfg = loadConfig(process.argv[2]);
    lockPath = acquireLock(cfg.name || cfg.sheetName);

    const sheets = createSheetsClient();
    const r = cfg.writeRetries;
    const d = cfg.retryDelayMs;

    const offers = await withRetry('fetch feed', () => fetchOffers(cfg), r, d);
    if (offers.length === 0) await notifyWarn(cfg.name || cfg.sheetName, 'Feed returned 0 offers — sheet was not updated.');

    const rows = buildRows(offers, cfg);
    const sheetProps = await ensureSheet(sheets, cfg.sheetId, cfg.sheetName, r, d);
    await clearSheet(sheets, cfg.sheetId, cfg.sheetName, r, d);
    await writeSheet(sheets, cfg.sheetId, cfg.sheetName, rows, cfg.chunkRows, r, d);
    await resizeAndFormat(sheets, cfg.sheetId, sheetProps, rows.length + 10, rows[0].length + 5, cfg.columns, rows.length - 1, r, d);

    const { dateStr, timeStr } = nowStrings();
    await upsertMeta(sheets, cfg.sheetId, cfg.metaSheetName, r, d, dateStr, timeStr, rows.length - 1);

    const feedId = cfg.name || cfg.sheetName;
    writeResult(feedId, { ok: true, rows: rows.length - 1, duration: Date.now() - startTime });
    console.log(`Service ${feedId}: updated "${cfg.sheetName}" with ${rows.length - 1} offers, ${rows[0].length} columns.`);
  } catch (err) {
    const feedId = cfg?.name || cfg?.sheetName || process.argv[2] || 'unknown';
    console.error('Update failed:', err.message);
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
