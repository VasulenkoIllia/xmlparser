import 'dotenv/config';
import axios from 'axios';

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

// Підтримка кількох отримувачів: TELEGRAM_CHAT_ID=id1,id2,id3
// Можна використовувати: особистий чат, групу, канал (@channel_name або -100...)
const CHAT_IDS = (process.env.TELEGRAM_CHAT_ID || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

function configured() {
  return BOT_TOKEN && CHAT_IDS.length > 0;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

async function send(text) {
  if (!configured()) return;
  await Promise.all(
    CHAT_IDS.map((chat_id) =>
      axios
        .post(
          `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
          { chat_id, text, parse_mode: 'HTML' },
          { timeout: 10_000 }
        )
        .catch((err) => console.error(`[telegram] send to ${chat_id} failed:`, err.message))
    )
  );
}

export async function notifyError(feedName, err) {
  const msg = err?.message || String(err);
  const stack = err?.stack ? `\n\n<pre>${escapeHtml(err.stack.slice(0, 600))}</pre>` : '';
  await send(`❌ <b>${escapeHtml(feedName)}</b>\n${escapeHtml(msg)}${stack}`);
}

export async function notifyWarn(feedName, message) {
  await send(`⚠️ <b>${escapeHtml(feedName)}</b>\n${escapeHtml(message)}`);
}

export async function notifySummary(results) {
  const ok   = results.filter((r) => r.ok).length;
  const fail = results.filter((r) => !r.ok).length;
  const icon = fail > 0 ? '⚠️' : '✅';

  const lines = results.map((r) => {
    const dur  = r.duration ? ` ${(r.duration / 1000).toFixed(1)}с` : '';
    const rows = r.rows != null ? ` (${r.rows} рядків)` : '';
    return r.ok
      ? `✅ ${escapeHtml(r.name)}${rows}${dur}`
      : `❌ ${escapeHtml(r.name)}: ${escapeHtml(r.error || 'failed')}`;
  });

  await send(`${icon} <b>Оновлення завершено</b>: ${ok}/${ok + fail} успішно\n\n${lines.join('\n')}`);
}
