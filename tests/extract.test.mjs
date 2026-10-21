import { FakeListChatModel } from "@langchain/core/utils/testing";

import { extract, ExtractError } from "../src/extract.mjs";

const LINES = [
  { rawName: "Молоко пастеризоване 2,6% 900г п/е", qty: 24, unit: "шт", price: "38,90", expiresOn: null },
  { rawName: "Кефір 2,5% 450г", qty: 16, unit: "шт", price: "26,40", expiresOn: null },
];

const reply = (over = {}) =>
  JSON.stringify({
    supplierEdrpou: "31245678",
    supplierName: "ТОВ «Молочний Дім»",
    storeCode: "KV-LUK",
    poNumber: "PO-2026-1041",
    docNumber: "РН-5512",
    docDate: "2026-10-21",
    pricesIncludeVat: false,
    total: "3738,40",
    lines: LINES,
    ...over,
  });

const fake = (...responses) => new FakeListChatModel({ responses });

/** Модель, яка запам'ятовує промпти: потрібно перевірити, що ретрай несе текст помилки. */
class Recorder {
  constructor(responses) {
    this.responses = responses;
    this.prompts = [];
  }

  async invoke(prompt) {
    this.prompts.push(prompt);
    return this.responses[this.prompts.length - 1] ?? "";
  }
}

describe("AC-3 — витяг структури", () => {
  test("валідний JSON з першої спроби", async () => {
    const { doc, attempt } = await extract({ model: fake(reply()), text: "неважливо" });
    expect(attempt).toBe(1);
    expect(doc.docNumber).toBe("РН-5512");
    expect(doc.supplierEdrpou).toBe("31245678");
    expect(doc.storeCode).toBe("KV-LUK");
    expect(doc.pricesIncludeVat).toBe(false);
    expect(doc.lines).toHaveLength(2);
  });

  test("AC-4: ціни й підсумок приходять копійками, а не гривнями", async () => {
    const { doc } = await extract({ model: fake(reply()), text: "неважливо" });
    expect(doc.lines.map((l) => l.priceKop)).toEqual([3890, 2640]);
    expect(doc.totalKop).toBe(373840);
    expect(doc.lines[0].price).toBeUndefined();
  });

  test("JSON в огорожі й з привітанням все одно читається", async () => {
    const wrapped = `Доброго дня! Ось розібрана накладна:\n\n\`\`\`json\n${reply()}\n\`\`\`\n\nЗвертайтесь.`;
    const { doc } = await extract({ model: fake(wrapped), text: "неважливо" });
    expect(doc.docNumber).toBe("РН-5512");
  });

  test("зламаний JSON з першої спроби, валідний з другої → attempt 2", async () => {
    const { doc, attempt } = await extract({
      model: fake("це не JSON, а вибачення", reply()),
      text: "неважливо",
    });
    expect(attempt).toBe(2);
    expect(doc.docNumber).toBe("РН-5512");
  });

  test("ретрай несе моделі текст попередньої помилки", async () => {
    const model = new Recorder(["зовсім не те", reply()]);
    await extract({ model, text: "документ" });
    expect(model.prompts).toHaveLength(2);
    expect(model.prompts[0]).not.toContain("Попередня спроба");
    expect(model.prompts[1]).toContain("Попередня спроба не підійшла");
    expect(model.prompts[1]).toContain("JSON-об'єкта");
  });

  test("помилку схеми теж видно в ретраї, з назвою поля", async () => {
    const model = new Recorder([reply({ docDate: "21.10.2026" }), reply()]);
    const { attempt } = await extract({ model, text: "документ" });
    expect(attempt).toBe(2);
    expect(model.prompts[1]).toContain("docDate");
  });

  test("усі спроби витрачено → ExtractError, а не тихий порожній результат", async () => {
    const model = fake("ні", "знову ні");
    await expect(extract({ model, text: "документ" })).rejects.toThrow(ExtractError);
    await expect(extract({ model, text: "документ" })).rejects.toMatchObject({ attempts: 2 });
  });

  test("ліміт спроб дотримується: третього виклику не буде", async () => {
    const model = new Recorder(["ні", "ні", reply()]);
    await expect(extract({ model, text: "документ", attempts: 2 })).rejects.toThrow(ExtractError);
    expect(model.prompts).toHaveLength(2);
  });
});

describe("AC-3 — межі схеми", () => {
  test("документ без рядків не проходить", async () => {
    const model = fake(reply({ lines: [] }), reply({ lines: [] }));
    await expect(extract({ model, text: "документ" })).rejects.toThrow(ExtractError);
  });

  test("ЄДРПОУ не з цифр відхиляється", async () => {
    const model = new Recorder([reply({ supplierEdrpou: "ТОВ Молочний Дім" }), reply()]);
    const { attempt } = await extract({ model, text: "документ" });
    expect(attempt).toBe(2);
    expect(model.prompts[1]).toContain("supplierEdrpou");
  });

  test("AC-2: магазину в документі немає → storeCode null, а не вигаданий код", async () => {
    const { doc } = await extract({ model: fake(reply({ storeCode: null })), text: "документ" });
    expect(doc.storeCode).toBeNull();
  });

  test("нечитабельна ціна — це помилка витягу, а не нуль у накладній", async () => {
    const broken = reply({ lines: [{ ...LINES[0], price: "за домовленістю" }] });
    const model = new Recorder([broken, reply()]);
    const { attempt } = await extract({ model, text: "документ" });
    expect(attempt).toBe(2);
    expect(model.prompts[1]).toContain("за домовленістю");
  });

  test("qty рядком модель теж іноді віддає — приводимо до числа", async () => {
    const asText = reply({ lines: [{ ...LINES[0], qty: "24" }] });
    const { doc } = await extract({ model: fake(asText), text: "документ" });
    expect(doc.lines[0].qty).toBe(24);
  });

  test("термін придатності з рядка доїжджає до стану", async () => {
    const withDate = reply({ lines: [{ ...LINES[0], expiresOn: "2026-10-23" }] });
    const { doc } = await extract({ model: fake(withDate), text: "документ" });
    expect(doc.lines[0].expiresOn).toBe("2026-10-23");
  });
});
