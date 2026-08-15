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
| 0 офферів | `❌ soccerlife\nFeed returned 0 offers — refusing to overwrite the sheet.` | Одразу; фід переривається, аркуш лишається з попередніми даними |
| Підсумок (є помилки) | `⚠️ Оновлення завершено: 20/21 успішно\n✅ lispo...\n❌ arnica_stock...` | Після завершення run-all |
| Все ОК | — (мовчить) | — |

Якщо `TELEGRAM_BOT_TOKEN` або `TELEGRAM_CHAT_ID` не задані — сповіщення мовчки пропускаються.

---

## Розклад

4 запуски на добу (Europe/Kyiv). Кожен запуск виконує всі фіди **послідовно** з паузою `FEED_DELAY_MS` між ними:

```
00:00  →  run-all.mjs  (усі 22 фіди, ~20 хв)
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
  "feedUrl": "https://...",       // URL фіду (XML, XLSX або CSV)
  "sheetId": "GOOGLE_SHEET_ID",  // ID Google Sheets документу
  "sheetName": "offers",          // назва аркуша для запису

  // Необов'язкові:
  "sourceFormat": "xml",          // "xml" (дефолт), "xlsx", "csv", або RSS (auto-detect)
  // Підтримувані XML структури: yml_catalog, xml_catalog, shop, catalog,
  // products та Google Merchant RSS (rss → channel → item з g: namespace)
  // CSV: читається як UTF-8 текст (кирилиця коректна); заголовок = імена колонок,
  //      у `from` вказуй імена CSV-стовпців (напр. "title", "price", "mpn").
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

# Тестова вигрузка у ЛОКАЛЬНИЙ файл (нічого не пише в Google Sheets):
# проганяє реальний код (fetchOffers + buildRows) і зберігає результат у .xlsx.
# Зручно перевірити новий/змінений конфіг перед деплоєм.
DRY_RUN_FILE=~/Desktop/test.xlsx node services/run-service.mjs services/store221b.json

# Інспекція нового фіду:
npm run inspect:feed -- --url https://supplier.com/feed.xml --name supplier_name

# Нормалізація локального XLS:
npm run normalize:xls -- input.xls output.xlsx
```

---

## Деплой і оновлення на сервері

Сервер: `whitehall` (Hetzner, Ubuntu 26.04). Перенесено з `WorkfloMain` 08.08.2026.
Шлях проєкту незмінний: `/var/www/projects/xmlparser`.
Реальні хост/порт/користувач — в `ops/whitehall-migration.md` (поза git, репозиторій публічний).

### Схема деплою: код через git, документація — ні

Робоча копія на сервері — це **partial clone + sparse-checkout**. Оновлення йдуть через `git pull`, але markdown-файли на сервер не потрапляють:

| Механізм | Що дає |
|---|---|
| `git clone --filter=blob:none` | partial clone: git не завантажує вміст виключених файлів навіть у `.git` |
| `core.sparseCheckout=true`, `core.sparseCheckoutCone=false` | режим, який розуміє правила-заперечення |
| `.git/info/sparse-checkout` | сам список правил |
| правило `!*.md` | будь-який markdown з будь-якою назвою лишається поза сервером |
| правила `!/docs/`, `!/.idea/` | тека документації і конфіги IDE |

Виключені файли позначені в індексі як `S` (skip-worktree) — git про них знає, тому `git pull` не конфліктує і не намагається їх відновити.

Правило живе в `.git/info/sparse-checkout` **конкретного клону, не в репозиторії** — при переклонуванні його треба задати повторно.

Додатковий шар, який працює сам собою: [`Dockerfile`](Dockerfile) копіює в образ лише `package.json`, `services/`, `scripts/` — тому в контейнер документація не потрапляє в жодному разі.

### Оновлення (звичайний цикл)

```bash
cd /var/www/projects/xmlparser && git pull && docker compose up -d --build && docker compose ps
```

⚠️ **`--build` обовʼязковий.** `git pull` оновлює файли лише на хості; без перезбірки контейнер продовжує працювати зі старим кодом, вшитим в образ. Це найчастіша помилка при деплої цього проєкту.

Перевірка після оновлення:

```bash
docker compose ps && docker logs feeds-runner --tail=50 && docker logs ofelia --tail=20
```

### Правила роботи з сервером

1. **Не редагувати файли безпосередньо на сервері.** Sparse-checkout цьому не перешкоджає, але наступний `git pull` дасть конфлікт і прод розійдеться з репозиторієм. Цикл змін: локально → commit → push → `git pull` на сервері.
2. **Нову документацію класти в `docs/` або давати розширення `.md`** — обидва варіанти вже виключені правилом.
3. **Реальні доступи не комітити.** Репозиторій публічний.

### Первинне розгортання з нуля

```bash
cd /var/www/projects && git clone --filter=blob:none --no-checkout https://github.com/VasulenkoIllia/xmlparser.git xmlparser
```

```bash
cd /var/www/projects/xmlparser && git config core.sparseCheckout true && git config core.sparseCheckoutCone false && printf '/*\n!*.md\n!/docs/\n!/.idea/\n' > .git/info/sparse-checkout && git checkout main
```

Далі покласти `.env` (через `scp`, не копіпастом — у `GOOGLE_PRIVATE_KEY` є `\n`-послідовності), виставити `chmod 600`, і піднімати:

```bash
docker compose up -d --build
```

Перевірка, що документації на диску немає:

```bash
git ls-files -t | grep -E '^S'
```

### Тест одного фіду після деплою (без очікування cron)

```bash
# Реальна вигрузка одного фіду (пише в його Google-аркуш):
docker exec feeds-runner node services/run-all.mjs --name store221b
docker logs feeds-runner --tail=20
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
- **Ліміт комірки Google Sheets — 50 000 символів.** Один задовгий опис валить увесь запис фіду. Через це в `shopua` прибрано колонку `description`: товар `IN437551` мав опис на 61 425 символів і фід не оновлювався з 13.08.2026. Якщо додаєте колонку з описом — переконайтесь, що постачальник не пише в неї полотна.
- Порожній фід (0 офферів) навмисно перериває оновлення з помилкою, а не пише порожній аркуш — інакше `clear` + `write` затерли б дані попереднього прогону.
- `soccerlife` качається з `slife.ua/prom.xml` (заміна старого домену `soccerlife.com.ua`, який мав anti-bot `adm.tools`/HTTP 429); параметр розміру в новому фіді має єдину назву `Розмір`.
- Clear → write не атомарна операція: короткий момент порожнього аркуша між очисткою і записом.
- Великі фіди (>50k офферів) завантажуються повністю в пам'ять — потокового парсингу немає.
