# 001 — План реалізації

Супровід до [spec.md](./spec.md). Тут — як, і чому саме так.

## Граф

LangGraph 1.5.1, `StateGraph`. Вісім вузлів; LLM працює у трьох.

```
intake ──> extract ──> match ──> validate ──> route
             ↑ ⟲                                │
          (zod invalid,                         ├── чисто ──────> commit ──> done
           max 2 спроби)                        │                   ↑
                                                └── є блокуючі ──> review ⏸
                                                                     │
                                                              ┌──────┴──────┐
                                                        approve/lines    reject
                                                              │              │
                                                              └──> commit    │
                                                                     │       │
                                                                     └──> explain ──> done
```

| Вузол | LLM | Робить |
|---|---|---|
| `intake` | — | формат (txt/xlsx) → нормалізований вміст, `sha256`, `thread_id` |
| `extract` | ✅ | текст → JSON за zod-схемою; ретрай із текстом помилки |
| `match` | ✅ | аляс або шортліст top-5 → вибір SKU + confidence |
| `validate` | — | R1–R10 → `issues[]` |
| `route` | — | умовне ребро: блокуючі є чи немає |
| `review` | — | `interrupt()`, чекає рішення людини |
| `commit` | — | транзакція: `receipt` + `receipt_line` + аляси |
| `explain` | ✅ | текст акта розбіжностей для постачальника |

## Стан

```js
{
  threadId, source: { path, kind },            // kind: "txt" | "xlsx"
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
src/db.mjs                  node:sqlite: схема, міграція, seed, запити, шим чекпойнтера
src/intake.mjs              txt/xlsx → raw, нормалізація, хеш
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

1. **`thread_id = sha256(нормалізований вміст)`.** Переслали той самий лист — LangGraph
   підхоплює той самий тред замість нового прогону. Ретрай листа безкоштовний: він
   продовжує стару роботу, а не починає нову.
2. **`UNIQUE(supplier_id, doc_number, doc_date)` на `receipt`.** Той самий документ
   прийшов двома каналами (лист і xlsx) — хеші різні, тред інший, але БД не дасть
   провести його двічі. Статус треда стає `duplicate`.

## Рішення і відкинуті варіанти

| Рішення | Чому не інакше |
|---|---|
| промпт + zod + ретрай замість `withStructuredOutput()` | шлюз `opencode-go` може не тримати function-calling чи `response_format: json_schema`, і дізнались би ми це в найгірший момент. Якщо тримає — заміна на три рядки. |
| детермінований шортліст + вибір LLM | весь каталог у промпті ламається після ~200 SKU й недетермінований; чистий fuzzy без LLM не бере «900г» проти «0,9л». |
| шортліст на схожості токенів, не на embeddings | embeddings тягнуть модель на 120 МБ і час на CPU. Шортліст — окрема функція, тому заміна на embeddings — це заміна однієї функції. |
| аляс на пару (постачальник, назва) | глобальний аляс тихо підставить чужий SKU, і помилка стане детермінованою — тобто повторюватиметься й ніколи не буде помічена. |
| аляс пише тільки людина | аляс із рішення LLM закріплює галюцинацію назавжди. |
| `node:sqlite` на все + шим під офіційний чекпойнтер | планували навпаки — `better-sqlite3` на все, бо офіційний `SqliteSaver` залежить від нього. Але тут нативний модуль не збирається: `node-gyp rebuild` без тулчейна, а install-скрипти npm заблоковані. Виявилось, що `SqliteSaver` приймає готовий `db` у конструктор і чіпає лише `pragma/exec/prepare/transaction`, а падає нативний бінд тільки в конструкторі `better-sqlite3` — тобто імпорт пакета живий. Тому драйвер стдлібний, логіка чекпойнтера офіційна, між ними ~20 рядків шима в `db.mjs`. `SqliteSaver.fromConnString` викликати не можна. Бонус: нуль нативних збірок і одне з'єднання на обидві ролі. |
| `exceljs` | `node-xlsx` був лінивішим (одна функція, масив масивів), але тягне SheetJS тарболом з `cdn.sheetjs.com`, а npm тут відмовляє remote-тарболам (`EALLOWREMOTE`). SheetJS на самому npm заморожений на 0.18.5. Ціна переходу: 8+ залежностей і важчий API. |
| ціни цілими копійками | `0.1 + 0.2 !== 0.3` у R1 = відмова в прийманні на копійку з повітря. |
| відкинуті рядки закривають тред | інакше черга review стає звалищем, з якого ніхто нічого не прибирає. |
| eval не є Jest-тестом | якість LLM — це число, за яким дивляться, а не червоний білд. |

## Тести

| Рівень | Що | Мережа |
|---|---|---|
| unit | `validate` (R1–R10 окремо), нормалізатор, шортліст, парсер копійок, xlsx, ідемпотентність | ні |
| граф e2e | повний прогін на `FakeListChatModel` + БД у пам'яті: автокоміт, зупинка на review, resume трьома способами, дубль | ні |

Jest 30 з `NODE_OPTIONS=--experimental-vm-modules`. Моків немає — усе через інверсію
залежності в `graph.mjs`.

## Спостережуваність

`console.error` із міткою вузла на вхід і вихід кожного кроку:
`[match] 12 рядків: 9 alias, 2 llm, 1 no_match`. OpenTelemetry/LangSmith — коли буде куди
дивитись; зараз це був би конфіг без читача.
