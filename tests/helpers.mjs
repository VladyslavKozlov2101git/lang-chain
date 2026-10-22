/** Спільне для тестів графа й CLI. Не тест: testMatch ловить лише *.test.mjs. */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { Command } from "@langchain/langgraph";

import { checkpointerFor, openDb, seedDb } from "../src/db.mjs";
import { buildGraph } from "../src/graph.mjs";

export const TODAY = "2026-10-21";

/**
 * Модель за сценарієм: віддає відповіді строго по порядку викликів і падає на
 * несподіваному. FakeListChatModel крутить список по колу, тобто зайвий виклик
 * пройшов би непоміченим — а в графі цікава саме кількість викликів.
 * Елемент-Error кидається: так перевіряється падіння шлюзу.
 */
export class Scripted {
  constructor(responses) {
    this.responses = responses;
    this.prompts = [];
  }

  async invoke(prompt) {
    const next = this.responses[this.prompts.length];
    if (next === undefined) {
      throw new Error(`Scripted: несподіваний виклик моделі #${this.prompts.length + 1}`);
    }
    this.prompts.push(prompt);
    if (next instanceof Error) throw next;
    return next;
  }
}

/**
 * Суддя за сценарієм. Як і Scripted, падає на несподіваному — але тут несподіване
 * це *другий* запит: уся цінність форми в тому, що рядків багато, а запит один,
 * і тест мусить це тримати.
 *
 * @param answers  по елементу на рядок: код SKU або [код, exists]
 */
export class ScriptedJudge {
  constructor(answers) {
    this.answers = answers;
    this.requests = [];
  }

  async judge(request) {
    if (this.requests.length) {
      throw new Error("ScriptedJudge: другий запит — усі рядки мали поїхати одним");
    }
    this.requests.push(request);
    const answers = {};
    request.state.lines.forEach((_, i) => {
      const spec = this.answers[i];
      const [choice, exists] = Array.isArray(spec) ? spec : [spec, 0.97];
      answers[`exists_${i}`] = { type: "noul", noul: exists };
      answers[`sku_${i}`] = { type: "choice", choice, confidence: 1, probabilities: { [choice]: 1 } };
    });
    return { answers, usage: { input_tokens: 0 } };
  }
}

/** [назва в документі, кількість, ціна, код SKU] — збігається з PO-2026-1041. */
export const LINES = [
  ["Молоко пастеризоване 2,6% 900г п/е", 24, "38,90", "MLK-001"],
  ["Кефір 2,5% 450г", 16, "26,40", "MLK-004"],
  ["Сметана 20% 350г", 24, "47,60", "MLK-006"],
  ["Сир кисломолочний 9% 350г", 20, "62,00", "MLK-011"],
];

export const docReply = ({ docNumber = "РН-5512", total = "3738,40", lines = LINES, ...over } = {}) =>
  JSON.stringify({
    supplierEdrpou: "31245678",
    supplierName: "ТОВ «Молочний Дім»",
    storeCode: "KV-LUK",
    poNumber: "PO-2026-1041",
    docNumber,
    docDate: TODAY,
    pricesIncludeVat: false,
    total,
    // П'ятий елемент рядка, якщо він є, — примітка постачальника.
    lines: lines.map(([rawName, qty, price, , note]) => ({
      rawName,
      qty,
      unit: "шт",
      price,
      expiresOn: null,
      note: note ?? null,
    })),
    ...over,
  });

export const picks = (lines = LINES) =>
  lines.map(([, , , code]) => JSON.stringify({ code, confidence: 0.95 }));

/** Документ, у якому сметана дорожча за протокол — найчастіший реальний випадок.
 *  Номер той самий, що у фікстурі r01-cina-vyshche.txt: фейкова відповідь моделі
 *  мусить відповідати документу, який їй згодували. */
export const overPriced = () => ({
  docNumber: "РН-5540",
  lines: LINES.map((l) => (l[3] === "MLK-006" ? [l[0], l[1], "49,90", l[3]] : l)),
  total: "3793,60",
});

export const setup = async ({ file = false } = {}) => {
  const dir = file ? await mkdtemp(path.join(tmpdir(), "supply-")) : null;
  const dbFile = dir ? path.join(dir, "supply.db") : ":memory:";
  const db = openDb(dbFile);
  seedDb(db);
  return { db, dbFile };
};

export const graphOver = (db, model, judge) =>
  buildGraph({ model, judge, db, today: TODAY, checkpointer: checkpointerFor(db) });

export const cfg = (threadId) => ({ configurable: { thread_id: threadId } });

export const input = (threadId) => ({
  threadId,
  source: { path: "лист.txt", kind: "txt" },
  raw: { text: "текст листа" },
});

export const run = (graph, threadId) => graph.invoke(input(threadId), cfg(threadId));

export const resume = (graph, threadId, decision) =>
  graph.invoke(new Command({ resume: decision }), cfg(threadId));

export const interruptOf = (result) => result.__interrupt__?.[0]?.value ?? null;
