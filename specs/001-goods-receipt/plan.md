# 001 — План реалізації

Супровід до [spec.md](./spec.md). Тут — як, і чому саме так.

## Граф

LangGraph 1.5.1, `StateGraph`. Сім вузлів; модель працює у трьох. У `match` це
System One (Jev), коли є ключ, інакше чат-модель — контракт у них однаковий.

```
START → dedupe → extract ⟲ → match → validate ─┬ чисто ────→ commit ─┬→ END
           │       (ретрай ребром,    (аляс →   │                     └→ explain → END
           └→ END   макс 2 спроби)     Jev)     └ блокуючі → review ⏸ ┤
       (тред уже                                                      └→ explain → END
        закритий)
```

| Вузол | LLM | Робить |
|---|---|---|
| `dedupe` | — | тред уже закритий? тоді END, не витрачаючи ні LLM, ні мережі |
| `extract` | ✅ | текст → JSON за zod-схемою; помилка схеми повертає ребро на себе |
| `match` | ✅ | аляс → Jev: Choice по всьому каталогу + Noul на наявність; без ключа — шортліст top-5 і чат-модель |
| `validate` | — | R1–R10 → `issues[]` |
| `review` | — | `interrupt()`, чекає рішення людини |
| `commit` | — | транзакція: `receipt` + `receipt_line` + аляси |
| `explain` | ✅ | текст акта розбіжностей для постачальника |

`intake` вузлом не став: `thread_id` рахується з вмісту файлу, а він потрібен **до**
запуску графа, щоб вибрати тред. Тому інтейк — межа перед графом (`intake.mjs`, кличе CLI).
`route` теж не вузол, а умовні ребра: у LangGraph маршрутизація — це функція на ребрі.

## Стан

```js
{
  threadId, source: { path, kind },            // kind: "txt" | "xlsx" | "pdf" | "scan" | "image"
  raw:     { text } | { rows },
  doc:     { supplierEdrpou, storeCode, docNumber, docDate,
             pricesIncludeVat, totalKop,
             lines: [{ rawName, qty, unit, priceKop, expiresOn }] },
  supplierId, storeId, poId,
  matched: [{ lineIdx, skuId, confidence, via }],   // via: "alias" | "llm"
  issues:  [{ lineIdx, code, detail, blocking }],
  attempt,                                      // спроби extract, ліміт 2
  decision: null | { action, lines },            // action: approve | reject | partial
  receiptId, actId, status
}
```

`status`: `extracted` → `validated` → `posted` | `partial` | `rejected` | `duplicate` | `failed`.

## Модулі

```
supply.mjs                  точка входу → src/cli.mjs
src/llm.mjs                 обв'язка opencode (перенесена з гілки node), модель параметром
src/text.mjs                чисті хелпери: копійки, нормалізація назв, токени
src/explain.mjs             текст акта розбіжностей + людські назви кодів причин
src/db.mjs                  node:sqlite: схема, міграція, seed, запити, шим чекпойнтера
src/intake.mjs              txt/xlsx/pdf → raw, нормалізація, хеш; скан і фото → text: null
src/ocr.mjs                 скан і фото → сторінки → транскрипція чат-моделлю
src/extract.mjs             промпт + zod-схема + ретрай
src/match.mjs               нормалізатор назв, шортліст, вибір через LLM, аляси
src/validate.mjs            чиста функція (doc, context) => issues[]
src/graph.mjs               StateGraph; фабрика приймає { model, db }
src/cli.mjs                 intake | review | resume
```

**`validate.mjs` не знає ні про БД, ні про LLM.** Він отримує документ і контекст
(SKU, протоколи, PO) як дані й повертає масив розбіжностей. Саме тому R1–R10
перевіряються десятком рядків тесту без жодного мока.

**`graph.mjs` експортує фабрику, не готовий граф.** Модель і БД приходять аргументами —
тест підставляє `FakeListChatModel` і БД в пам'яті без `jest.unstable_mockModule`.
Ця інверсія — єдине, що робить тести на ESM безболісними.

## Схема БД

Один файл `supply.db`, один драйвер `node:sqlite` — і на бізнес-дані, і на чекпойнти
LangGraph.

```sql
store(id, code UNIQUE, name)
supplier(id, edrpou UNIQUE, name)
sku(id, code UNIQUE, name, unit, pack_size, vat_rate, shelf_life_days, min_shelf_pct)
price_protocol(id, supplier_id, sku_id, price_net_kop, valid_from, valid_to)
po(id, number, store_id, supplier_id, created_at)
po_line(id, po_id, sku_id, qty)

sku_alias(supplier_id, raw_name_normalized, sku_id, created_at)
  UNIQUE(supplier_id, raw_name_normalized)

receipt(id, thread_id, supplier_id, store_id, doc_number, doc_date,
        total_net_kop, status, created_at)
  UNIQUE(supplier_id, doc_number, doc_date)
receipt_line(id, receipt_id, sku_id, raw_name, qty, price_net_kop)

discrepancy_act(id, thread_id, receipt_id NULL, message, created_at)
discrepancy_line(id, act_id, line_idx, raw_name, reason_code, detail)

review_queue(thread_id PRIMARY KEY, store_code, supplier_name, issues_count,
             created_at, status)
```

`review_queue` — тільки проєкція для CLI. Істина про стан графа живе в таблицях
чекпойнтера; черга потрібна, щоб `review` не читав чекпойнти руками.

## Ідемпотентність

Два рівні, бо вони ловлять різні випадки:

1. **`thread_id = sha256(нормалізований вміст)` + вузол `dedupe`.** Тут план був
   помилковий: вважалося, що самого `thread_id` досить, бо LangGraph «підхопить той самий
   тред». Насправді він підхоплює лише **незавершений** тред; завершений проганяється
   заново з START. Тому на вході стоїть `dedupe`: якщо по цьому треду вже є накладна або
   акт, прогін закінчується одразу, без витрат на LLM.
2. **`UNIQUE(supplier_id, doc_number, doc_date)` на `receipt`.** Той самий документ
   прийшов двома каналами (лист і xlsx) — хеші різні, тред інший, але БД не дасть
   провести його двічі. Статус треда стає `duplicate`.

## Рішення і відкинуті варіанти

| Рішення | Чому не інакше |
|---|---|
| промпт + zod + ретрай замість `withStructuredOutput()` | шлюз `opencode-go` може не тримати function-calling чи `response_format: json_schema`, і дізнались би ми це в найгірший момент. Якщо тримає — заміна на три рядки. |
| ретрай витягу — ребро графа, не цикл усередині вузла | спроба лягає в чекпойнт окремо, тому падіння шлюзу на другій не губить першу, і ретрай переживає рестарт процесу. Ціна: `extract()` став односпробовим, а ліміт живе в графі. |
| текст акта має детермінований запас | до `explain` накладна вже проведена. Втратити прогін через те, що генератор тексту відвалився, було б смішно, тому при помилці моделі віддається таблиця розбіжностей як є. |
| детермінований шортліст + вибір LLM | весь каталог у промпті ламається після ~200 SKU й недетермінований; чистий fuzzy без LLM не бере «900г» проти «0,9л». |
| шортліст на схожості токенів, не на embeddings | embeddings тягнуть модель на 120 МБ і час на CPU. Шортліст — окрема функція, тому заміна на embeddings — це заміна однієї функції. |
| аляс на пару (постачальник, назва) | глобальний аляс тихо підставить чужий SKU, і помилка стане детермінованою — тобто повторюватиметься й ніколи не буде помічена. |
| аляс пише тільки людина | аляс із рішення LLM закріплює галюцинацію назавжди. |
| аляс вчиться і з рядків, відкинутих не через зіставлення | знайдено на живому прогоні: рядок відкинули через ціну, зіставлення було правильне, але аляс не народився — і наступна така накладна знову витрачала виклик LLM. Межа обережності лишилась: `no_sku_match` і рядок, виключений без жодної розбіжності, не вчать. |
| у листі дві підписані суми | теж із живого прогону: лист про часткове приймання писав «Підсумок документа: 3793,60», хоча прийнято було 2596,00. Сума за документом ще й буває з ПДВ, а прийнята завжди без. |
| `node:sqlite` на все + шим під офіційний чекпойнтер | планували навпаки — `better-sqlite3` на все, бо офіційний `SqliteSaver` залежить від нього. Але тут нативний модуль не збирається: `node-gyp rebuild` без тулчейна, а install-скрипти npm заблоковані. Виявилось, що `SqliteSaver` приймає готовий `db` у конструктор і чіпає лише `pragma/exec/prepare/transaction`, а падає нативний бінд тільки в конструкторі `better-sqlite3` — тобто імпорт пакета живий. Тому драйвер стдлібний, логіка чекпойнтера офіційна, між ними ~20 рядків шима в `db.mjs`. `SqliteSaver.fromConnString` викликати не можна. Бонус: нуль нативних збірок і одне з'єднання на обидві ролі. |
| `exceljs` | `node-xlsx` був лінивішим (одна функція, масив масивів), але тягне SheetJS тарболом з `cdn.sheetjs.com`, а npm тут відмовляє remote-тарболам (`EALLOWREMOTE`). SheetJS на самому npm заморожений на 0.18.5. Ціна переходу: 8+ залежностей і важчий API. |
| `unpdf` + `@napi-rs/canvas` для PDF і фото | текстовий шар PDF у стдліб не дістати, а скан треба відрендерити в картинку. `@napi-rs/canvas` нативний, але ставиться готовим бінарником через optionalDependencies, без install-скрипта, тому обмеження вище на нього не поширюється — перевірено. Окремого OCR немає: обидві моделі шлюзу приймають зображення й на фікстурі прочитали цифри без помилок. `tesseract.js` не міряли — він потягнув би мовні дані й окремий крок, а потреби поки не видно. |
| `heic-decode` для HEIC | айфон знімає в HEIC, а ні шлюз, ні Skia під canvas його не читають. Це libheif у WebAssembly: без нативних збірок, поворот із контейнера застосовує сам — перевірено файлом із боксом `irot`. Поворот JPEG з EXIF canvas застосовує сам — теж перевірено. Енкодера HEIC немає ніде під рукою, тому фікстуру збирає `fixtures/make-heic.mjs`: ffmpeg кодує HEVC, а контейнер HEIF складається боксами вручну. |
| ціни цілими копійками | `0.1 + 0.2 !== 0.3` у R1 = відмова в прийманні на копійку з повітря. |
| відкинуті рядки закривають тред | інакше черга review стає звалищем, з якого ніхто нічого не прибирає. |
| eval не є Jest-тестом | якість LLM — це число, за яким дивляться, а не червоний білд. |

## Тести

| Рівень | Що | Мережа |
|---|---|---|
| unit | `validate` (R1–R10 окремо), нормалізатор, шортліст, парсер копійок, xlsx, ідемпотентність | ні |
| граф e2e | повний прогін на моделі за сценарієм + БД у пам'яті: автокоміт, зупинка на review, resume трьома способами, дубль, падіння шлюзу, інший процес | ні |
| CLI | три команди на тимчасовому файлі БД, вивід перевіряється як текст | ні |

Jest 30 через `node --experimental-vm-modules node_modules/jest/bin/jest.js` (так
працює і на Windows, без `cross-env`). Моків немає — усе через інверсію залежності в
`graph.mjs` і `cli.mjs`.

Модель у тестах — власний `Scripted` із `tests/helpers.mjs`, а не `FakeListChatModel`:
останній крутить список відповідей по колу, тому зайвий виклик моделі пройшов би
непоміченим, а в графі цікава саме їх кількість (тест на аляси вимагає рівно одного).
`FakeListChatModel` лишився там, де порядок простий — у тестах `extract` і `match`.

## Спостережуваність

`console.error` із міткою вузла на вхід і вихід кожного кроку:
`[match] 12 рядків: 9 alias, 2 llm, 1 no_match`. OpenTelemetry/LangSmith — коли буде куди
дивитись; зараз це був би конфіг без читача.
