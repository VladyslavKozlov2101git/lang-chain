/**
 * Локальний фронт: `node supply.mjs web`.
 *
 * Вбудований `node:http`, нуль депенденсів, одна HTML-сторінка. Сторінка на
 * claude.ai тут не підійшла б узагалі: фронту треба дістатись і до твоєї БД, і до
 * шлюзу, а браузер із https не пустить запит на http://localhost.
 *
 * Слухає тільки 127.0.0.1: це інструмент для одного стола, а не сервіс.
 */
import { readdir, readFile, stat } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Command } from "@langchain/langgraph";

import {
  checkpointerFor,
  openDb,
  pendingReviews,
  receiptOf,
} from "./db.mjs";
import { reasonText } from "./explain.mjs";
import { buildGraph } from "./graph.mjs";
import { intake } from "./intake.mjs";
import { createModel } from "./llm.mjs";
import { callKind, withTrace } from "./trace.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const INBOX = path.resolve(HERE, "..", "fixtures", "inbox");
const WEB = path.resolve(HERE, "..", "web");

// Білий список сторінок, а не статика з теки: зайвий файл у web/ не має ставати
// маршрутом сам собою.
const PAGES = {
  "/": "index.html",
  "/index.html": "index.html",
  "/shlyah": "shlyah.html",
};

const listInbox = async () => (await readdir(INBOX)).filter((f) => /\.(txt|xlsx)$/i.test(f)).sort();

/**
 * Назва файлу приходить з браузера, тому перевіряється двічі: що в ній немає шляху
 * і що вона є у фактичному списку теки. Сервер локальний, але ../../ з адресного
 * рядка — це не той сюрприз, який хочеться відкладати на потім.
 */
async function resolveFixture(name) {
  if (typeof name !== "string" || name !== path.basename(name)) {
    throw Object.assign(new Error("назва файлу некоректна"), { status: 400 });
  }
  const files = await listInbox();
  if (!files.includes(name)) {
    throw Object.assign(new Error(`немає такого документа: ${name}`), { status: 404 });
  }
  return path.join(INBOX, name);
}

const outcomeOf = (db, threadId, state) => ({
  threadId,
  status: state.status ?? null,
  message: state.message ?? null,
  receipt: receiptOf(db, threadId),
  paused: state.__interrupt__?.[0]?.value ?? null,
  matched: state.matched ?? null,
  doc: state.doc ?? null,
  attempt: state.attempt ?? null,
});

const traceOf = (calls) =>
  calls.map((call, i) => ({ i, kind: callKind(call.prompt), ...call }));

export function createServer({ db, makeModel = createModel, today } = {}) {
  let cached = null;
  const model = async () => (cached ??= await makeModel());

  const graphWith = async (trace) =>
    buildGraph({ model: trace.model, db, today, checkpointer: checkpointerFor(db) });

  const api = {
    "GET /api/inbox": async () => {
      const files = await listInbox();
      return Promise.all(
        files.map(async (name) => ({
          name,
          kind: name.endsWith(".xlsx") ? "xlsx" : "txt",
          size: (await stat(path.join(INBOX, name))).size,
        })),
      );
    },

    "GET /api/letter": async ({ query }) => {
      const file = await resolveFixture(query.get("file"));
      const { raw, source, threadId } = await intake(file);
      return { text: raw.text, rows: raw.rows ?? null, kind: source.kind, threadId };
    },

    "GET /api/queue": async () => ({
      pending: pendingReviews(db).map((row) => ({ ...row, thread: row.threadId })),
      receipts: db
        .prepare(
          `SELECT r.id, r.thread_id AS threadId, r.doc_number AS docNumber, r.doc_date AS docDate,
                  r.total_net_kop AS totalNetKop, r.status, s.code AS storeCode, p.name AS supplierName,
                  (SELECT count(*) FROM receipt_line l WHERE l.receipt_id = r.id) AS lines
             FROM receipt r
             JOIN store s ON s.id = r.store_id
             JOIN supplier p ON p.id = r.supplier_id
            ORDER BY r.id DESC`,
        )
        .all(),
      acts: db
        .prepare(
          `SELECT id, thread_id AS threadId, receipt_id AS receiptId, message
             FROM discrepancy_act ORDER BY id DESC`,
        )
        .all(),
      aliases: db
        .prepare(
          `SELECT s.code, a.raw_name_normalized AS rawName, p.name AS supplierName
             FROM sku_alias a JOIN sku s ON s.id = a.sku_id
             JOIN supplier p ON p.id = a.supplier_id ORDER BY a.id DESC`,
        )
        .all(),
    }),

    "POST /api/intake": async ({ body }) => {
      const file = await resolveFixture(body.file);
      const { threadId, source, raw } = await intake(file);
      const trace = withTrace(await model());
      const graph = await graphWith(trace);
      try {
        const state = await graph.invoke(
          { threadId, source, raw },
          { configurable: { thread_id: threadId } },
        );
        return { ...outcomeOf(db, threadId, state), trace: traceOf(trace.calls) };
      } catch (e) {
        return {
          threadId,
          failed: e.message,
          trace: traceOf(trace.calls),
          resumable: true,
        };
      }
    },

    "POST /api/resume": async ({ body }) => {
      const threadId = body.thread;
      if (!threadId) throw Object.assign(new Error("немає треда"), { status: 400 });
      const decision =
        body.action === "partial"
          ? { action: "partial", lines: (body.lines ?? []).map(Number) }
          : body.action
            ? { action: body.action }
            : null;

      const trace = withTrace(await model());
      const graph = await graphWith(trace);
      const config = { configurable: { thread_id: threadId } };
      const before = await graph.getState(config);
      if (!before.createdAt) throw Object.assign(new Error("треда немає"), { status: 404 });

      const state = await graph.invoke(decision ? new Command({ resume: decision }) : null, config);
      return { ...outcomeOf(db, threadId, state), trace: traceOf(trace.calls) };
    },

    "GET /api/thread": async ({ query }) => {
      const threadId = query.get("id");
      const graph = await graphWith({ model: null });
      const state = await graph.getState({ configurable: { thread_id: threadId } });
      if (!state.createdAt) throw Object.assign(new Error("треда немає"), { status: 404 });
      return {
        next: state.next,
        doc: state.values.doc ?? null,
        matched: state.values.matched ?? null,
        issues: state.values.issues ?? null,
        status: state.values.status ?? null,
        attempt: state.values.attempt ?? null,
      };
    },

    "GET /api/reasons": async () =>
      Object.fromEntries(
        [
          "price_above_protocol",
          "price_below_protocol",
          "no_price_protocol",
          "pack_multiple",
          "over_po",
          "under_delivery",
          "shelf_life",
          "no_sku_match",
          "not_in_po",
          "total_mismatch",
          "unknown_store",
          "unknown_supplier",
          "extract_failed",
        ].map((code) => [code, reasonText(code)]),
      ),
  };

  return createHttpServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const route = `${req.method} ${url.pathname}`;

    const send = (status, payload, type = "application/json; charset=utf-8") => {
      res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
      res.end(typeof payload === "string" ? payload : JSON.stringify(payload));
    };

    try {
      if (req.method === "GET" && PAGES[url.pathname]) {
        // Читаємо щоразу: правку сторінки видно без рестарту сервера.
        const html = await readFile(path.join(WEB, PAGES[url.pathname]), "utf8");
        return send(200, html, "text/html; charset=utf-8");
      }

      const handler = api[route];
      if (!handler) return send(404, { error: `немає маршруту ${route}` });

      let body = {};
      if (req.method === "POST") {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const text = Buffer.concat(chunks).toString("utf8");
        body = text ? JSON.parse(text) : {};
      }

      return send(200, await handler({ query: url.searchParams, body }));
    } catch (e) {
      console.error(`[web] ${route}: ${e.message}`);
      return send(e.status ?? 500, { error: e.message });
    }
  });
}

export async function startServer({ dbFile, port = Number(process.env.SUPPLY_PORT ?? 5173), today } = {}) {
  const db = openDb(dbFile);
  const server = createServer({ db, today });
  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  return { server, port, url: `http://127.0.0.1:${port}` };
}
