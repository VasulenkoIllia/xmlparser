import fs from 'fs';
import path from 'path';
import axios from 'axios';
import { XMLParser } from 'fast-xml-parser';
import xlsx from 'xlsx';

const argv = process.argv.slice(2);
const args = new Map();
for (let i = 0; i < argv.length; i += 1) {
  const key = argv[i];
  if (!key.startsWith('--')) continue;
  const value = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : '';
  args.set(key.replace(/^--/, ''), value);
}

const feedUrl = args.get('url');
const feedName = args.get('name');
const outDir = args.get('out') || 'exports';

if (!feedUrl || !feedName) {
  console.error('Usage: node scripts/export-feed.mjs --url <feedUrl> --name <fileBaseName> [--out <dir>]');
  process.exit(1);
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  allowBooleanAttributes: true,
  parseTrueNumberOnly: false,
});

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function extractOffers(parsed) {
  let offers = parsed?.yml_catalog?.offers?.offer;
  if (offers) return offers;

  offers = parsed?.yml_catalog?.shop?.offers?.offer;
  if (offers) return offers;

  offers = parsed?.shop?.offers?.offer;
  if (offers) return offers;

  offers = parsed?.offers?.offer;
  if (offers) return offers;

  offers = parsed?.products?.product;
  if (offers) return offers;

  return null;
}

function normalizeArray(val) {
  if (Array.isArray(val)) return val;
  if (val === undefined || val === null) return [];
  return [val];
}

function flattenOffer(offer) {
  const row = {};

  const assign = (key, value) => {
    if (value === undefined || value === null) return;
    if (Array.isArray(value)) {
      row[key] = value
        .map((v) => (v && typeof v === 'object' ? JSON.stringify(v) : v))
        .join('; ');
    } else if (typeof value === 'object') {
      if (Object.prototype.hasOwnProperty.call(value, '#text')) {
        row[key] = value['#text'];
      } else {
        row[key] = JSON.stringify(value);
      }
    } else {
      row[key] = value;
    }
  };

  for (const [key, val] of Object.entries(offer)) {
    if (key === 'param') {
      const params = normalizeArray(val);
      params.forEach((p) => {
        const paramName = p?.['@_name'] || p?.['@_id'] || 'param';
        const value = p?.['#text'] ?? '';
        const col = `param:${paramName}`;
        row[col] = row[col] ? `${row[col]}; ${value}` : value;
      });
      continue;
    }

    if (key === 'picture') {
      const pics = normalizeArray(val);
      if (pics.length) {
        assign('picture', pics[0]);
        assign('picture_urls', pics);
      }
      continue;
    }

    if (key.startsWith('@_')) {
      assign(key.slice(2), val);
      continue;
    }

    assign(key, val);
  }

  return row;
}

function buildColumnList(rows) {
  const preferred = [
    'id',
    'name',
    'price',
    'oldprice',
    'rrc',
    'currencyId',
    'categoryId',
    'vendorCode',
    'available',
    'quantity',
    'quantity_in_stock',
    'url',
    'picture',
    'picture_urls',
  ];

  const set = new Set();
  rows.forEach((r) => Object.keys(r).forEach((k) => set.add(k)));

  const ordered = [];
  preferred.forEach((key) => {
    if (set.has(key)) {
      ordered.push(key);
      set.delete(key);
    }
  });

  const rest = Array.from(set).sort();
  return [...ordered, ...rest];
}

async function fetchOffers(url) {
  const response = await axios.get(url, { timeout: 120_000, responseType: 'text' });
  const parsed = parser.parse(response.data);
  const offers = extractOffers(parsed);
  if (!offers) {
    const roots = Object.keys(parsed || {});
    throw new Error(`Не знайшов <offer> у фіді (корені: ${roots.join(', ')})`);
  }
  return Array.isArray(offers) ? offers : [offers];
}

function writeExcel(name, rows, dir) {
  ensureDir(dir);
  const columns = buildColumnList(rows);
  const table = [
    columns,
    ...rows.map((r) => columns.map((c) => (r[c] !== undefined ? r[c] : ''))),
  ];

  const wb = xlsx.utils.book_new();
  const ws = xlsx.utils.aoa_to_sheet(table);
  xlsx.utils.book_append_sheet(wb, ws, 'data');

  const outPath = path.resolve(dir, `${name}.xlsx`);
  xlsx.writeFile(wb, outPath);
  return outPath;
}

async function main() {
  try {
    console.log(`→ Завантажую ${feedName} (${feedUrl})`);
    const offers = await fetchOffers(feedUrl);
    const flat = offers.map(flattenOffer);
    const outPath = writeExcel(feedName, flat, outDir);
    console.log(`✔ ${feedName}: ${offers.length} offers, файл: ${outPath}`);
  } catch (err) {
    console.error('Помилка експорту:', err.message);
    process.exit(1);
  }
}

main();
