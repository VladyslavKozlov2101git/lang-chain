import { emptyCheckpoint } from "@langchain/langgraph-checkpoint";

import { checkpointerFor, openDb, protocolFor, seedDb, tx } from "../src/db.mjs";

const counts = (db) =>
  Object.fromEntries(
    ["store", "supplier", "sku", "price_protocol", "po", "po_line"].map((t) => [
      t,
      db.prepare(`SELECT count(*) n, coalesce(max(id),0) maxId FROM ${t}`).get(),
    ]),
  );

describe("seed", () => {
  test("лягає в порожню БД у заявлених обсягах", () => {
    const db = openDb(":memory:");
    const stats = seedDb(db);
    expect(stats).toEqual({ stores: 3, suppliers: 3, sku: 40, protocols: 40, po: 6 });
    expect(counts(db).sku.n).toBe(40);
    // 6 заявок, 4+3+3+2+3+3 рядків
    expect(counts(db).po_line.n).toBe(18);
  });

  test("другий прогін не множить рядків і не зсуває id", () => {
    const db = openDb(":memory:");
    seedDb(db);
    const before = counts(db);
    seedDb(db);
    expect(counts(db)).toEqual(before);
  });

  test("ціни з seed лежать копійками, а не гривнями", () => {
    const db = openDb(":memory:");
    seedDb(db);
    const milk = db
      .prepare(
        `SELECT price_net_kop k FROM price_protocol p
           JOIN sku s ON s.id = p.sku_id WHERE s.code = 'MLK-001'`,
      )
      .get();
    expect(milk.k).toBe(3890);
  });
});

describe("protocolFor", () => {
  const ids = (db) => ({
    bread: db.prepare("SELECT id FROM supplier WHERE edrpou='32871045'").get().id,
    glutenFree: db.prepare("SELECT id FROM sku WHERE code='BRD-012'").get().id,
    loaf: db.prepare("SELECT id FROM sku WHERE code='BRD-001'").get().id,
  });

  test("віддає чинну ціну на дату документа", () => {
    const db = openDb(":memory:");
    seedDb(db);
    const { bread, loaf } = ids(db);
    expect(protocolFor(db, bread, loaf, "2026-10-21")).toBe(2450);
  });

  test("прострочений протокол не чинний — це фікстура для R3", () => {
    const db = openDb(":memory:");
    seedDb(db);
    const { bread, glutenFree } = ids(db);
    expect(protocolFor(db, bread, glutenFree, "2026-09-15")).toBe(6850);
    expect(protocolFor(db, bread, glutenFree, "2026-10-21")).toBeNull();
  });
});

describe("чекпойнтер", () => {
  // Найризикованіше місце проєкту: офіційний SqliteSaver написаний під better-sqlite3,
  // а їздить на node:sqlite через шим. Якщо шим бреше — resume зламається тихо.
  test("put → getTuple віддає той самий стан", async () => {
    const saver = checkpointerFor(openDb(":memory:"));
    const config = { configurable: { thread_id: "t-1", checkpoint_ns: "" } };
    const checkpoint = {
      ...emptyCheckpoint(),
      channel_values: { lines: 3, store: "KV-LUK" },
      channel_versions: { lines: 1, store: 1 },
    };

    const stored = await saver.put(config, checkpoint, { source: "input", step: -1, parents: {} }, {});
    expect(stored.configurable.checkpoint_id).toBe(checkpoint.id);

    const tuple = await saver.getTuple({ configurable: { thread_id: "t-1" } });
    expect(tuple.checkpoint.channel_values).toEqual({ lines: 3, store: "KV-LUK" });
    expect(tuple.metadata.source).toBe("input");
  });

  test("putWrites проходить через транзакцію шима", async () => {
    const saver = checkpointerFor(openDb(":memory:"));
    const config = { configurable: { thread_id: "t-2", checkpoint_ns: "" } };
    const stored = await saver.put(config, emptyCheckpoint(), { source: "loop", step: 0, parents: {} }, {});

    await saver.putWrites(stored, [["lines", 4]], "task-1");

    const tuple = await saver.getTuple({ configurable: { thread_id: "t-2" } });
    expect(tuple.pendingWrites).toEqual([["task-1", "lines", 4]]);
  });

  test("два треди не бачать станів одне одного", async () => {
    const saver = checkpointerFor(openDb(":memory:"));
    for (const [thread, value] of [
      ["t-a", "перший"],
      ["t-b", "другий"],
    ]) {
      await saver.put(
        { configurable: { thread_id: thread, checkpoint_ns: "" } },
        { ...emptyCheckpoint(), channel_values: { who: value }, channel_versions: { who: 1 } },
        { source: "input", step: -1, parents: {} },
        {},
      );
    }
    const a = await saver.getTuple({ configurable: { thread_id: "t-a" } });
    const b = await saver.getTuple({ configurable: { thread_id: "t-b" } });
    expect(a.checkpoint.channel_values.who).toBe("перший");
    expect(b.checkpoint.channel_values.who).toBe("другий");
  });
});

describe("tx", () => {
  test("вкладена транзакція не падає й відкочується разом із зовнішньою", () => {
    const db = openDb(":memory:");
    seedDb(db);
    const before = counts(db).store.n;
    expect(() =>
      tx(db, () => {
        db.prepare("INSERT INTO store(code,name) VALUES('X-1','Тест')").run();
        tx(db, () => {
          throw new Error("всередині");
        });
      }),
    ).toThrow("всередині");
    expect(counts(db).store.n).toBe(before);
  });
});
