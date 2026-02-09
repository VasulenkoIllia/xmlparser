import fs from 'fs';
import path from 'path';
import xlsx from 'xlsx';
import { normalizeRows } from './normalize-core.mjs';

const args = process.argv.slice(2);
let inputPath = null;
let outputPath = null;
let outputFormat = 'xlsx';

for (const arg of args) {
  if (arg === '--csv') {
    outputFormat = 'csv';
    continue;
  }
  if (!inputPath) {
    inputPath = arg;
    continue;
  }
  if (!outputPath) {
    outputPath = arg;
  }
}

if (!inputPath) {
  console.error('Usage: node scripts/normalize-xls.mjs <input.xls> [output.xlsx|output.csv] [--csv]');
  process.exit(1);
}

const resolvedInput = path.resolve(inputPath);
if (!fs.existsSync(resolvedInput)) {
  console.error(`Input file not found: ${resolvedInput}`);
  process.exit(1);
}

if (outputPath) {
  const ext = path.extname(outputPath).toLowerCase();
  outputFormat = ext === '.csv' ? 'csv' : 'xlsx';
} else {
  const base = path.basename(resolvedInput, path.extname(resolvedInput));
  const ext = outputFormat === 'csv' ? 'csv' : 'xlsx';
  outputPath = path.join(path.dirname(resolvedInput), `${base}.normalized.${ext}`);
}

const workbook = xlsx.readFile(resolvedInput, { cellDates: true });
const sheetName = workbook.SheetNames[0];
if (!sheetName) {
  console.error('No sheets found in the workbook.');
  process.exit(1);
}

const sheet = workbook.Sheets[sheetName];
const rows = xlsx.utils.sheet_to_json(sheet, { header: 1, defval: '' });
const outputRows = normalizeRows(rows);

const outputWorkbook = xlsx.utils.book_new();
const outputSheet = xlsx.utils.aoa_to_sheet(outputRows);

if (outputFormat === 'csv') {
  const csv = xlsx.utils.sheet_to_csv(outputSheet);
  fs.writeFileSync(outputPath, csv, 'utf8');
} else {
  xlsx.utils.book_append_sheet(outputWorkbook, outputSheet, 'data');
  xlsx.writeFile(outputWorkbook, outputPath);
}

console.log(`Saved: ${outputPath}`);
console.log(`Rows: ${outputRows.length - 1}`);
