import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SIZE_MAP_PATH = path.join(__dirname, 'size-map.json');

function rowHasData(row) {
  return row.some((value) => String(value).trim() !== '');
}

function isNumeric(value) {
  if (typeof value === 'number') return !Number.isNaN(value);
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return false;
    return !Number.isNaN(Number(trimmed));
  }
  return false;
}

function isSingleNumericSize(value) {
  if (typeof value === 'number') return !Number.isNaN(value);
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  return /^\d+(\.\d+)?$/.test(trimmed);
}

function cleanCell(value) {
  if (typeof value === 'string') {
    return value.replace(/\u00A0/g, ' ').replace(/\s+/g, ' ').trim();
  }
  return value;
}

function pickPrice(primary, fallback) {
  return primary === '' || primary === null || primary === undefined ? fallback : primary;
}

function isHeaderLike(value) {
  if (typeof value !== 'string') return false;
  const normalized = value.replace(/\s+/g, ' ').trim().toLowerCase();
  if (!normalized) return false;
  const patterns = [
    /^номенклатура(\.|$)/,
    /^номенклатура\.артикул/,
    /^характеристика номенклатуры/,
    /^количество$/,
    /^в ед\. хранения$/,
    /^цена$/,
    /^в выбранном типе цен/,
    /^показатели:/,
    /^группировки строк:/,
    /^отборы:/,
  ];
  return patterns.some((re) => re.test(normalized));
}

function isSizeLike(value) {
  if (!value) return false;
  if (/[A-Za-zА-Яа-я]/.test(value)) return true;
  if (/\d+\s*-\s*\d+/.test(value)) return true;
  if (/^\d+(\.\d+)?$/.test(value)) return true;
  return false;
}

function isCodeLike(value) {
  if (!value) return false;
  if (/^0\d+$/.test(value)) return true;
  if (/^\d{3,}$/.test(value)) return true;
  if (/^[A-Za-z0-9]+$/.test(value) && /[A-Za-z]/.test(value) && /\d/.test(value)) return true;
  return false;
}

function splitArticleAndSize(value) {
  if (typeof value !== 'string') {
    return { articleSuffix: '', size: value, parsed: false };
  }
  const raw = value.trim();
  if (!raw.includes(',')) {
    return { articleSuffix: '', size: value, parsed: false };
  }
  if (/^\d+,\d+$/.test(raw)) {
    return { articleSuffix: '', size: raw.replace(',', '.'), parsed: false };
  }
  const parts = raw
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length < 2) {
    return { articleSuffix: '', size: value, parsed: false };
  }

  const left = parts[0];
  const right = parts.slice(1).join(', ');
  const leftSize = isSizeLike(left);
  const rightSize = isSizeLike(right);
  const leftCode = isCodeLike(left);
  const rightCode = isCodeLike(right);

  if (leftSize && !rightSize) {
    return { articleSuffix: right, size: left, parsed: true };
  }
  if (rightSize && !leftSize) {
    return { articleSuffix: left, size: right, parsed: true };
  }
  if (leftCode && !rightCode) {
    return { articleSuffix: left, size: right, parsed: true };
  }
  if (rightCode && !leftCode) {
    return { articleSuffix: right, size: left, parsed: true };
  }
  if (leftSize && rightCode) {
    return { articleSuffix: right, size: left, parsed: true };
  }
  if (rightSize && leftCode) {
    return { articleSuffix: left, size: right, parsed: true };
  }

  return { articleSuffix: left, size: right, parsed: true };
}

function loadSizeMap() {
  if (!fs.existsSync(SIZE_MAP_PATH)) return null;
  try {
    const raw = fs.readFileSync(SIZE_MAP_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') return parsed;
  } catch (error) {
    console.error(`Failed to read size map at ${SIZE_MAP_PATH}: ${error.message}`);
  }
  return null;
}

function normalizeSize(value, sizeMap) {
  if (!sizeMap) return value;
  if (!isSingleNumericSize(value)) return value;
  const key = typeof value === 'number' ? String(value) : value.trim();
  return Object.prototype.hasOwnProperty.call(sizeMap, key) ? sizeMap[key] : value;
}

export function normalizeRows(rows) {
  const sizeMap = loadSizeMap();
  let startIndex = rows.findIndex(
    (row) => rowHasData(row) && isNumeric(row[2]) && isNumeric(row[3])
  );
  if (startIndex === -1) {
    startIndex = 0;
    const headerIndex = rows.findIndex((row) =>
      row.some((value) => String(value).includes('Номенклатура'))
    );
    if (headerIndex >= 0) {
      startIndex = headerIndex;
      while (startIndex < rows.length && rowHasData(rows[startIndex])) startIndex += 1;
      while (startIndex < rows.length && !rowHasData(rows[startIndex])) startIndex += 1;
    }
  }

  const groups = [];
  let current = [];
  for (let i = startIndex; i < rows.length; i += 1) {
    const row = rows[i] || [];
    if (!rowHasData(row)) {
      if (current.length) {
        groups.push(current);
        current = [];
      }
      continue;
    }
    current.push(row);
  }
  if (current.length) groups.push(current);

  const outputRows = [['розмір', 'ціна', 'назва', 'артикул']];

  for (const group of groups) {
    if (group.length < 2) continue;
    const rawName = cleanCell(group[0][1] ?? '');
    if (!rawName) continue;
    if (typeof rawName === 'string' && /^(итог|итого)$/i.test(rawName)) continue;

    const rawArticle = cleanCell(group[1]?.[1] ?? '');
    if (isHeaderLike(rawName) || isHeaderLike(rawArticle)) continue;
    const priceFallback = pickPrice(group[1]?.[3], group[0]?.[3]);
    const sizeRows = group.slice(2);

    if (!sizeRows.length) {
      outputRows.push(['', priceFallback ?? '', rawName, rawArticle]);
      continue;
    }

    for (const row of sizeRows) {
      const sizeCell = cleanCell(row[1] ?? '');
      const { articleSuffix, size, parsed } = splitArticleAndSize(sizeCell);
      const price = pickPrice(row?.[3], priceFallback);
      const article = parsed && articleSuffix ? `${rawArticle}-${articleSuffix}` : rawArticle;
      const normalizedSize = normalizeSize(size, sizeMap);
      outputRows.push([normalizedSize, price ?? '', rawName, article]);
    }
  }

  return outputRows;
}
