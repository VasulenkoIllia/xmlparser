import 'dotenv/config';
import { google } from 'googleapis';
import { normalizeRows } from './normalize-core.mjs';

const args = process.argv.slice(2);
const sourceSpreadsheetId = args[0];
let inputSheetName = null;
let outputSpreadsheetId = null;
let outputSheetName = null;

if (!sourceSpreadsheetId) {
  console.error(
    'Usage: node scripts/normalize-sheet.mjs <sourceSpreadsheetId> [outputSpreadsheetId] [inputSheetName] [outputSheetName]'
  );
  process.exit(1);
}

const looksLikeSpreadsheetId = (value) =>
  typeof value === 'string' && /^[A-Za-z0-9-_]{25,}$/.test(value);

if (args[1]) {
  if (looksLikeSpreadsheetId(args[1])) {
    outputSpreadsheetId = args[1];
    outputSheetName = args[2] || null;
  } else {
    inputSheetName = args[1];
    if (args[2] && looksLikeSpreadsheetId(args[2])) {
      outputSpreadsheetId = args[2];
      outputSheetName = args[3] || null;
    } else if (args[2]) {
      outputSheetName = args[2];
    }
  }
}

const rawKey = process.env.GOOGLE_PRIVATE_KEY || '';
const privateKey = rawKey.replace(/\\n/g, '\n');
if (!process.env.GOOGLE_CLIENT_EMAIL || !privateKey) {
  console.error('Missing GOOGLE_CLIENT_EMAIL or GOOGLE_PRIVATE_KEY in env');
  process.exit(1);
}

const auth = new google.auth.JWT({
  email: process.env.GOOGLE_CLIENT_EMAIL,
  key: privateKey,
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  keyId: process.env.GOOGLE_PRIVATE_KEY_ID,
});
const sheets = google.sheets({ version: 'v4', auth });

const chunkRows = Number(process.env.CHUNK_ROWS || 1500);

function colLetter(n) {
  let s = '';
  while (n) {
    n -= 1;
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26);
  }
  return s;
}

async function getFirstSheetTitle(spreadsheetId) {
  const doc = await sheets.spreadsheets.get({ spreadsheetId });
  return doc.data.sheets?.[0]?.properties?.title || null;
}

async function ensureSheet(spreadsheetId, title) {
  const doc = await sheets.spreadsheets.get({ spreadsheetId });
  const sheet = doc.data.sheets?.find((s) => s.properties?.title === title);
  if (sheet) return sheet;
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: { requests: [{ addSheet: { properties: { title } } }] },
  });
  const refreshed = await sheets.spreadsheets.get({ spreadsheetId });
  return refreshed.data.sheets?.find((s) => s.properties?.title === title);
}

async function clearSheet(spreadsheetId, title) {
  await sheets.spreadsheets.values.clear({ spreadsheetId, range: `${title}!A:ZZ` });
}

async function writeSheet(spreadsheetId, title, rows) {
  const colCount = rows[0].length;
  let startRow = 1;
  for (let i = 0; i < rows.length; i += chunkRows) {
    const part = rows.slice(i, i + chunkRows);
    const endRow = startRow + part.length - 1;
    const range = `${title}!A${startRow}:${colLetter(colCount)}${endRow}`;
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: part },
    });
    startRow = endRow + 1;
  }
}

if (!inputSheetName) {
  inputSheetName = await getFirstSheetTitle(sourceSpreadsheetId);
  if (!inputSheetName) {
    console.error('Could not determine input sheet name (no sheets found).');
    process.exit(1);
  }
}

if (!outputSpreadsheetId) outputSpreadsheetId = sourceSpreadsheetId;
if (!outputSheetName) {
  if (outputSpreadsheetId === sourceSpreadsheetId) {
    outputSheetName = `${inputSheetName}_normalized`;
  } else {
    outputSheetName = (await getFirstSheetTitle(outputSpreadsheetId)) || `${inputSheetName}_normalized`;
  }
}

const inputRange = `${inputSheetName}!A:ZZ`;
const response = await sheets.spreadsheets.values.get({
  spreadsheetId: sourceSpreadsheetId,
  range: inputRange,
  majorDimension: 'ROWS',
  valueRenderOption: 'FORMATTED_VALUE',
});

const rows = response.data.values || [];
if (!rows.length) {
  console.error(`No data found in ${inputRange}`);
  process.exit(1);
}

const outputRows = normalizeRows(rows);

await ensureSheet(outputSpreadsheetId, outputSheetName);
await clearSheet(outputSpreadsheetId, outputSheetName);
await writeSheet(outputSpreadsheetId, outputSheetName, outputRows);

console.log(
  `Updated "${outputSheetName}" in spreadsheet ${outputSpreadsheetId} with ${outputRows.length - 1} rows.`
);
