#!/usr/bin/env node
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import os from 'os';
import axios from 'axios';
import { XMLParser } from 'fast-xml-parser';
import xlsx from 'xlsx';

function parseArgs() {
  const args = process.argv.slice(2);
  const result = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--url') result.url = args[++i];
    else if (args[i] === '--file') result.file = args[++i];
    else if (args[i] === '--name') result.name = args[++i];
    else if (args[i] === '--sheet') result.sheetId = args[++i];
  }
  return result;
}

async function fetchSource(url) {
  const pathname = (() => { try { return new URL(url).pathname; } catch { return url; } })();
  const ext = path.extname(pathname).toLowerCase();
  if (ext === '.xlsx' || ext === '.xls') {
    const data = (await axios.get(url, { responseType: 'arraybuffer', timeout: 60_000 })).data;
    return { type: 'xlsx', data: Buffer.from(data) };
  }
  const text = (await axios.get(url, { responseType: 'text', timeout: 60_000 })).data;
  return { type: 'xml', data: text };
}

function readSource(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.xlsx' || ext === '.xls') {
    return { type: 'xlsx', data: fs.readFileSync(filePath) };
  }
  return { type: 'xml', data: fs.readFileSync(filePath, 'utf8') };
}

function extractOffers(parsed) {
  const paths = [
    ['yml_catalog', 'offers', 'offer'],
    ['yml_catalog', 'shop', 'offers', 'offer'],
    ['xml_catalog', 'offers', 'offer'],
    ['xml_catalog', 'shop', 'offers', 'offer'],
    ['shop', 'offers', 'offer'],
    ['catalog', 'offers', 'offer'],
    ['products', 'product'],
  ];
  for (const parts of paths) {
    let cur = parsed;
    for (const part of parts) {
      cur = cur?.[part];
      if (!cur) break;
    }
    if (cur) return Array.isArray(cur) ? cur : [cur];
  }
  return null;
}

function analyzeXmlOffers(offers) {
  const fields = new Map();
  const params = new Map();
  const picCounts = [];
  const sample = offers.length > 0 ? offers[0] : {};

  for (const offer of offers.slice(0, 100)) {
    for (const [key, val] of Object.entries(offer)) {
      if (key === 'param' || key === 'picture') continue;
      if (!fields.has(key)) fields.set(key, []);
      const arr = fields.get(key);
      if (arr.length < 3) {
        const str = typeof val === 'object' ? JSON.stringify(val) : String(val);
        if (str && !arr.includes(str.slice(0, 80))) arr.push(str.slice(0, 80));
      }
    }

    const paramArr = Array.isArray(offer.param)
      ? offer.param
      : offer.param
      ? [offer.param]
      : [];
    for (const p of paramArr) {
      const pname = p?.['@_name'];
      const pval = p?.['#text'];
      if (!pname) continue;
      if (!params.has(pname)) params.set(pname, []);
      const arr = params.get(pname);
      if (pval && arr.length < 3 && !arr.includes(String(pval).slice(0, 50)))
        arr.push(String(pval).slice(0, 50));
    }

    const pics = Array.isArray(offer.picture)
      ? offer.picture.length
      : offer.picture
      ? 1
      : 0;
    picCounts.push(pics);
  }

  const avgPics =
    picCounts.length
      ? (picCounts.reduce((a, b) => a + b, 0) / picCounts.length).toFixed(1)
      : '0';

  return { fields, params, avgPics, sample };
}

function analyzeXlsx(buffer) {
  const wb = xlsx.read(buffer, { cellDates: true });
  const sheetName = wb.SheetNames[0];
  const rows = xlsx.utils.sheet_to_json(wb.Sheets[sheetName], { defval: '', raw: false });
  const headers = rows.length ? Object.keys(rows[0]) : [];
  const samples = new Map();
  for (const row of rows.slice(0, 5)) {
    for (const [k, v] of Object.entries(row)) {
      if (!samples.has(k)) samples.set(k, []);
      if (v && samples.get(k).length < 3) samples.get(k).push(String(v).slice(0, 60));
    }
  }
  return { sheetNames: wb.SheetNames, headers, samples, rowCount: rows.length };
}

function suggestXmlConfig(name, feedUrl, sheetId, offers) {
  const { fields, params } = analyzeXmlOffers(offers);
  const columns = [];

  const hasAttrId = offers[0]?.['@_id'] !== undefined;
  if (hasAttrId) columns.push({ header: 'ID', type: 'attribute', from: ['id'] });

  const fieldDefs = [
    ['name', 'Назва', {}],
    ['price', 'Ціна', { asNumber: true }],
    ['oldprice', 'Стара ціна', { asNumber: true }],
    ['vendorCode', 'Артикул', {}],
    ['vendor', 'Бренд', {}],
    ['barcode', 'Штрихкод', {}],
    ['quantity_in_stock', 'Кількість', { asNumber: true }],
    ['categoryId', 'Категорія', {}],
  ];

  for (const [key, header, extra] of fieldDefs) {
    if (fields.has(key)) columns.push({ header, type: 'field', from: [key], ...extra });
  }

  const hasAttrAvailable = offers[0]?.['@_available'] !== undefined;
  if (hasAttrAvailable) columns.push({ header: 'Наявність', type: 'attribute', from: ['available'] });

  if (offers[0]?.picture) {
    columns.push({ header: 'Фото', type: 'picture_image' });
    columns.push({ header: 'Фото URLs', type: 'pictures' });
  }

  for (const [pname] of params) {
    columns.push({ header: pname, type: 'param', names: [pname] });
  }

  return {
    name,
    feedUrl: feedUrl || 'https://...',
    sheetId: sheetId || 'YOUR_GOOGLE_SHEET_ID',
    sheetName: 'offers',
    columns,
  };
}

function suggestXlsxConfig(name, feedUrl, sheetId, headers) {
  const numericHints = ['price', 'ціна', 'дроп', 'drop', 'quantity', 'stock', 'кількість', 'rrc'];
  const columns = headers.map((h) => {
    const lower = h.toLowerCase();
    const isNumeric = numericHints.some((hint) => lower.includes(hint));
    return { header: h, type: 'field', from: [h], ...(isNumeric ? { asNumber: true } : {}) };
  });

  return {
    name,
    feedUrl: feedUrl || 'https://...',
    sourceFormat: 'xlsx',
    sheetId: sheetId || 'YOUR_GOOGLE_SHEET_ID',
    sheetName: 'offers',
    columns,
  };
}

const HR = '─'.repeat(52);

async function main() {
  const args = parseArgs();

  if (!args.url && !args.file) {
    console.log('Usage:');
    console.log('  node scripts/inspect-feed.mjs --url <url> [--name <name>] [--sheet <sheetId>]');
    console.log('  node scripts/inspect-feed.mjs --file <path> [--name <name>] [--sheet <sheetId>]');
    process.exit(0);
  }

  const src = args.url || args.file;
  const name =
    args.name ||
    path.basename(src, path.extname(src)).replace(/[^a-zA-Z0-9_]/g, '_').toLowerCase();

  console.log(`\nFeed Inspector: ${name}`);
  console.log(HR);

  let source;
  try {
    if (args.url) {
      console.log('Fetching...\n');
      source = await fetchSource(args.url);
    } else {
      source = readSource(args.file);
    }
  } catch (err) {
    console.error('Failed to load feed:', err.message);
    process.exit(1);
  }

  if (source.type === 'xlsx') {
    let analysis;
    try {
      analysis = analyzeXlsx(source.data);
    } catch (err) {
      console.error('Failed to parse XLSX:', err.message);
      process.exit(1);
    }

    console.log(`Format:   XLSX`);
    console.log(`Sheets:   ${analysis.sheetNames.join(', ')}`);
    console.log(`Rows:     ${analysis.rowCount}`);
    console.log(`Columns:  ${analysis.headers.length}`);
    console.log('');
    console.log('Column samples:');
    for (const [col, vals] of analysis.samples) {
      if (vals.length > 0) console.log(`  ${col}: ${vals.join(' | ')}`);
    }

    console.log(`\n${HR}`);
    console.log('Suggested config (services/' + name + '.json):');
    console.log(HR);
    console.log(JSON.stringify(suggestXlsxConfig(name, args.url, args.sheetId, analysis.headers), null, 2));
  } else {
    let offers;
    try {
      const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });
      const feed = parser.parse(source.data);
      offers = extractOffers(feed);
      if (!offers) {
        const rootKeys = Object.keys(feed || {});
        throw new Error(`No offers found. Root keys: ${rootKeys.join(', ')}`);
      }
    } catch (err) {
      console.error('Failed to parse XML:', err.message);
      process.exit(1);
    }

    const { fields, params, avgPics, sample } = analyzeXmlOffers(offers);

    console.log(`Format:   XML`);
    console.log(`Offers:   ${offers.length}`);
    console.log(`Fields:   ${[...fields.keys()].join(', ')}`);
    if (params.size > 0) console.log(`Params:   ${[...params.keys()].join(', ')}`);
    console.log(`Avg pics: ${avgPics}`);

    console.log('\nFirst offer:');
    for (const [key, val] of Object.entries(sample)) {
      if (key === 'param') continue;
      const str = typeof val === 'object' ? JSON.stringify(val) : String(val);
      console.log(`  ${key}: ${str.slice(0, 100)}`);
    }

    if (params.size > 0) {
      console.log('\nParam samples:');
      for (const [pname, vals] of params) {
        console.log(`  ${pname}: ${vals.join(' | ')}`);
      }
    }

    console.log(`\n${HR}`);
    console.log('Suggested config (services/' + name + '.json):');
    console.log(HR);
    console.log(JSON.stringify(suggestXmlConfig(name, args.url, args.sheetId, offers), null, 2));
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
