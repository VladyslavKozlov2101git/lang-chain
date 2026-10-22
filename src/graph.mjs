/**
 * Граф приймання. Цей файл лише зшиває вузли: вся логіка живе в сусідніх модулях.
 *
 *   START → dedupe → extract ⟲ → match → validate → ┬ чисто ───→ commit ─┬→ END
 *              │        (ретрай ребром,             │                     └→ explain → END
 *              └→ END    макс 2 спроби)             └ блокуючі → review ⏸ ┤
 *           (тред уже                                                     └→ explain → END
 *            закритий)
 *
 * Фабрика приймає { model, judge, db, checkpointer } аргументами, а не імпортує їх
 * сама: саме тому тести підставляють FakeListChatModel і БД у пам'яті без мок-магії.
 *
 * `match` зіставляє через System One (`judge.mjs`), коли переданий `judge`, і через
 * чат-модель (`match.mjs`), коли ні. Форма графа від цього не залежить: контракт у
 * двох реалізацій однаковий. Залежить лише те, чи має сенс поріг у R8 — див. T13
 * і T16 у specs.
 *
 * Контекст із БД (номенклатура, протоколи, заявка) у стан не кладеться: там Map і
 * функції, яких чекпойнтер не серіалізує. Вузли читають його щоразу — sqlite у тому
 * ж процесі, це дешевше за будь-яку спробу його закешувати.
 */
import { Annotation, END, START, StateGraph, interrupt } from "@langchain/langgraph";

import {
  aliasFor,
  commitReceipt,
  DuplicateReceipt,
  enqueueReview,
  loadContext,
  priorOutcome,
  receiptOf,
  resolveReview,
  writeAct,
} from "./db.mjs";
import { explainIssues } from "./explain.mjs";
import { extract, ExtractError } from "./extract.mjs";
import { judgeLines } from "./judge.mjs";
import { matchLines } from "./match.mjs";
import { formatUah, normalizeName } from "./text.mjs";
import { blocking, netOf, validate } from "./validate.mjs";

export const MAX_EXTRACT_ATTEMPTS = 2;

export const SupplyState = Annotation.Root({
  threadId: Annotation(),
  source: Annotation(),
  raw: Annotation(),
  doc: Annotation(),
  matched: Annotation(),
  issues: Annotation(),
  attempt: Annotation(),
  extractError: Annotation(),
  decision: Annotation(),
  receiptId: Annotation(),
  actId: Annotation(),
  message: Annotation(),
  status: Annotation(),
  seen: Annotation(),
});

/** Схвалені рядки, 0-based. Без рішення людини схвалені всі. */
function approvedIndexes(state) {
  const all = state.doc?.lines?.map((_, i) => i) ?? [];
  const action = state.decision?.action;
  if (!action || action === "approve") return all;
  if (action === "reject") return [];
  return (state.decision.lines ?? []).filter((i) => Number.isInteger(i) && i >= 0 && i < all.length);
}

const hasCode = (state, code) => (state.issues ?? []).some((i) => i.code === code);

export function buildGraph({ model, judge, db, today, checkpointer }) {
  const contextFor = (doc) =>
    loadContext(db, {
      edrpou: doc.supplierEdrpou,
      storeCode: doc.storeCode,
      poNumber: doc.poNumber,
      docDate: doc.docDate,
      today,
    });

  // Перший рівень ідемпотентності. Виявилось, що thread_id сам по собі його не
  // дає: завершений тред LangGraph проганяє заново з START, а не повертає старий
  // результат. Тому вхідна перевірка — явна, і вона дешева: ні LLM, ні мережі.
  const dedupeNode = (state) => {
    const prior = priorOutcome(db, state.threadId);
    if (!prior) return { seen: false };
    console.error(`[dedupe] тред уже закритий зі статусом ${prior.status} — повторно не проводимо`);
    return { ...prior, seen: true };
  };

  const extractNode = async (state) => {
    const attempt = (state.attempt ?? 0) + 1;
    try {
      const { doc } = await extract({
        model,
        text: state.raw.text,
        feedback: state.extractError ?? "",
      });
      console.error(`[extract] спроба ${attempt}: ${doc.docNumber}, рядків ${doc.lines.length}`);
      return { doc, attempt, extractError: null, status: "extracted" };
    } catch (e) {
      // Помилка схеми — робота для ретраю. Падіння шлюзу чи ключа — ні: воно
      // летить нагору, стан лишається на диску, CLI друкує команду відновлення.
      if (!(e instanceof ExtractError)) throw e;
      console.error(`[extract] спроба ${attempt}/${MAX_EXTRACT_ATTEMPTS}: ${e.message}`);
      const exhausted = attempt >= MAX_EXTRACT_ATTEMPTS;
      return {
        attempt,
        extractError: e.message,
        ...(exhausted && {
          status: "failed",
          issues: [{ lineIdx: null, code: "extract_failed", detail: e.message, blocking: true }],
        }),
      };
    }
  };

  const matchNode = async (state) => {
    const ctx = contextFor(state.doc);
    const lines = state.doc.lines;
    const skus = ctx.skus;
    const aliasKey = ctx.supplier ? (key) => aliasFor(db, ctx.supplier.id, key) : () => null;

    // judgeLines і matchLines віддають однакове, тому решта графа — і R8
    // передусім — не знає, котрий із них відпрацював. Різниця лише в тому, що
    // лежить у confidence: у Jev це окреме судження про наявність, у чат-моделі —
    // число, яке вона написала про себе сама.
    const matched = judge
      ? await judgeLines({ judge, lines, skus, aliasFor: aliasKey })
      : await matchLines({ model, lines, skus, aliasFor: aliasKey });
    return { matched };
  };

  const validateNode = (state) => {
    const ctx = contextFor(state.doc);
    const issues = validate({ doc: state.doc, matched: state.matched, ctx });
    const blockers = blocking(issues);
    console.error(
      `[validate] розбіжностей ${issues.length}, блокуючих ${blockers.length}` +
        (blockers.length ? `: ${blockers.map((i) => i.code).join(", ")}` : ""),
    );
    return { issues, status: blockers.length ? "needs_review" : "validated" };
  };

  const reviewNode = (state) => {
    const ctx = state.doc ? contextFor(state.doc) : null;
    // Перед interrupt, і тому ідемпотентно: при resume тіло вузла виконується знову.
    enqueueReview(db, {
      threadId: state.threadId,
      storeCode: state.doc?.storeCode,
      supplierName: ctx?.supplier?.name ?? state.doc?.supplierName,
      docNumber: state.doc?.docNumber,
      issuesCount: blocking(state.issues ?? []).length,
    });

    const decision = interrupt({
      threadId: state.threadId,
      docNumber: state.doc?.docNumber ?? null,
      docDate: state.doc?.docDate ?? null,
      storeCode: state.doc?.storeCode ?? null,
      supplierName: ctx?.supplier?.name ?? null,
      // Примітка постачальника їде разом із розбіжностями: без неї «позиції немає
      // в заявці» читається як помилка там, де постачальник привіз товар на пробу
      // і прямо про це написав.
      note: state.doc?.note ?? null,
      lines: state.doc?.lines ?? [],
      issues: state.issues ?? [],
    });

    return { decision };
  };

  const commitNode = (state) => {
    const ctx = contextFor(state.doc);
    const byLine = new Map((state.matched ?? []).map((m) => [m.lineIdx, m]));
    const lines = [];
    const aliases = [];

    const approved = new Set(approvedIndexes(state));
    const issuesOf = (idx) => (state.issues ?? []).filter((i) => i.lineIdx === idx);

    /**
     * AC-8: аляс народжується тільки з рішення людини — але не лише з прийнятих
     * рядків. Якщо рядок відкинули через ціну чи термін, зіставлення в ньому
     * людина не заперечила, і наступного разу витрачати на нього LLM не треба.
     *
     * Два випадки, коли не вчимося: рядок позначений `no_sku_match` (саме збіг і
     * під питанням), або рядок виключили без жодної розбіжності — тоді причина
     * невідома, і це міг бути якраз неправильний SKU.
     */
    const learnable = (idx) => {
      const issues = issuesOf(idx);
      if (issues.some((i) => i.code === "no_sku_match")) return false;
      if (approved.has(idx)) return true;
      return issues.some((i) => i.blocking);
    };

    state.doc.lines.forEach((line, idx) => {
      const match = byLine.get(idx);
      const sku = match?.skuId ? ctx.skuById.get(match.skuId) : null;
      if (!sku) return; // без SKU ні проводити, ні вчити нічого

      if (approved.has(idx)) {
        lines.push({
          skuId: sku.id,
          rawName: line.rawName,
          qty: line.qty,
          priceNetKop: state.doc.pricesIncludeVat
            ? netOf(line.priceKop, sku.vatRate)
            : line.priceKop,
        });
      }

      // `via !== "alias"`, а не `=== "llm"`: збіг від Jev людина підтвердила так
      // само, і без аляса він їхав би в модель щоразу.
      if (state.decision && match.via !== "alias" && learnable(idx)) {
        aliases.push({
          supplierId: ctx.supplier.id,
          normalized: normalizeName(line.rawName),
          skuId: sku.id,
        });
      }
    });

    const partial = lines.length < state.doc.lines.length;
    try {
      const { receiptId, totalNetKop } = commitReceipt(db, {
        threadId: state.threadId,
        supplierId: ctx.supplier.id,
        storeId: ctx.store.id,
        docNumber: state.doc.docNumber,
        docDate: state.doc.docDate,
        status: partial ? "partial" : "posted",
        lines,
        aliases,
      });
      resolveReview(db, state.threadId);
      console.error(
        `[commit] накладна #${receiptId}: рядків ${lines.length}, ${formatUah(totalNetKop)} грн без ПДВ` +
          (aliases.length ? `, алясів +${aliases.length}` : ""),
      );
      return { receiptId, status: partial ? "partial" : "posted" };
    } catch (e) {
      if (e instanceof DuplicateReceipt) {
        console.error(`[commit] ${e.message} — другої накладної не буде`);
        resolveReview(db, state.threadId, "duplicate");
        return { status: "duplicate" };
      }
      throw e;
    }
  };

  const explainNode = async (state) => {
    const issues = state.issues ?? [];
    const accepted = state.receiptId ? approvedIndexes(state) : [];
    const ctx = state.doc ? contextFor(state.doc) : null;

    const message = await explainIssues({
      model,
      doc: state.doc,
      issues,
      accepted,
      // Прийнята сума читається з проведеної накладної, а не рахується вдруге.
      acceptedTotalKop: state.receiptId ? (receiptOf(db, state.threadId)?.totalNetKop ?? null) : null,
      supplierName: ctx?.supplier?.name,
    });
    const { actId } = writeAct(db, {
      threadId: state.threadId,
      receiptId: state.receiptId ?? null,
      message,
      issues,
    });
    resolveReview(db, state.threadId);

    const status = state.receiptId ? state.status : state.decision ? "rejected" : state.status;
    return { actId, message, status };
  };

  const afterExtract = (state) => {
    if (!state.extractError) return "match";
    return state.attempt < MAX_EXTRACT_ATTEMPTS ? "extract" : "review";
  };

  const afterValidate = (state) => (blocking(state.issues).length ? "review" : "commit");

  const afterReview = (state) => {
    if (!state.doc) return "explain";
    // Немає відомого магазину або постачальника — проводити фізично нікуди.
    if (hasCode(state, "unknown_store") || hasCode(state, "unknown_supplier")) return "explain";
    if (state.decision?.action === "reject") return "explain";
    return approvedIndexes(state).length ? "commit" : "explain";
  };

  const afterCommit = (state) => ((state.issues ?? []).length ? "explain" : END);

  return new StateGraph(SupplyState)
    .addNode("dedupe", dedupeNode)
    .addNode("extract", extractNode)
    .addNode("match", matchNode)
    .addNode("validate", validateNode)
    .addNode("review", reviewNode)
    .addNode("commit", commitNode)
    .addNode("explain", explainNode)
    .addEdge(START, "dedupe")
    .addConditionalEdges("dedupe", (state) => (state.seen ? END : "extract"), ["extract", END])
    .addConditionalEdges("extract", afterExtract, ["extract", "match", "review"])
    .addEdge("match", "validate")
    .addConditionalEdges("validate", afterValidate, ["review", "commit"])
    .addConditionalEdges("review", afterReview, ["commit", "explain"])
    .addConditionalEdges("commit", afterCommit, ["explain", END])
    .addEdge("explain", END)
    .compile({ checkpointer });
}
