import { FakeListChatModel } from "@langchain/core/utils/testing";

import { aliasFor, allSkus, loadContext, openDb, putAlias, seedDb } from "../src/db.mjs";
import { matchLines, shortlist } from "../src/match.mjs";
import { normalizeName } from "../src/text.mjs";

const seeded = () => {
  const db = openDb(":memory:");
  seedDb(db);
  return db;
};

const pick = (code, confidence = 0.95) => JSON.stringify({ code, confidence });

/** Модель, яка лічить виклики: AC-5 вимагає довести, що при алясі її не кликали. */
class Counting {
  constructor(responses) {
    this.responses = responses;
    this.calls = 0;
    this.prompts = [];
  }

  async invoke(prompt) {
    this.prompts.push(prompt);
    this.calls += 1;
    return this.responses[this.calls - 1] ?? pick(null, 0);
  }
}

describe("AC-6 — шортліст", () => {
  test("ставить правильний SKU у п'ятірку, навіть коли фасування записане інакше", () => {
    const skus = allSkus(seeded());
    const top = shortlist("Молоко пастеризоване 2,6% 900г п/е", skus);
    expect(top.map((s) => s.code)).toContain("MLK-001");
    expect(top).toHaveLength(5);
  });

  test("жирність і фасування важать більше за спільне слово", () => {
    const skus = allSkus(seeded());
    const [first] = shortlist("Сметана 20% 350 г", skus);
    expect(first.code).toBe("MLK-006");
  });

  test("на назві без жодного спільного токена кандидатів немає", () => {
    const skus = allSkus(seeded());
    expect(shortlist("Автомобільний акумулятор 60Ah", skus)).toEqual([]);
    expect(shortlist("", skus)).toEqual([]);
  });

  test("порядок детермінований між прогонами", () => {
    const skus = allSkus(seeded());
    const once = shortlist("Кефір 450г", skus).map((s) => s.code);
    const twice = shortlist("Кефір 450г", [...skus].reverse()).map((s) => s.code);
    expect(once).toEqual(twice);
  });
});

describe("AC-5 — аляси", () => {
  test("аляс замикає матчинг до БД: LLM не викликається", async () => {
    const db = seeded();
    const skus = allSkus(db);
    const milk = skus.find((s) => s.code === "MLK-001");
    const supplierId = db.prepare("SELECT id FROM supplier WHERE edrpou='31245678'").get().id;
    const rawName = "Молоко пастеризоване 2,6% 900г п/е";
    putAlias(db, supplierId, normalizeName(rawName), milk.id);

    const model = new Counting([]);
    const matched = await matchLines({
      model,
      lines: [{ rawName }],
      skus,
      aliasFor: (key) => aliasFor(db, supplierId, key),
    });

    expect(model.calls).toBe(0);
    expect(matched).toEqual([{ lineIdx: 0, skuId: milk.id, confidence: 1, via: "alias" }]);
  });

  test("аляс одного постачальника не діє на іншого", () => {
    const db = seeded();
    const dairy = db.prepare("SELECT id FROM supplier WHERE edrpou='31245678'").get().id;
    const bread = db.prepare("SELECT id FROM supplier WHERE edrpou='32871045'").get().id;
    const key = normalizeName("Сметана 20% 350 г");
    putAlias(db, dairy, key, 6);
    expect(aliasFor(db, dairy, key)).toBe(6);
    expect(aliasFor(db, bread, key)).toBeNull();
  });

  test("повторний запис того самого алясу переписує, а не множить", () => {
    const db = seeded();
    const supplierId = db.prepare("SELECT id FROM supplier WHERE edrpou='31245678'").get().id;
    const key = normalizeName("Кефір 450");
    putAlias(db, supplierId, key, 4);
    putAlias(db, supplierId, key, 5);
    expect(aliasFor(db, supplierId, key)).toBe(5);
    expect(db.prepare("SELECT count(*) n FROM sku_alias").get().n).toBe(1);
  });
});

describe("AC-6/AC-7 — вибір моделі", () => {
  test("модель вибрала код із шортліста → via llm і її впевненість", async () => {
    const db = seeded();
    const skus = allSkus(db);
    const matched = await matchLines({
      model: new FakeListChatModel({ responses: [pick("MLK-001", 0.93)] }),
      lines: [{ rawName: "Молоко 2,6% 900г" }],
      skus,
    });
    const milk = skus.find((s) => s.code === "MLK-001");
    expect(matched).toEqual([{ lineIdx: 0, skuId: milk.id, confidence: 0.93, via: "llm" }]);
  });

  test("AC-6: код поза шортлістом не приймається", async () => {
    const skus = allSkus(seeded());
    // VEG-012 не має спільних токенів з молоком, отже в шортліст не попав
    const matched = await matchLines({
      model: new FakeListChatModel({ responses: [pick("VEG-012", 0.99)] }),
      lines: [{ rawName: "Молоко 2,6% 900г" }],
      skus,
    });
    expect(matched[0]).toMatchObject({ skuId: undefined, via: "none" });
  });

  test("AC-6: вигаданий код не приймається", async () => {
    const skus = allSkus(seeded());
    const matched = await matchLines({
      model: new FakeListChatModel({ responses: [pick("MLK-999", 0.99)] }),
      lines: [{ rawName: "Молоко 2,6% 900г" }],
      skus,
    });
    expect(matched[0]).toMatchObject({ skuId: undefined, via: "none" });
  });

  test("AC-7: модель сказала «немає збігу» → via none", async () => {
    const skus = allSkus(seeded());
    const matched = await matchLines({
      model: new FakeListChatModel({ responses: [pick(null, 0)] }),
      lines: [{ rawName: "Молоко 2,6% 900г" }],
      skus,
    });
    expect(matched[0]).toMatchObject({ skuId: undefined, confidence: 0, via: "none" });
  });

  test("смітник замість JSON не валить матчинг — рядок просто їде до людини", async () => {
    const skus = allSkus(seeded());
    const matched = await matchLines({
      model: new FakeListChatModel({ responses: ["Доброго дня! Не зрозумів питання."] }),
      lines: [{ rawName: "Молоко 2,6% 900г" }],
      skus,
    });
    expect(matched[0]).toMatchObject({ skuId: undefined, via: "none" });
  });

  test("низьку впевненість матчинг передає як є — поріг тримає validate", async () => {
    const skus = allSkus(seeded());
    const matched = await matchLines({
      model: new FakeListChatModel({ responses: [pick("MLK-001", 0.4)] }),
      lines: [{ rawName: "Молоко 2,6% 900г" }],
      skus,
    });
    expect(matched[0]).toMatchObject({ confidence: 0.4, via: "llm" });
  });

  test("без кандидатів модель не викликається взагалі", async () => {
    const skus = allSkus(seeded());
    const model = new Counting([]);
    const matched = await matchLines({
      model,
      lines: [{ rawName: "Автомобільний акумулятор 60Ah" }],
      skus,
    });
    expect(model.calls).toBe(0);
    expect(matched[0].via).toBe("none");
  });

  test("у промпті моделі видно рівно кандидатів шортліста", async () => {
    const skus = allSkus(seeded());
    const model = new Counting([pick("MLK-001")]);
    await matchLines({ model, lines: [{ rawName: "Молоко 2,6% 900г" }], skus, limit: 3 });
    const prompt = model.prompts[0];
    expect(prompt).toContain("Молоко 2,6% 900г");
    expect(prompt.match(/^MLK-|^VEG-|^BRD-/gm) ?? []).toHaveLength(3);
  });
});

describe("loadContext", () => {
  test("знаходить постачальника, магазин і заявку за номером", () => {
    const db = seeded();
    const ctx = loadContext(db, {
      edrpou: "31245678",
      storeCode: "KV-LUK",
      poNumber: "PO-2026-1041",
      docDate: "2026-10-21",
      today: "2026-10-21",
    });
    expect(ctx.supplier.name).toContain("Молочний Дім");
    expect(ctx.store.code).toBe("KV-LUK");
    expect(ctx.po.number).toBe("PO-2026-1041");
    expect(ctx.po.lines).toHaveLength(4);
    expect(ctx.skuById.size).toBe(40);
  });

  test("без номера заявки бере останню на цю пару магазин+постачальник", () => {
    const db = seeded();
    const ctx = loadContext(db, {
      edrpou: "32871045",
      storeCode: "KV-TER",
      poNumber: null,
      docDate: "2026-10-21",
    });
    expect(ctx.po.number).toBe("PO-2026-1044");
  });

  test("невідомий магазин → store null, і заявки теж немає", () => {
    const db = seeded();
    const ctx = loadContext(db, {
      edrpou: "31245678",
      storeCode: "KV-XXX",
      poNumber: null,
      docDate: "2026-10-21",
    });
    expect(ctx.store).toBeNull();
    expect(ctx.po).toBeNull();
  });

  test("protocolFor у контексті вже знає дату документа", () => {
    const db = seeded();
    const glutenFree = allSkus(db).find((s) => s.code === "BRD-012");
    const inSeptember = loadContext(db, {
      edrpou: "32871045",
      storeCode: "KV-TER",
      docDate: "2026-09-15",
    });
    const inOctober = loadContext(db, {
      edrpou: "32871045",
      storeCode: "KV-TER",
      docDate: "2026-10-21",
    });
    expect(inSeptember.protocolFor(glutenFree.id)).toBe(6850);
    expect(inOctober.protocolFor(glutenFree.id)).toBeNull();
  });

  test("невідомий постачальник не валить читання контексту", () => {
    const db = seeded();
    const ctx = loadContext(db, { edrpou: "00000000", storeCode: "KV-LUK", docDate: "2026-10-21" });
    expect(ctx.supplier).toBeNull();
    expect(ctx.protocolFor(1)).toBeNull();
  });
});
