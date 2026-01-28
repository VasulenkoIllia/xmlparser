## Overview
- Проєкт тягне YML/EML фіди, трансформує у потрібні колонки і пише в окремі Google Sheets через Service Account.
- Є два сервісні профілі (lispo, clsport); легко додати нові через JSON-конфіг.
- Оновлення запускаються контейнером `feeds-runner`, а розклад керує `ofelia` (cron усередині Docker).

## Структура
- `services/run-service.mjs` — основний раннер: тягне фід, будує рядки, ретраїть усі виклики Sheets, оновлює meta-аркуш, ставить лок-файл щоб уникати паралельних запусків одного фіда.
- `services/lispo.json` / `services/clsport.json` — конфіги фідів (URL, цільовий аркуш, колонки, поведінка розміру).
- `docker-compose.yml` — збірка/запуск контейнерів `feeds-runner` і `ofelia`, розклад (щодня 00:05 Europe/Kyiv).
- `Dockerfile` — образ на node:18-alpine, тягне прод-залежності, копіює `services/`.
- `.env` (локально, не в репо) — креденшіали сервісного акаунта (`GOOGLE_CLIENT_EMAIL`, `GOOGLE_PRIVATE_KEY`, опц. `GOOGLE_PRIVATE_KEY_ID`, `WRITE_RETRIES`, `RETRY_DELAY_MS`).

## Колонки й трансформації
Типи колонок у конфіг-JSON:
- `field`: бере перше непорожнє поле з `from`.
- `attribute`: те саме, але з атрибутів (`@_`), або `key`.
- `param`: бере перший param з імен із `names`.
- `picture_image`: формула `=IMAGE(<перше фото>)`.
- `pictures`: усі фото, з’єднані через `; `.
Post-обробка (опційна в колонці):  
`insideParensOnly` — залишає текст всередині перших дужок.  
`stripParens` — видаляє всі дужки з вмістом.  
`cleanContains` — якщо значення містить рядок зі списку, очищує поле.

Специфіка поточних фідів:
- lispo: `Розмір` бере вміст у дужках, якщо є; інакше залишає значення.
- clsport: `Розмір` видаляє все в дужках і чистить рядки зі словом “Розмір/Размер/Розмер”.

Meta-аркуш `<sheetName>_meta`:
- Пише `last_update_date`, `last_update_time`, `rows`.
- Conditional formatting на B1: зелена — якщо дата сьогодні, червона — якщо ні.

Ретраї та безпека:
- Всі мережеві виклики (fetch, get/batchUpdate, clear, write chunks, meta) з ретраями (дефолт 3, 2s * 2^(n-1)).
- Лок-файл у `/tmp/feed-lock-<name>.lock` не дає двом запускати один фід одночасно.

## Запуск у Docker
1. Створи зовнішню мережу Traefik за потреби (`docker network create traefik`) або залиш без неї.
2. Поклади `.env` поруч із `docker-compose.yml` (тільки креденшіали та, опційно, налаштування ретраїв).
3. `docker compose up -d --build`
4. Ofelia всередині складу виконує:
   - lispo — щодня 00:05 Europe/Kyiv
   - clsport — щодня 00:05 Europe/Kyiv

## Додавання нового фіда
1. Скопіюй існуючий конфіг у `services/<new>.json`.
2. Заповни `feedUrl`, `sheetId`, `sheetName`, при потребі налаштуй `columns`, розклад у `docker-compose.yml` (новий job-ofelia).
3. Запусти: `node services/run-service.mjs services/<new>.json` (локально з .env) або додай job-лейбл і перезапусти `docker compose up -d`.

## Ручний запуск локально
```
GOOGLE_CLIENT_EMAIL=... \
GOOGLE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n... \n-----END PRIVATE KEY-----\n" \
node services/run-service.mjs services/lispo.json
```

## Ліміти та застереження
- `picture_urls` може обрізатися Sheets, якщо рядок > ~50k символів (багато фото).
- Safe-write поки не реалізований: clear → write. Якщо потрібна атомарність — варто писати у тимчасовий аркуш і міняти місцями.
- Потокового парсингу нема: на дуже великих фідах доведеться перейти на SAX/stream і записувати чанками під час парсу.
