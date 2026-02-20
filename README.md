## Overview
- Проєкт тягне YML/EML фіди, трансформує у потрібні колонки і пише в окремі Google Sheets через Service Account.
- Є окремий раннер для нормалізації листа з однієї таблиці у іншу (rabona), з meta-аркушем як у фідів.
- Є 14 сервісних профілів (lispo, clsport, gorgany_alpha, lekos, og_shop, roksana_shop, niala, atlantmarket, markshop, powerplay, 7tonn, bagland, uabest, arnica_stock); легко додати нові через JSON-конфіг.
- Оновлення запускаються контейнером `feeds-runner`, а розклад керує `ofelia` (cron усередині Docker).

## Структура
- `services/run-service.mjs` — основний раннер: тягне фід, будує рядки, ретраїть усі виклики Sheets, оновлює meta-аркуш, ставить лок-файл щоб уникати паралельних запусків одного фіда (з перевіркою PID і TTL).
- `services/run-normalize-sheet.mjs` — нормалізує лист у окрему таблицю, оновлює meta-аркуш, має лок-файл.
- `services/lispo.json` / `services/clsport.json` / `services/gorgany_alpha.json` — конфіги існуючих фідів.
- `services/niala.json` / `services/atlantmarket.json` / `services/markshop.json` / `services/powerplay.json` / `services/roksana_shop.json` — додаткові конфіги фідів.
- `services/lekos.json` — фід lekos → sheet `1yILFZTbFI-8adJz_0_ukL8fz4eQb_lt5KwWAT2zY0bE`, колонки `id(@_id), name, price, available(@_available), picture_urls, price_partner, stock_quantity, vendor`.
- `services/rabona.json` — нормалізація Google Sheets (source → target).
- `services/og_shop.json` — фід og-shop → sheet `1naPf2qk72InlwiR3mt_1ZOZeBKjRa1iZbVVz8lefiTI`, колонки `name, price, Дроп=price*0,9, vendorCode, quantity_in_stock, param:Размер, vendor`.
- `services/7tonn.json` / `services/bagland.json` / `services/uabest.json` / `services/arnica_stock.json` — нові конфіги фідів.
- `docker-compose.yml` — збірка/запуск контейнерів `feeds-runner` і `ofelia`, розклад (щодня 00:05–00:19 Europe/Kyiv, 6-польовий cron).
- `Dockerfile` — образ на node:18-alpine, тягне прод-залежності, копіює `services/`.
- `.env` (локально, не в репо) — креденшіали сервісного акаунта (`GOOGLE_CLIENT_EMAIL`, `GOOGLE_PRIVATE_KEY`, опц. `GOOGLE_PRIVATE_KEY_ID`, `WRITE_RETRIES`, `RETRY_DELAY_MS`), а також `LOCK_TTL_HOURS` (дефолт 12). Для `arnica_stock` додатково: `ARNICA_LOGIN`, `ARNICA_PASSWORD`. Для моніторингу нових фідів: `STATUS_PING_7TONN`, `STATUS_PING_BAGLAND`, `STATUS_PING_UABEST`, `STATUS_PING_ARNICA_STOCK`.

## Колонки й трансформації
Типи колонок у конфіг-JSON:
- `field`: бере перше непорожнє поле з `from` (підтримує вкладені ключі через крапку, наприклад `prices.contract`).
- `attribute`: те саме, але з атрибутів (`@_`), або `key`.
- `param`: бере перший param з імен із `names`.
- `picture_image`: формула `=IMAGE(<перше фото>)`.
- `pictures`: усі фото, з’єднані через `; `.
- `formula`: підставляє номер рядка (`{row}`) у `template` і записує формулу (наприклад `=D{row}*(1-F{row}/100)` або `=A{row}*0,8`).
Post-обробка (опційна в колонці):  
`insideParensOnly` — залишає текст всередині перших дужок.  
`stripParens` — видаляє всі дужки з вмістом.  
`cleanContains` — якщо значення містить рядок зі списку, очищує поле.

Специфіка поточних фідів:
- lispo: `Розмір` бере вміст у дужках; колонка `Дроп` = `price * 0,8`.
- clsport: `Розмір` видаляє все в дужках і чистить рядки зі словом “Розмір/Размер/Розмер`.
- gorgany_alpha: фід `https://gorgany.eu/xmlxls/all_xml_alpha.xml`; колонки `id, name, price, rrc, SIZE, Spec, Дроп`, де `Дроп = D*(1-F/100)`.
- lekos: фід `https://lekos.com.ua/partner/`; колонки `id(@_id), name, price, available(@_available), picture_urls, price_partner, stock_quantity, vendor`.
- og_shop: фід `https://og-shop.in.ua/xml/out.php`; колонки `name, price, Дроп=B*0,9, vendorCode, quantity_in_stock, param(Размер), vendor`.
- niala: фід `https://niala.com.ua/xml/ac/niala-3205010.xml`; колонки `name, price, vendorCode, quantity_in_stock, picture, param:Размер, param:Цвет, vendor`.
- atlantmarket: фід `https://atlantmarket.com.ua/price1/prom/atlantmarketprom(false).xml`; колонки `name, price, available(@_available), picture, barcode, param:Розмір, vendor`.
- markshop: фід `https://markshop.kiev.ua/plugins/mark/feed/white.xml`; колонки `price, vendorCode, quantity_in_stock, picture, name_ua, param:Цвет, param:Размер, vendor`.
- powerplay: фід `https://powerplay.com.ua/products_feed.xml?...`; колонки `name, price, vendorCode, quantity_in_stock, picture, param:Размер, param:Цвет, vendor`.
- 7tonn: фід `https://7tonn.com.ua/index.php?route=account/product_export/download&filter_quantity=1&export_format=xml`; колонки `name, quantity, picture, drop_price, model, param:Розмір, param:Колір, vendor`.
- bagland: фід `https://www.baglandopt.com.ua/content/export/ed673ce6583a077e89c7f1ee8ed7ea02.xml`; колонки `name, price, vendorCode, available(@_available), picture, param:Цвет, vendor`.
- uabest: фід `https://uabest.com.ua/content/export/f3c3a6750fc5783821bd896ea6f5dba3.xml`; колонки `name, price, vendorCode, quantity_in_stock, picture, vendor`.
- arnica_stock: фід `https://clients.arnica.com.ua/client/downloads/stock/arnica_stock.xml` (через form-login); колонки `name, quantity, color, barcode, contract, wholesale, semi_wholesale, retail, retail_discount, retail_discount_price, size, type, vendor, vendor_code`.

Meta-аркуш `<sheetName>_meta`:
- Пише `last_update_date`, `last_update_time`, `rows`.
- Conditional formatting на B1: зелена — якщо дата сьогодні, червона — якщо ні.

Ретраї та безпека:
- Всі мережеві виклики (fetch, get/batchUpdate, clear, write chunks, meta) з ретраями (дефолт 3, 2s * 2^(n-1)).
- Лок-файл у `/tmp/feed-lock-<name>.lock` не дає двом запускати один фід одночасно; містить PID і timestamp, мертвий PID lock перевідкривається одразу, stale-lock видаляється після `LOCK_TTL_HOURS`.
- TZ задається через `TZ` (compose ставить Europe/Kyiv); дата/час у meta формуються з урахуванням TZ.

## Запуск у Docker
1. Створи зовнішню мережу Traefik за потреби (`docker network create traefik`) або залиш без неї.
2. Поклади `.env` поруч із `docker-compose.yml` (тільки креденшіали та, опційно, налаштування ретраїв).
3. `docker compose up -d --build`
4. Ofelia всередині складу виконує:
   - lispo — щодня 00:05 Europe/Kyiv (cron: `0 5 0 * * *`)
   - clsport — щодня 00:06 Europe/Kyiv (cron: `0 6 0 * * *`)
   - gorgany_alpha — щодня 00:07 Europe/Kyiv (cron: `0 7 0 * * *`)
   - lekos — щодня 00:08 Europe/Kyiv (cron: `0 8 0 * * *`)
   - og_shop — щодня 00:09 Europe/Kyiv (cron: `0 9 0 * * *`)
   - roksana_shop — щодня 00:10 Europe/Kyiv (cron: `0 10 0 * * *`)
   - niala — щодня 00:11 Europe/Kyiv (cron: `0 11 0 * * *`)
   - atlantmarket — щодня 00:12 Europe/Kyiv (cron: `0 12 0 * * *`)
   - markshop — щодня 00:13 Europe/Kyiv (cron: `0 13 0 * * *`)
   - powerplay — щодня 00:14 Europe/Kyiv (cron: `0 14 0 * * *`)
   - rabona — щодня 00:15 Europe/Kyiv (cron: `0 15 0 * * *`)
   - 7tonn — щодня 00:16 Europe/Kyiv (cron: `0 16 0 * * *`)
   - bagland — щодня 00:17 Europe/Kyiv (cron: `0 17 0 * * *`)
   - uabest — щодня 00:18 Europe/Kyiv (cron: `0 18 0 * * *`)
   - arnica_stock — щодня 00:19 Europe/Kyiv (cron: `0 19 0 * * *`)
   - вебхуки сповіщень (up/down ping): lispo `OzF3oV9VSw`, clsport `JgIPE6I5H2`, gorgany_alpha `gZf0qECvmI`, lekos `N1kyaEQFBO`, og_shop `bwSm9221oi`, roksana_shop `m3gaKHNfDc`, rabona `67vFtA8We9`, niala `pStJOiLW3w`, atlantmarket `DFNM6zIb35`, markshop `wibOIypj0X`, powerplay `3hBBC8fLUc`; для 7tonn/bagland/uabest/arnica_stock використовуються env-змінні `STATUS_PING_7TONN`, `STATUS_PING_BAGLAND`, `STATUS_PING_UABEST`, `STATUS_PING_ARNICA_STOCK`.

## Додавання нового фіда
1. Скопіюй існуючий конфіг у `services/<new>.json`.
2. Заповни `feedUrl`, `sheetId`, `sheetName`, при потребі налаштуй `columns`, розклад у `docker-compose.yml` (новий job-ofelia).
3. Запусти: `node services/run-service.mjs services/<new>.json` (локально з .env) або додай job-лейбл і перезапусти `docker compose up -d`.

## Ручний запуск локально
```
GOOGLE_CLIENT_EMAIL=... \
GOOGLE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n... \n-----END PRIVATE KEY-----\n" \
node services/run-service.mjs services/lispo.json
# або
node services/run-service.mjs services/gorgany_alpha.json
# або
node services/run-service.mjs services/lekos.json
# або
node services/run-service.mjs services/og_shop.json
# або
node services/run-service.mjs services/7tonn.json
# або
node services/run-service.mjs services/bagland.json
# або
node services/run-service.mjs services/uabest.json
# або (потрібні ARNICA_LOGIN та ARNICA_PASSWORD у .env)
node services/run-service.mjs services/arnica_stock.json
# або
node services/run-normalize-sheet.mjs services/rabona.json
```

## Ліміти та застереження
- `picture_urls` може обрізатися Sheets, якщо рядок > ~50k символів (багато фото).
- Safe-write поки не реалізований: clear → write. Якщо потрібна атомарність — варто писати у тимчасовий аркуш і міняти місцями.
- Потокового парсингу нема: на дуже великих фідах доведеться перейти на SAX/stream і записувати чанками під час парсу.
