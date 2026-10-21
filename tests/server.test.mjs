import { openDb, receiptOf, seedDb } from "../src/db.mjs";
import { createServer } from "../src/server.mjs";
import { docReply, overPriced, picks, Scripted, TODAY } from "./helpers.mjs";

let open = [];

const listen = async ({ model, db }) => {
  const server = createServer({ db, today: TODAY, makeModel: async () => model });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  open.push(server);
  const { port } = server.address();
  return `http://127.0.0.1:${port}`;
};

const get = async (base, route) => {
  const res = await fetch(base + route);
  return { status: res.status, body: await res.json() };
};

const post = async (base, route, payload) => {
  const res = await fetch(base + route, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  return { status: res.status, body: await res.json() };
};

const seeded = () => {
  const db = openDb(":memory:");
  seedDb(db);
  return db;
};

afterEach(async () => {
  await Promise.all(open.map((s) => new Promise((r) => s.close(r))));
  open = [];
});

describe("сторінка й довідники", () => {
  test("корінь віддає HTML", async () => {
    const base = await listen({ db: seeded(), model: new Scripted([]) });
    const res = await fetch(base + "/");
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("<title>Приймання поставки</title>");
  });

  test("сторінка з поясненням віддається з власним скелетом", async () => {
    const base = await listen({ db: seeded(), model: new Scripted([]) });
    const res = await fetch(base + "/shlyah");
    expect(res.status).toBe(200);
    const html = await res.text();
    // Копія артефакта: там скелет додає платформа, тут він мусить бути свій,
    // інакше браузер рендерить у quirks mode.
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain("<title>Шлях накладної</title>");
    expect(html).toContain("</body>");
  });

  test("файл у web/ не стає маршрутом сам собою", async () => {
    const base = await listen({ db: seeded(), model: new Scripted([]) });
    for (const bad of ["/shlyah.html", "/../package.json", "/web/index.html"]) {
      expect((await fetch(base + bad)).status).toBe(404);
    }
  });

  test("вхідні перелічують фікстури з типом", async () => {
    const base = await listen({ db: seeded(), model: new Scripted([]) });
    const { body } = await get(base, "/api/inbox");
    expect(body.map((f) => f.name)).toContain("clean-01-molochka.txt");
    expect(body.find((f) => f.name.endsWith(".xlsx")).kind).toBe("xlsx");
    expect(body.every((f) => f.size > 0)).toBe(true);
  });

  test("коди причин приходять людською мовою", async () => {
    const base = await listen({ db: seeded(), model: new Scripted([]) });
    const { body } = await get(base, "/api/reasons");
    expect(body.price_above_protocol).toBe("ціна вище протоколу");
  });

  test("невідомий маршрут — 404, а не падіння", async () => {
    const base = await listen({ db: seeded(), model: new Scripted([]) });
    const { status, body } = await get(base, "/api/немає");
    expect(status).toBe(404);
    expect(body.error).toContain("маршруту");
  });
});

describe("лист", () => {
  test("віддає текст і thread_id ще до прогону", async () => {
    const base = await listen({ db: seeded(), model: new Scripted([]) });
    const { body } = await get(base, "/api/letter?file=clean-01-molochka.txt");
    expect(body.text).toContain("РН-5512");
    expect(body.kind).toBe("txt");
    expect(body.threadId).toMatch(/^[0-9a-f]{64}$/);
  });

  test("xlsx приходить і текстом, і рядками", async () => {
    const base = await listen({ db: seeded(), model: new Scripted([]) });
    const { body } = await get(base, "/api/letter?file=clean-03-ovochi.xlsx");
    expect(body.kind).toBe("xlsx");
    expect(body.rows[1]).toEqual(["ЄДРПОУ", "39104523"]);
  });

  test("шлях із браузера не виводить за теку фікстур", async () => {
    const base = await listen({ db: seeded(), model: new Scripted([]) });
    for (const bad of [
      "../../package.json",
      "..%2F..%2Fpackage.json",
      "/etc/passwd",
      "src/db.mjs",
      "clean-01-molochka.txt.bak",
    ]) {
      const { status } = await get(base, `/api/letter?file=${encodeURIComponent(bad)}`);
      expect(status).toBeGreaterThanOrEqual(400);
    }
  });
});

describe("прогін і рішення", () => {
  test("чистий документ проводиться, трасування показує всі виклики", async () => {
    const db = seeded();
    const base = await listen({ db, model: new Scripted([docReply(), ...picks()]) });
    const { body } = await post(base, "/api/intake", { file: "clean-01-molochka.txt" });

    expect(body.status).toBe("posted");
    expect(body.paused).toBeNull();
    expect(body.receipt.totalNetKop).toBe(373840);
    expect(body.trace.map((c) => c.kind)).toEqual(["extract", "match", "match", "match", "match"]);
    expect(body.trace[0].prompt).toContain("Накладна № РН-5512");
    expect(body.trace[0].reply).toContain("РН-5512");
  });

  test("розбіжність повертає паузу з рядками й розбіжностями", async () => {
    const db = seeded();
    const base = await listen({ db, model: new Scripted([docReply(overPriced()), ...picks()]) });
    const { body } = await post(base, "/api/intake", { file: "r01-cina-vyshche.txt" });

    expect(body.status).toBe("needs_review");
    expect(body.paused.issues.map((i) => i.code)).toEqual(["price_above_protocol"]);
    expect(body.paused.lines).toHaveLength(4);
    expect(body.paused.lines[2].priceKop).toBe(4990);
    expect(receiptOf(db, body.threadId)).toBeNull();
  });

  test("часткове приймання через галочки", async () => {
    const db = seeded();
    const base = await listen({
      db,
      model: new Scripted([docReply(overPriced()), ...picks(), "Просимо погодити ціну."]),
    });
    const intake = await post(base, "/api/intake", { file: "r01-cina-vyshche.txt" });
    const { body } = await post(base, "/api/resume", {
      thread: intake.body.threadId,
      action: "partial",
      lines: [0, 1],
    });

    expect(body.status).toBe("partial");
    expect(body.receipt.totalNetKop).toBe(135600);
    expect(body.message).toContain("погодити ціну");
    expect(db.prepare("SELECT count(*) n FROM receipt_line").get().n).toBe(2);
  });

  test("відмова не створює накладної", async () => {
    const db = seeded();
    const base = await listen({
      db,
      model: new Scripted([docReply(overPriced()), ...picks(), "Відмовляємо."]),
    });
    const intake = await post(base, "/api/intake", { file: "r01-cina-vyshche.txt" });
    const { body } = await post(base, "/api/resume", {
      thread: intake.body.threadId,
      action: "reject",
    });

    expect(body.status).toBe("rejected");
    expect(body.receipt).toBeNull();
  });

  test("черга, накладні й аляси видно одним запитом", async () => {
    const db = seeded();
    const base = await listen({
      db,
      model: new Scripted([docReply(overPriced()), ...picks(), "текст"]),
    });
    const intake = await post(base, "/api/intake", { file: "r01-cina-vyshche.txt" });

    const paused = await get(base, "/api/queue");
    expect(paused.body.pending).toHaveLength(1);
    expect(paused.body.receipts).toEqual([]);

    await post(base, "/api/resume", { thread: intake.body.threadId, action: "approve" });

    const done = await get(base, "/api/queue");
    expect(done.body.pending).toEqual([]);
    expect(done.body.receipts[0].docNumber).toBe("РН-5540");
    expect(done.body.aliases).toHaveLength(4);
    expect(done.body.acts).toHaveLength(1);
  });

  test("стан треда читається без моделі — для відкриття з черги", async () => {
    const db = seeded();
    const base = await listen({ db, model: new Scripted([docReply(overPriced()), ...picks()]) });
    const intake = await post(base, "/api/intake", { file: "r01-cina-vyshche.txt" });

    const { body } = await get(base, `/api/thread?id=${intake.body.threadId}`);
    expect(body.next).toEqual(["review"]);
    expect(body.doc.docNumber).toBe("РН-5540");
    expect(body.issues.map((i) => i.code)).toEqual(["price_above_protocol"]);
  });

  test("треда немає → 404", async () => {
    const base = await listen({ db: seeded(), model: new Scripted([]) });
    expect((await get(base, "/api/thread?id=вигадка")).status).toBe(404);
    expect((await post(base, "/api/resume", { thread: "вигадка", action: "approve" })).status).toBe(404);
  });

  test("падіння шлюзу віддається як відновлюване, а не як 500", async () => {
    const db = seeded();
    const base = await listen({
      db,
      model: new Scripted([docReply(), new Error("502 Bad Gateway")]),
    });
    const { status, body } = await post(base, "/api/intake", { file: "clean-01-molochka.txt" });

    expect(status).toBe(200);
    expect(body.failed).toContain("502");
    expect(body.resumable).toBe(true);
    // Витяг уже в чекпойнті: у трасі він є, і повторювати його не доведеться.
    expect(body.trace[0].kind).toBe("extract");
    expect(body.trace.at(-1).error).toContain("502");
  });
});
