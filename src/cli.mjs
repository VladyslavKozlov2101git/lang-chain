/**
 * Три команди: intake, review, resume. Плюс seed для початкових даних.
 *
 * Модель і файл БД приходять параметрами з дефолтами — так само, як у граф. Тому
 * команди проганяються в тестах офлайн, і `review` працює навіть без API-ключа:
 * дивитись чергу не повинно вимагати доступу до LLM.
 */
import { Command } from "@langchain/langgraph";

import {
  checkpointerFor,
  DB_PATH,
  openDb,
  pendingReviews,
  receiptOf,
  seedDb,
} from "./db.mjs";
import { reasonText } from "./explain.mjs";
import { buildGraph } from "./graph.mjs";
import { intake } from "./intake.mjs";
import { createJudge } from "./judge.mjs";
import { createModel } from "./llm.mjs";
import { startServer } from "./server.mjs";
import { formatUah } from "./text.mjs";
import { withTrace } from "./trace.mjs";

const USAGE = `supply-flow — приймання поставки від постачальника

  node supply.mjs seed                        початкові дані (магазини, SKU, протоколи, заявки)
  node supply.mjs intake <файл>               прогін документа: .txt, .xlsx, .pdf, фото (.jpg .png .webp .heic)
  node supply.mjs review                      черга розбіжностей, що чекають рішення
  node supply.mjs resume <тред> --approve      прийняти все
  node supply.mjs resume <тред> --reject       відмовити
  node supply.mjs resume <тред> --lines 1,3    прийняти лише ці рядки (нумерація як у документі)
  node supply.mjs resume <тред>                продовжити прогін, що впав
  node supply.mjs web                         те саме у браузері, на 127.0.0.1

  --trace     до intake і resume: друкувати промпти й відповіді моделі

  SUPPLY_DB   шлях до файлу БД (дефолт ./supply.db)
  SUPPLY_PORT порт для web (дефолт 5173)
  MODEL       модель шлюзу opencode (дефолт qwen3.8-flash)`;

export function parseArgs(args) {
  const out = { _: [] };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith("--")) {
      out._.push(arg);
      continue;
    }
    const [name, inline] = arg.slice(2).split("=");
    if (inline !== undefined) {
      out[name] = inline;
      continue;
    }
    const next = args[i + 1];
    if (next && !next.startsWith("--")) {
      out[name] = next;
      i += 1;
    } else {
      out[name] = true;
    }
  }
  return out;
}

/** Рядки людина нумерує з одиниці, граф — з нуля. */
export function decisionFrom(args) {
  if (args.approve) return { action: "approve" };
  if (args.reject) return { action: "reject" };
  if (typeof args.lines === "string") {
    const lines = args.lines.split(",").map((n) => Number(n.trim()) - 1);
    if (lines.some((n) => !Number.isInteger(n) || n < 0)) {
      throw new Error(`--lines очікує номери рядків через кому, а не "${args.lines}"`);
    }
    return { action: "partial", lines };
  }
  return null;
}

const clip = (text, width) => {
  const s = String(text ?? "");
  return s.length > width ? `${s.slice(0, width - 1)}…` : s;
};
// Обрізаємо на символ менше за колонку, щоб між стовпцями завжди лишався пробіл:
// назва рівно в ширину колонки інакше зліплюється з наступним числом.
const pad = (text, width) => clip(text, width - 1).padEnd(width);

function printPause(paused, log) {
  const head = [paused.docNumber, paused.docDate && `від ${paused.docDate}`, paused.supplierName, paused.storeCode && `→ ${paused.storeCode}`]
    .filter(Boolean)
    .join(" · ");
  log(`\n  Потрібне рішення: ${head || paused.threadId}`);
  log(`  тред ${paused.threadId}\n`);

  const byLine = new Map();
  const docLevel = [];
  for (const issue of paused.issues) {
    if (issue.lineIdx === null) docLevel.push(issue);
    else byLine.set(issue.lineIdx, [...(byLine.get(issue.lineIdx) ?? []), issue]);
  }

  // Примітка постачальника — перше, що треба прочитати: без неї розбіжність
  // виглядає помилкою там, де є пояснення.
  if (paused.note) log(`  постачальник пише: «${paused.note}»\n`);

  if (paused.lines.length) {
    // Колонка коментарів з'являється лише коли постачальник справді щось написав:
    // порожній стовпець у кожному документі — шум.
    const commented = paused.lines.some((line) => line.note);
    log(
      `  ${pad("№", 3)}${pad("Товар", 34)}${pad("К-ть", 6)}${pad("Ціна", 9)}` +
        (commented ? pad("Коментар", 28) : "") +
        "Розбіжність",
    );
    paused.lines.forEach((line, idx) => {
      const issues = byLine.get(idx) ?? [];
      const why = issues.length
        ? issues.map((i) => `${reasonText(i.code)}${i.blocking ? "" : " (не блокує)"}`).join("; ")
        : "—";
      log(
        `  ${pad(idx + 1, 3)}${pad(line.rawName, 34)}${pad(line.qty, 6)}${pad(formatUah(line.priceKop), 9)}` +
          (commented ? pad(line.note, 28) : "") +
          why,
      );
    });
  }

  for (const issue of docLevel) log(`  документ — ${reasonText(issue.code)}: ${issue.detail}`);

  log("\n  Деталі:");
  for (const issue of paused.issues) log(`    ${issue.code}: ${issue.detail}`);
  log("\n  Далі:");
  log(`    node supply.mjs resume ${paused.threadId} --approve`);
  log(`    node supply.mjs resume ${paused.threadId} --reject`);
  log(`    node supply.mjs resume ${paused.threadId} --lines 1,2\n`);
}

function printOutcome(db, threadId, state, log) {
  const receipt = receiptOf(db, threadId);
  const label = {
    posted: "проведено повністю",
    partial: "проведено частково",
    rejected: "відмовлено, накладної немає",
    duplicate: "цей документ уже проведено раніше — другої накладної не буде",
    failed: "документ не вдалося прочитати",
  };
  log(`\n  ${label[state.status] ?? state.status}`);
  if (receipt) {
    log(`  накладна #${receipt.id}: ${receipt.docNumber} від ${receipt.docDate}, ` +
        `${formatUah(receipt.totalNetKop)} грн без ПДВ`);
  }
  if (state.message) log(`\n  Текст для постачальника:\n\n${state.message}\n`);
}

export async function main(argv = process.argv.slice(2), deps = {}) {
  const { makeModel = createModel, makeJudge = createJudge, dbFile = DB_PATH,
          log = console.log, today } = deps;
  const args = parseArgs(argv);
  const [command, target] = args._;

  if (!command || args.help) {
    log(USAGE);
    return 0;
  }

  if (command === "web") {
    const { url } = await startServer({ dbFile, today });
    log(`  фронт на ${url}`);
    log(`  БД ${dbFile}\n  Ctrl+C щоб спинити`);
    return 0; // сервер сам тримає процес живим
  }

  const db = openDb(dbFile);

  // --trace підмінює модель і суддю обгортками: вузли кличуть у моделі тільки
  // .invoke, а в судді — одну функцію, тому трасування нічого не знає про їхній
  // код і нічого в ньому не псує.
  const graphWith = async () => {
    const traced = args.trace ? withTrace(await makeModel(), await makeJudge()) : null;
    return {
      graph: buildGraph({
        model: traced ? traced.model : await makeModel(),
        judge: traced ? traced.judge : await makeJudge(),
        db,
        today,
        checkpointer: checkpointerFor(db),
      }),
      trace: traced,
    };
  };

  const printTrace = (traced) => {
    if (!traced) return;
    for (const [i, call] of traced.calls.entries()) {
      log(`\n  ── ${i + 1}. ${call.kind} · ${call.ms} мс ──`);
      log(`\n  запит:\n${call.prompt}`);
      log(`\n  відповідь:\n${call.error ? `ПОМИЛКА: ${call.error}` : call.reply}\n`);
    }
  };

  switch (command) {
    case "seed": {
      const stats = seedDb(db);
      log(
        `  seed: магазинів ${stats.stores}, постачальників ${stats.suppliers}, ` +
          `SKU ${stats.sku}, протоколів ${stats.protocols}, заявок ${stats.po}`,
      );
      return 0;
    }

    case "review": {
      const queue = pendingReviews(db);
      if (!queue.length) {
        log("  черга порожня");
        return 0;
      }
      log(`\n  ${pad("тред", 14)}${pad("документ", 12)}${pad("магазин", 9)}${pad("розбіжн.", 10)}постачальник`);
      for (const row of queue) {
        log(
          `  ${pad(row.threadId.slice(0, 12), 14)}${pad(row.docNumber, 12)}` +
            `${pad(row.storeCode, 9)}${pad(row.issuesCount, 10)}${row.supplierName ?? ""}`,
        );
      }
      log(`\n  рішення: node supply.mjs resume <тред> --approve|--reject|--lines 1,3\n`);
      return 0;
    }

    case "intake": {
      if (!target) throw new Error("вкажи файл: node supply.mjs intake fixtures/inbox/clean-01-molochka.txt");
      const { threadId, source, raw } = await intake(target);
      log(`  ${source.kind}: ${source.path}\n  тред ${threadId}`);

      const { graph, trace } = await graphWith();
      const config = { configurable: { thread_id: threadId } };
      try {
        const state = await graph.invoke({ threadId, source, raw }, config);
        const paused = state.__interrupt__?.[0]?.value;
        if (paused) printPause(paused, log);
        else printOutcome(db, threadId, state, log);
        printTrace(trace);
        return paused ? 2 : 0;
      } catch (e) {
        // AC-27: стан на диску цілий, тому друкуємо, чим продовжити.
        log(`\n  прогін упав: ${e.message}`);
        log(`  стан збережено; продовжити: node supply.mjs resume ${threadId}\n`);
        printTrace(trace);
        return 1;
      }
    }

    case "resume": {
      if (!target) throw new Error("вкажи тред: node supply.mjs resume <тред> --approve");
      const { graph, trace } = await graphWith();
      const config = { configurable: { thread_id: target } };
      const before = await graph.getState(config);
      if (!before.createdAt) throw new Error(`треда ${target} немає — перевір node supply.mjs review`);

      const decision = decisionFrom(args);
      if (before.next.includes("review") && !decision) {
        throw new Error("тред чекає рішення: додай --approve, --reject або --lines 1,3");
      }

      // Без рішення це продовження прогону, що впав: входу немає, граф іде
      // з останнього чекпойнта.
      const state = await graph.invoke(decision ? new Command({ resume: decision }) : null, config);
      const paused = state.__interrupt__?.[0]?.value;
      if (paused) {
        printPause(paused, log);
        printTrace(trace);
        return 2;
      }
      printOutcome(db, target, state, log);
      printTrace(trace);
      return 0;
    }

    default:
      log(USAGE);
      throw new Error(`невідома команда: ${command}`);
  }
}
