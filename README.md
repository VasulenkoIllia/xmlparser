## Огляд

Проєкт завантажує XML/XLSX прайс-фіди від постачальників, трансформує дані відповідно до конфігу та записує в Google Sheets через Service Account API. Підтримує 4 оновлення на добу з Telegram-сповіщеннями про помилки.

---

## Архітектура

```
services/
├── core/
│   ├── sheets.mjs          — спільні утиліти: Google Sheets API, lock, retry, helpers
│   └── telegram.mjs        — Telegram-сповіщення (помилки + підсумок)
├── run-service.mjs         — основний раннер фідів (XML/XLSX → Google Sheets)
├── run-normalize-sheet.mjs — нормалізація Google Sheet → Google Sheet (rabona)
├── run-all.mjs             — запускає всі фіди послідовно, шле підсумок у Telegram
├── registry.json           — реєстр всіх фідів (єдине місце для додавання нових)
├── *.json                  — конфіги постачальників (по одному файлу на кожного)
scripts/
├── inspect-feed.mjs        — інспектор фіду: аналізує і генерує готовий конфіг
├── normalize-core.mjs      — логіка нормалізації рядків (для rabona)
├── normalize-sheet.mjs     — CLI нормалізації Google Sheet
├── normalize-xls.mjs       — CLI нормалізації локального XLS
└── export-feed.mjs         — CLI експорту фіду в XLSX
```

---

## Змінні середовища (.env)

```bash
# ── Обов'язкові ───────────────────────────────────────────
GOOGLE_CLIENT_EMAIL=service-account@project.iam.gserviceaccount.com
GOOGLE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"

# ── Telegram (необов'язково, але рекомендовано) ────────────
# Отримати токен: @BotFather → /newbot
# Отримати chat_id: @userinfobot або додати бота в групу/канал
# Підтримка кількох отримувачів через кому:
TELEGRAM_BOT_TOKEN=123456789:ABC-DEFxxxxxxx
TELEGRAM_CHAT_ID=-1001234567890
# або кілька:
# TELEGRAM_CHAT_ID=111111111,222222222,@your_channel

# ── Автентифікація для окремих фідів ──────────────────────
ARNICA_LOGIN=your_login
ARNICA_PASSWORD=your_password

# ── Тюнінг (необов'язково, є дефолти) ─────────────────────
FEED_DELAY_MS=15000     # пауза між фідами в run-all (мс)
CHUNK_ROWS=1500         # рядків за один write-запит у Sheets
WRITE_RETRIES=3         # кількість спроб при помилці
RETRY_DELAY_MS=2000     # базова затримка між спробами (мс, з exp. backoff + jitter)
LOCK_TTL_HOURS=12       # через скільки годин вважати lock застарілим
```

---

## Telegram-сповіщення

| Подія | Повідомлення | Коли |
|-------|-------------|------|
| Помилка фіду | `❌ arnica_stock\nConnection timeout...` | Одразу при збої |
| 0 офферів | `⚠️ soccerlife\nFeed returned 0 offers` | Одразу |
| Підсумок (є помилки) | `⚠️ Оновлення завершено: 20/21 успішно\n✅ lispo...\n❌ arnica_stock...` | Після завершення run-all |
| Все ОК | — (мовчить) | — |

Якщо `TELEGRAM_BOT_TOKEN` або `TELEGRAM_CHAT_ID` не задані — сповіщення мовчки пропускаються.

---

## Розклад

4 запуски на добу (Europe/Kyiv). Кожен запуск виконує всі фіди **послідовно** з паузою `FEED_DELAY_MS` між ними:

```
00:00  →  run-all.mjs  (усі 21 фід, ~20 хв)
06:00  →  run-all.mjs
12:00  →  run-all.mjs
18:00  →  run-all.mjs
```

Послідовне виконання замість паралельного — навмисне: не перевантажує Google Sheets API (квота 300 req/хв) і не потребує ручного підбору хвилин запуску.

---

## Додавання нового постачальника

### Крок 1 — Інспекція фіду
```bash
node scripts/inspect-feed.mjs --url https://supplier.com/feed.xml --name new_supplier
# або для XLSX:
node scripts/inspect-feed.mjs --file ./download.xlsx --name new_supplier
```
Скрипт виведе структуру фіду та **готовий стартовий конфіг** — скопіюй і відкоригуй.

### Крок 2 — Зберегти конфіг
```bash
# Зберегти виведений конфіг:
node scripts/inspect-feed.mjs --url https://... --name new_supplier > services/new_supplier.json
# або вручну відредагувати services/new_supplier.json
```

### Крок 3 — Додати в реєстр
Один рядок у [`services/registry.json`](services/registry.json):
```json
{ "name": "new_supplier", "config": "services/new_supplier.json" }
```
Більше нічого не треба — docker-compose і package.json не чіпати.

### Крок 4 — Задеплоїти
```bash
docker compose up -d --build
```

---

## Конфіг постачальника (формат JSON)

```jsonc
{
  "name": "my_supplier",          // ідентифікатор (використовується в логах і Telegram)
  "feedUrl": "https://...",       // URL фіду (XML або XLSX)
  "sheetId": "GOOGLE_SHEET_ID",  // ID Google Sheets документу
  "sheetName": "offers",          // назва аркуша для запису

  // Необов'язкові:
  "sourceFormat": "xml",          // "xml" (дефолт), "xlsx", або RSS (auto-detect)
  // Підтримувані XML структури: yml_catalog, xml_catalog, shop, catalog,
  // products та Google Merchant RSS (rss → channel → item з g: namespace)
  "sourceSheetName": "Sheet1",    // для XLSX: назва аркуша в файлі
  "sourceHeaderRow": 3,           // для XLSX: рядок з заголовками (0-based)
  "chunkRows": 1500,              // рядків за один запит у Sheets
  "metaSheetName": "offers_meta", // назва мета-аркуша (дефолт: <sheetName>_meta)

  // Автентифікація (тільки для захищених фідів):
  "auth": {
    "type": "form",
    "loginUrl": "https://site.com/login",
    "usernameField": "email",
    "passwordField": "password",
    "tokenField": "_token",
    "username": "$SUPPLIER_LOGIN",   // бере з env
    "password": "$SUPPLIER_PASSWORD"
  },

  "columns": [ ... ]
}
```

### Типи колонок

| Тип | Призначення | Приклад |
|-----|-------------|---------|
| `field` | Поле з XML/XLSX (підтримує `from: ["field1","field2"]`, вкладені `prices.contract`) | `{"type":"field","header":"Ціна","from":["price"],"asNumber":true}` |
| `attribute` | XML-атрибут (`@_id`, `@_available`) | `{"type":"attribute","header":"ID","from":["id"]}` |
| `param` | XML `<param name="Розмір">` | `{"type":"param","header":"Розмір","names":["Розмір","Размер"]}` |
| `picture_image` | Формула `=IMAGE(url)`. За замовчуванням бере поле `<picture>`. Можна вказати `from` щоб брати з іншого поля (напр. `g:image_link`) | `{"type":"picture_image","header":"Фото","from":["g:image_link"]}` |
| `pictures` | Всі фото через `; ` | `{"type":"pictures","header":"Фото URLs"}` |
| `formula` | Excel-формула з підстановкою `{row}` | `{"type":"formula","header":"Дроп","template":"=B{row}*0.8"}` |
| `field_list` | Масив значень → один рядок | `{"type":"field_list","header":"Теги","from":["tags"],"separator":", "}` |

### Трансформації (опційно в будь-якій колонці)

| Опція | Дія |
|-------|-----|
| `asNumber: true` | Примусово числовий формат |
| `asText: true` | Вимкнути числовий режим (для артикулів, штрихкодів) |
| `valueMap: {...}` | Замінити значення за словником (напр. `"19.5 см": "32"`) |
| `valueMapNormalize: "size_cm"` | Нормалізація ключів мапи (підтримує `"size_cm"`, `"lower"`) |
| `insideParensOnly: true` | Залишити тільки текст у дужках: `"Nike (40)"` → `"40"` |
| `stripParens: true` | Видалити все в дужках: `"Nike (40)"` → `"Nike"` |
| `cleanContains: ["N/A"]` | Очистити поле якщо містить слово |
| `removeAfterLastSpace: true` | Видалити останнє слово: `"Nike 40"` → `"Nike"` |
| `extractNumber: true` | Витягти перше число з рядка: `"UAH 17500.00"` → `17500` (корисно для фідів де ціна містить валюту) |
| `explodeBySeparator: ";"` | Розбити значення і дублювати рядки по одному |
| `joinMatched: true` | (для param) зібрати всі значення з підходящим іменем |
| `ignoreValues: ["N/A"]` | Пропускати певні значення |

---

## Ручний запуск

```bash
# Один фід:
node services/run-service.mjs services/lispo.json

# Rabona (sheet → sheet):
node services/run-normalize-sheet.mjs services/rabona.json

# Всі фіди послідовно:
npm run run:all

# Dry-run (показати список без запуску):
npm run run:all:dry

# Конкретний фід через run-all:
node services/run-all.mjs --name lispo

# Інспекція нового фіду:
npm run inspect:feed -- --url https://supplier.com/feed.xml --name supplier_name

# Нормалізація локального XLS:
npm run normalize:xls -- input.xls output.xlsx
```

---

## Оновлення на сервері

```bash
# 1. Зайти на сервер
ssh user@your-server

# 2. Перейти в директорію проєкту
cd /path/to/xmlparser

# 3. Отримати зміни
git pull

# 4. Перебудувати і перезапустити (з downtime ~5 сек)
docker compose up -d --build

# Перевірити що все запустилось:
docker compose ps
docker logs feeds-runner --tail=50
docker logs ofelia --tail=20
```

---

## Meta-аркуш

Для кожного фіду автоматично підтримується аркуш `<sheetName>_meta`:

| Поле | Значення |
|------|---------|
| `last_update_date` | Дата останнього оновлення |
| `last_update_time` | Час останнього оновлення |
| `rows` | Кількість записаних рядків |

Комірка B1 підсвічується: **зелена** — оновлено сьогодні, **червона** — застаріло.

---

## Ліміти та застереження

- `picture_urls` може обрізатися Sheets якщо рядок > ~50KB (багато фото на офер).
- `soccerlife` може повертати HTTP 429 через anti-bot (`adm.tools`) в headless-середовищі без whitelist IP.
- Clear → write не атомарна операція: короткий момент порожнього аркуша між очисткою і записом.
- Великі фіди (>50k офферів) завантажуються повністю в пам'ять — потокового парсингу немає.
