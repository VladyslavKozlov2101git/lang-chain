import { blocking, grossOf, validate } from "../src/validate.mjs";

const SKUS = {
  1: { code: "MLK-001", unit: "шт", packSize: 6, vatRate: 20, shelfLifeDays: 10, minShelfPct: 70 },
  2: { code: "VEG-001", unit: "кг", packSize: 1, vatRate: 14, shelfLifeDays: 60, minShelfPct: 50 },
};
const PROTOCOL = { 1: 3890, 2: 1420 };

const ctx = (over = {}) => ({
  store: { id: 1, code: "KV-LUK" },
  supplier: { id: 1, name: "ТОВ «Молочний Дім»" },
  po: { id: 1, number: "PO-2026-1041", lines: [{ skuId: 1, qty: 24 }] },
  skuById: new Map(Object.entries(SKUS).map(([id, s]) => [Number(id), s])),
  protocolFor: (id) => PROTOCOL[id] ?? null,
  today: "2026-10-21",
  ...over,
});

const line = (over = {}) => ({
  rawName: "Молоко пастеризоване 2,6% 900г",
  qty: 24,
  unit: "шт",
  priceKop: 3890,
  ...over,
});

const doc = (over = {}) => ({
  storeCode: "KV-LUK",
  docNumber: "РН-5512",
  docDate: "2026-10-21",
  pricesIncludeVat: false,
  totalKop: null,
  lines: [line()],
  ...over,
});

const MATCH = [{ lineIdx: 0, skuId: 1, confidence: 0.95, via: "llm" }];
const run = (d = doc(), m = MATCH, c = ctx()) => validate({ doc: d, matched: m, ctx: c });
const codes = (issues) => issues.map((i) => i.code);

test("документ без розбіжностей не породжує жодного issue", () => {
  expect(run()).toEqual([]);
});

describe("R1/R2/R3 — ціна проти протоколу", () => {
  test("AC-9: ціна вище протоколу → блокуючий price_above_protocol", () => {
    const issues = run(doc({ lines: [line({ priceKop: 3990 })] }));
    expect(codes(issues)).toEqual(["price_above_protocol"]);
    expect(blocking(issues)).toHaveLength(1);
  });

  test("AC-9: допуск нульовий — одна копійка вже розбіжність", () => {
    expect(codes(run(doc({ lines: [line({ priceKop: 3891 })] })))).toEqual([
      "price_above_protocol",
    ]);
    expect(run(doc({ lines: [line({ priceKop: 3890 })] }))).toEqual([]);
  });

  test("AC-10: ціна нижче протоколу → приймаємо, issue неблокуючий", () => {
    const issues = run(doc({ lines: [line({ priceKop: 3790 })] }));
    expect(codes(issues)).toEqual(["price_below_protocol"]);
    expect(blocking(issues)).toHaveLength(0);
  });

  test("AC-11: немає чинного протоколу → no_price_protocol", () => {
    const issues = run(doc(), MATCH, ctx({ protocolFor: () => null }));
    expect(codes(issues)).toEqual(["no_price_protocol"]);
  });
});

describe("AC-18 — ПДВ", () => {
  test("документ із ПДВ проти протоколу без ПДВ на рівній ціні не дає R1", () => {
    const withVat = doc({
      pricesIncludeVat: true,
      lines: [line({ priceKop: grossOf(3890, 20) })],
    });
    expect(run(withVat)).toEqual([]);
  });

  test("та сама цифра без позначки «з ПДВ» — це вже завищення", () => {
    expect(codes(run(doc({ lines: [line({ priceKop: grossOf(3890, 20) })] })))).toEqual([
      "price_above_protocol",
    ]);
  });

  test("з ПДВ і справді вище протоколу → R1 спрацьовує", () => {
    const withVat = doc({
      pricesIncludeVat: true,
      lines: [line({ priceKop: grossOf(3890, 20) + 1 })],
    });
    expect(codes(run(withVat))).toEqual(["price_above_protocol"]);
  });
});

describe("R4 — кратність пакування", () => {
  test("AC-12: 25 шт при кратності 6 → pack_multiple", () => {
    const issues = run(doc({ lines: [line({ qty: 25 })] }));
    expect(codes(issues)).toContain("pack_multiple");
  });

  test("AC-12: вагові товари кратністю не перевіряються", () => {
    const vegDoc = doc({ lines: [line({ rawName: "Картопля", qty: 12.5, unit: "кг", priceKop: 1420 })] });
    const vegCtx = ctx({ po: { id: 1, number: "PO-1", lines: [{ skuId: 2, qty: 12.5 }] } });
    const issues = validate({
      doc: vegDoc,
      matched: [{ lineIdx: 0, skuId: 2, confidence: 0.95, via: "llm" }],
      ctx: vegCtx,
    });
    expect(codes(issues)).toEqual([]);
  });
});

describe("R5/R6/R9 — кількість проти заявки", () => {
  test("AC-13: привезли більше заявленого → блокуючий over_po", () => {
    const issues = run(doc({ lines: [line({ qty: 30 })] }));
    expect(codes(issues)).toEqual(["over_po"]);
    expect(blocking(issues)).toHaveLength(1);
  });

  test("AC-14: привезли менше → under_delivery, неблокуючий", () => {
    const issues = run(doc({ lines: [line({ qty: 18 })] }));
    expect(codes(issues)).toEqual(["under_delivery"]);
    expect(blocking(issues)).toHaveLength(0);
  });

  test("AC-13: розбита на два рядки позиція звіряється сумою, не рядком", () => {
    const split = doc({ lines: [line({ qty: 12 }), line({ qty: 18 })] });
    const issues = run(split, [
      { lineIdx: 0, skuId: 1, confidence: 0.95, via: "llm" },
      { lineIdx: 1, skuId: 1, confidence: 0.95, via: "llm" },
    ]);
    // 12 + 18 = 30 проти заявлених 24 — одна розбіжність, не дві «недопоставки»
    expect(codes(issues)).toEqual(["over_po"]);
  });

  test("AC-16: позиції немає в заявці → not_in_po", () => {
    const issues = run(doc({ lines: [line({ rawName: "Картопля", qty: 10, priceKop: 1420 })] }), [
      { lineIdx: 0, skuId: 2, confidence: 0.95, via: "llm" },
    ]);
    expect(codes(issues)).toContain("not_in_po");
  });

  test("AC-16: заявки немає взагалі → розбіжність рівня документа", () => {
    const issues = run(doc(), MATCH, ctx({ po: null }));
    expect(issues).toEqual([
      expect.objectContaining({ lineIdx: null, code: "not_in_po", blocking: true }),
    ]);
  });
});

describe("R7 — залишковий термін", () => {
  test("AC-15: 4 дні з 10 — це 40% проти мінімальних 70% → shelf_life", () => {
    const issues = run(doc({ lines: [line({ expiresOn: "2026-10-25" })] }));
    expect(codes(issues)).toEqual(["shelf_life"]);
  });

  test("AC-15: 8 днів з 10 — 80%, претензій немає", () => {
    expect(run(doc({ lines: [line({ expiresOn: "2026-10-29" })] }))).toEqual([]);
  });

  test("AC-15: без дати на етикетці правило не вигадує розбіжність", () => {
    expect(run(doc({ lines: [line({ expiresOn: null })] }))).toEqual([]);
  });
});

describe("R8 — матчинг", () => {
  test("AC-7: впевненість нижче 0.8 → no_sku_match", () => {
    const issues = run(doc(), [{ lineIdx: 0, skuId: 1, confidence: 0.7, via: "llm" }]);
    expect(codes(issues)).toEqual(["no_sku_match"]);
    expect(issues[0].detail).toContain("0.7");
  });

  test("AC-7: рядок без збігу → no_sku_match і решта правил по ньому не йде", () => {
    const issues = run(doc({ lines: [line({ priceKop: 9990, qty: 25 })] }), []);
    expect(codes(issues)).toEqual(["no_sku_match"]);
  });

  test("AC-7: SKU, якого немає в номенклатурі", () => {
    const issues = run(doc(), [{ lineIdx: 0, skuId: 99, confidence: 1, via: "alias" }]);
    expect(codes(issues)).toEqual(["no_sku_match"]);
  });
});

describe("R10 — сума документа", () => {
  test("AC-17: сума рядків не збігається з підсумком → total_mismatch", () => {
    const issues = run(doc({ totalKop: 90000 }));
    expect(codes(issues)).toEqual(["total_mismatch"]);
    expect(issues[0].detail).toContain("93360");
  });

  test("AC-17: правильний підсумок претензій не викликає", () => {
    expect(run(doc({ totalKop: 24 * 3890 }))).toEqual([]);
  });

  test("AC-17: вагова позиція — кожен рядок округлюється окремо", () => {
    const weighed = doc({
      totalKop: Math.round(1420 * 12.5),
      lines: [line({ rawName: "Картопля", qty: 12.5, unit: "кг", priceKop: 1420 })],
    });
    const issues = validate({
      doc: weighed,
      matched: [{ lineIdx: 0, skuId: 2, confidence: 0.95, via: "llm" }],
      ctx: ctx({ po: { id: 1, number: "PO-1", lines: [{ skuId: 2, qty: 12.5 }] } }),
    });
    expect(codes(issues)).toEqual([]);
  });
});

describe("AC-2 — магазин-отримувач", () => {
  test("невідомий магазин → unknown_store рівня документа", () => {
    const issues = run(doc({ storeCode: "KV-XXX" }), MATCH, ctx({ store: null }));
    expect(issues).toEqual([
      expect.objectContaining({ lineIdx: null, code: "unknown_store", blocking: true }),
    ]);
    expect(issues[0].detail).toContain("KV-XXX");
  });
});
