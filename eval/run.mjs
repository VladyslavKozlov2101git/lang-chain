/**
 * Eval: наскільки стабільно модель читає накладну й зіставляє позиції.
 *
 * Це не тест і не частина `npm test`: якість LLM — число, за яким дивляться, а не
 * червоний білд. Один прогін доводить, що так *буває*; повтори показують, чи так
 * *буде*. Тому тут не pass/fail, а розкид по N повторах.
 *
 *   npm run eval -- --check                     лише перевірити золоті дані, без мережі
 *   npm run eval -- --repeats 3                 усі кейси по 3 прогони
 *   npm run eval -- --case pdv,r01-price -r 5   два кейси по 5
 *   npm run eval -- --judge -r 3                зіставлення через System One
 *
 * `--judge` міняє лише матчинг: витяг в обох шляхах однаковий, тому різниця в
 * колонці SKU і в часі — це різниця матчерів. Порівнювати два прогони можна лише
 * один по одному в одній сесії: латентність шлюзу гуляє втричі між сесіями (T13).
 *
 * Міряються лише стохастичні кроки — `extract` і `match`. `validate` детермінований,
 * його семплювати нема сенсу: він уже покритий unit-тестами.
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { allSkus, openDb, seedDb } from "../src/db.mjs";
import { extract, ExtractError } from "../src/extract.mjs";
import { intake } from "../src/intake.mjs";
import { transcribe } from "../src/ocr.mjs";
import { createJudge, judgeLines } from "../src/judge.mjs";
import { createModel, MODEL } from "../src/llm.mjs";
import { matchLines } from "../src/match.mjs";
import { foldId, normalizeName } from "../src/text.mjs";
import { CONFIDENCE_MIN } from "../src/validate.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const INBOX = path.join(HERE, "..", "fixtures", "inbox");
const GOLD = path.join(HERE, "gold.json");
const OUT = path.join(HERE, "last-run.json");

/** Поля, помилка в яких змінює результат приймання. */
const HARD_FIELDS = [
  "supplierEdrpou",
  "storeCode",
  "docNumber",
  "docDate",
  "pricesIncludeVat",
  "totalKop",
];

const MAX_ATTEMPTS = 2;

// "№ 4471", "4471", "No4471" — це один і той самий номер. Форматування не помилка.
// Абетка теж: витяг зводить ідентифікатори до латиниці, а золото писане кирилицею.
const docKey = (n) => foldId(String(n ?? "")).replace(/[№\s]/g, "").toLowerCase();
const sameDocNumber = (a, b) => docKey(a) === docKey(b);

function parseArgs(argv) {
  const out = { repeats: 3, cases: null, model: MODEL, check: false, judge: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => argv[++i];
    if (arg === "--check") out.check = true;
    else if (arg === "--judge") out.judge = true;
    else if (arg === "--repeats" || arg === "-r") out.repeats = Number(value());
    else if (arg === "--case" || arg === "-c") out.cases = value().split(",").map((s) => s.trim());
    else if (arg === "--model" || arg === "-m") out.model = value();
    else throw new Error(`невідомий аргумент: ${arg}`);
  }
  if (!Number.isInteger(out.repeats) || out.repeats < 1) {
    throw new Error("--repeats очікує ціле число ≥ 1");
  }
  return out;
}

/**
 * Офлайн-перевірка золотих даних. Транскрипція дванадцяти листів руками — найімовірніше
 * джерело брехні в усьому eval: якщо золото неправильне, модель буде «помилятися» там,
 * де помилився я.
 */
function checkGold(gold, skuByCode) {
  const problems = [];
  for (const c of gold.cases) {
    const file = path.join(INBOX, c.fixture);
    try {
      readFileSync(file);
    } catch {
      problems.push(`${c.id}: немає файлу ${c.fixture}`);
    }
    for (const line of c.lines) {
      if (!skuByCode.has(line.sku)) problems.push(`${c.id}: SKU ${line.sku} немає в номенклатурі`);
      if (!Number.isInteger(line.priceKop)) problems.push(`${c.id}: ціна не копійками: ${line.priceKop}`);
    }
    // Сума рядків мусить дорівнювати підсумку — крім кейса, де розбіжність і є змістом.
    const sum = c.lines.reduce((acc, l) => acc + Math.round(l.priceKop * l.qty), 0);
    if (c.id !== "r10-total" && sum !== c.doc.totalKop) {
      problems.push(`${c.id}: сума рядків ${sum} ≠ підсумок ${c.doc.totalKop}`);
    }
    if (c.id === "r10-total" && sum === c.doc.totalKop) {
      problems.push(`${c.id}: підсумок мусить НЕ сходитись, у цьому весь кейс`);
    }
  }
  return problems;
}

/** Один прогін одного кейса: [розпізнавання] + витяг із ретраєм (як у графі) +
 *  матчинг без алясів. Фото розпізнається в кожному повторі заново: мінливість
 *  читання — саме те, що тут міряється. */
async function runOnce({ model, judge, text, source, skus, gold }) {
  const started = Date.now();
  if (text == null) text = await transcribe({ model, source });
  const ocrMs = source && Date.now() - started;
  let attempts = 0;
  let feedback = "";
  let doc = null;
  let failure = null;

  while (attempts < MAX_ATTEMPTS && !doc) {
    attempts += 1;
    try {
      doc = (await extract({ model, text, feedback })).doc;
    } catch (e) {
      if (!(e instanceof ExtractError)) throw e;
      feedback = e.message;
      failure = e.message;
    }
  }
  const extractMs = Date.now() - started;
  // Для фото транскрипція йде в звіт: без неї помилку витягу не відрізнити від помилки зору.
  const ocr = source ? { ocrMs, ocrText: text } : {};
  if (!doc) return { ok: false, attempts, extractMs, ...ocr, failure, ms: extractMs };

  // Аляси вимкнені: міряємо чистий матчинг, інакше друга ітерація міряла б БД.
  const matched = judge
    ? await judgeLines({ judge, lines: doc.lines, skus, aliasFor: () => null })
    : await matchLines({ model, lines: doc.lines, skus, aliasFor: () => null });
  const byId = new Map(skus.map((s) => [s.id, s]));

  const fields = {};
  for (const field of HARD_FIELDS) {
    fields[field] =
      field === "docNumber"
        ? sameDocNumber(doc.docNumber, gold.doc.docNumber)
        : doc[field] === gold.doc[field];
  }
  const poNumber = doc.poNumber === gold.doc.poNumber;

  const countOk = doc.lines.length === gold.lines.length;
  const lines = gold.lines.map((want, idx) => {
    const got = doc.lines[idx];
    const match = matched.find((m) => m.lineIdx === idx);
    const code = match?.skuId ? (byId.get(match.skuId)?.code ?? null) : null;
    return {
      idx,
      qty: got ? got.qty === want.qty : false,
      price: got ? got.priceKop === want.priceKop : false,
      name: got ? normalizeName(got.rawName) === normalizeName(want.rawName) : false,
      sku: code === want.sku,
      gotSku: code,
      wantSku: want.sku,
      confidence: match?.confidence ?? 0,
      via: match?.via ?? "none",
      gotPrice: got?.priceKop ?? null,
      wantPrice: want.priceKop,
      gotQty: got?.qty ?? null,
      wantQty: want.qty,
    };
  });

  return {
    ok: true,
    attempts,
    extractMs,
    ...ocr,
    ms: Date.now() - started,
    fields,
    poNumber,
    countOk,
    gotLineCount: doc.lines.length,
    lines,
    got: doc,
  };
}

const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};
const pct = (part, whole) => (whole ? `${Math.round((part / whole) * 100)}%` : "—");
const pad = (text, width) => String(text ?? "").padEnd(width).slice(0, width);

function summarise(caseId, runs) {
  const ok = runs.filter((r) => r.ok);
  const fieldErrors = {};
  for (const field of HARD_FIELDS) {
    fieldErrors[field] = ok.filter((r) => !r.fields[field]).length;
  }
  const docExact = ok.filter((r) => HARD_FIELDS.every((f) => r.fields[f])).length;
  const linesExact = ok.filter(
    (r) => r.countOk && r.lines.every((l) => l.qty && l.price),
  ).length;
  const skuExact = ok.filter((r) => r.countOk && r.lines.every((l) => l.sku)).length;
  const wrongConfident = ok.flatMap((r) =>
    r.lines.filter((l) => !l.sku && l.confidence >= CONFIDENCE_MIN),
  );

  return {
    caseId,
    runs: runs.length,
    extractFailed: runs.filter((r) => !r.ok).length,
    retried: runs.filter((r) => r.attempts > 1).length,
    docExact,
    linesExact,
    skuExact,
    countWrong: ok.filter((r) => !r.countOk).length,
    poMissed: ok.filter((r) => !r.poNumber).length,
    fieldErrors,
    wrongConfident,
    msMedian: median(runs.map((r) => r.ms)),
  };
}

function report(summaries, args) {
  const total = (key) => summaries.reduce((acc, s) => acc + s[key], 0);
  const runs = total("runs");

  console.log(`\n  модель ${args.model} · матчинг ${args.judge ? "System One" : "чат-модель"} · кейсів ${summaries.length} · повторів ${args.repeats} · прогонів ${runs}\n`);
  console.log(
    `  ${pad("кейс", 16)}${pad("витяг", 8)}${pad("ретрай", 8)}${pad("хедер", 8)}${pad("рядки", 8)}${pad("SKU", 8)}${pad("мс", 7)}`,
  );
  for (const s of summaries) {
    const good = s.runs - s.extractFailed;
    console.log(
      `  ${pad(s.caseId, 16)}${pad(pct(good, s.runs), 8)}${pad(s.retried || "—", 8)}` +
        `${pad(pct(s.docExact, good), 8)}${pad(pct(s.linesExact, good), 8)}` +
        `${pad(pct(s.skuExact, good), 8)}${pad(s.msMedian, 7)}`,
    );
  }

  console.log(`\n  разом:`);
  console.log(`    витяг з першої спроби   ${pct(runs - total("retried") - total("extractFailed"), runs)}`);
  console.log(`    знадобився ретрай       ${total("retried")} із ${runs}`);
  console.log(`    витяг провалився        ${total("extractFailed")} із ${runs}`);
  console.log(`    хедер повністю точний   ${pct(total("docExact"), runs)}`);
  console.log(`    рядки (к-ть, ціна)      ${pct(total("linesExact"), runs)}`);
  console.log(`    SKU усі правильні       ${pct(total("skuExact"), runs)}`);

  const wrong = summaries.flatMap((s) => s.wrongConfident.map((l) => ({ ...l, caseId: s.caseId })));
  console.log(`\n  ТИХІ ПОМИЛКИ (не той SKU при впевненості ≥ ${CONFIDENCE_MIN}): ${wrong.length}`);
  if (wrong.length) {
    console.log("  Найдорожчий клас помилок: ціна зійдеться, кратність зійдеться,");
    console.log("  а на полицю поїде не той товар — і людина цього не побачить.");
    for (const l of wrong.slice(0, 12)) {
      console.log(`    ${l.caseId} рядок ${l.idx + 1}: ${l.gotSku ?? "немає"} замість ${l.wantSku} (впевненість ${l.confidence})`);
    }
  }

  const fieldTotals = {};
  for (const field of HARD_FIELDS) {
    fieldTotals[field] = summaries.reduce((acc, s) => acc + s.fieldErrors[field], 0);
  }
  const broken = Object.entries(fieldTotals).filter(([, n]) => n > 0);
  console.log(`\n  помилки по полях хедера:`);
  if (!broken.length) console.log("    немає");
  for (const [field, n] of broken.sort((a, b) => b[1] - a[1])) {
    console.log(`    ${pad(field, 20)}${n} із ${runs}`);
  }
  const po = total("poMissed");
  if (po) console.log(`    ${pad("poNumber (м'яке)", 20)}${po} із ${runs} — у системи є запасний шлях`);
  console.log();
}

const args = parseArgs(process.argv.slice(2));
const gold = JSON.parse(readFileSync(GOLD, "utf8"));
const db = openDb(":memory:");
seedDb(db);
const skus = allSkus(db);
const skuByCode = new Map(skus.map((s) => [s.code, s]));

const problems = checkGold(gold, skuByCode);
if (problems.length) {
  console.error(`  золоті дані не консистентні (${problems.length}):`);
  for (const p of problems) console.error(`    ${p}`);
  process.exit(1);
}
console.error(`  золоті дані: ${gold.cases.length} кейсів, перевірка пройшла`);
if (args.check) process.exit(0);

const selected = args.cases
  ? gold.cases.filter((c) => args.cases.includes(c.id))
  : gold.cases;
if (!selected.length) throw new Error(`жоден кейс не підійшов під --case ${args.cases?.join(",")}`);

// З Jev чат-модель кличеться лише на витяг: рядки їдуть одним запитом до System One.
const calls = args.judge
  ? selected.length * args.repeats
  : selected.reduce((acc, c) => acc + (1 + c.lines.length), 0) * args.repeats;
console.error(`  прогонів ${selected.length * args.repeats}, викликів моделі близько ${calls}\n`);

const model = await createModel({ model: args.model });
const judge = args.judge ? await createJudge() : null;
if (args.judge && !judge) throw new Error("--judge, але в середовищі немає TYPESAFE_API_KEY");
const summaries = [];
const raw = [];

for (const c of selected) {
  const { raw: file, source } = await intake(path.join(INBOX, c.fixture));
  const runs = [];
  for (let i = 0; i < args.repeats; i++) {
    const result = await runOnce({ model, judge, text: file.text, source: file.text == null ? source : null, skus, gold: c });
    runs.push(result);
    process.stderr.write(result.ok ? (result.attempts > 1 ? "r" : ".") : "x");
  }
  process.stderr.write(` ${c.id}\n`);
  summaries.push(summarise(c.id, runs));
  raw.push({ caseId: c.id, runs });
}

report(summaries, args);
writeFileSync(
  OUT,
  JSON.stringify(
    { model: args.model, matcher: args.judge ? "jev" : "llm", repeats: args.repeats, summaries, raw },
    null,
    2,
  ),
);
console.error(`  повний дамп: ${OUT}\n`);
