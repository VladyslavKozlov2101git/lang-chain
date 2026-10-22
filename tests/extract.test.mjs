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

/** Модель, яка запам'ятовує промпт: ретрай мусить несли текст попередньої помилки. */
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
  test("валідний JSON розбирається повністю", async () => {
    const { doc } = await extract({ model: fake(reply()), text: "неважливо" });
    expect(doc.docNumber).toBe("PH-5512");
    expect(doc.supplierEdrpou).toBe("31245678");
    expect(doc.storeCode).toBe("KV-LUK");
    expect(doc.poNumber).toBe("PO-2026-1041");
    expect(doc.pricesIncludeVat).toBe(false);
    expect(doc.lines).toHaveLength(2);
  });

  test("AC-4: ціни й підсумок приходять копійками, а не гривнями", async () => {
    const { doc } = await extract({ model: fake(reply()), text: "неважливо" });
    expect(doc.lines.map((l) => l.priceKop)).toEqual([3890, 2640]);
    expect(doc.totalKop).toBe(373840);
    // сирої ціни в стані не лишається, щоб ніхто не порахував гроші з рядка
    expect(doc.lines[0].price).toBeUndefined();
  });

  test("JSON в огорожі й з привітанням все одно читається", async () => {
    const wrapped = `Доброго дня! Ось розібрана накладна:\n\n\`\`\`json\n${reply()}\n\`\`\`\n\nЗвертайтесь.`;
    const { doc } = await extract({ model: fake(wrapped), text: "неважливо" });
    expect(doc.docNumber).toBe("PH-5512");
  });

  test("не JSON → ExtractError з причиною, а не порожній документ", async () => {
    const promise = extract({ model: fake("Доброго дня! Уточніть, що саме треба."), text: "док" });
    await expect(promise).rejects.toThrow(ExtractError);
    await expect(promise).rejects.toThrow("JSON-об'єкта");
  });

  test("feedback попередньої спроби доїжджає в промпт", async () => {
    const clean = new Recorder([reply()]);
    await extract({ model: clean, text: "документ" });
    expect(clean.prompts[0]).not.toContain("Попередня спроба");

    const retried = new Recorder([reply()]);
    await extract({ model: retried, text: "документ", feedback: "docDate: дата у форматі YYYY-MM-DD" });
    expect(retried.prompts[0]).toContain("Попередня спроба не підійшла");
    expect(retried.prompts[0]).toContain("docDate");
  });

  test("у промпті є сам документ", async () => {
    const model = new Recorder([reply()]);
    await extract({ model, text: "Накладна № РН-5512 від 21.10.2026" });
    expect(model.prompts[0]).toContain("Накладна № РН-5512");
  });
});

describe("AC-3 — межі схеми", () => {
  const rejects = async (over, expected) => {
    const promise = extract({ model: fake(reply(over)), text: "документ" });
    await expect(promise).rejects.toThrow(ExtractError);
    await expect(promise).rejects.toThrow(expected);
  };

  test("дата не в ISO відхиляється з назвою поля", () => rejects({ docDate: "21.10.2026" }, "docDate"));

  test("ЄДРПОУ не з цифр відхиляється", () =>
    rejects({ supplierEdrpou: "ТОВ Молочний Дім" }, "supplierEdrpou"));

  test("документ без рядків відхиляється", () => rejects({ lines: [] }, "lines"));

  test("нечитабельна ціна — це помилка витягу, а не нуль у накладній", () =>
    rejects({ lines: [{ ...LINES[0], price: "за домовленістю" }] }, "за домовленістю"));

  test("нечитабельний підсумок теж", () => rejects({ total: "уточнимо" }, "уточнимо"));

  test("AC-2: магазину в документі немає → storeCode null, а не вигаданий код", async () => {
    const { doc } = await extract({ model: fake(reply({ storeCode: null })), text: "документ" });
    expect(doc.storeCode).toBeNull();
  });

  test("qty рядком модель теж іноді віддає — приводимо до числа", async () => {
    const { doc } = await extract({
      model: fake(reply({ lines: [{ ...LINES[0], qty: "24" }] })),
      text: "документ",
    });
    expect(doc.lines[0].qty).toBe(24);
  });

  test("термін придатності з рядка доїжджає до стану", async () => {
    const { doc } = await extract({
      model: fake(reply({ lines: [{ ...LINES[0], expiresOn: "2026-10-23" }] })),
      text: "документ",
    });
    expect(doc.lines[0].expiresOn).toBe("2026-10-23");
  });
});

describe("примітки постачальника", () => {
  test("примітка рядка й примітка документа доїжджають у стан", async () => {
    const withNotes = reply({
      note: "Машина буде о 6:30",
      lines: [
        { ...LINES[0], note: "недоливка по лінії, вийшло менше" },
        { ...LINES[1], note: null },
      ],
    });
    const { doc } = await extract({ model: fake(withNotes), text: "документ" });
    expect(doc.note).toBe("Машина буде о 6:30");
    expect(doc.lines[0].note).toBe("недоливка по лінії, вийшло менше");
    expect(doc.lines[1].note).toBeNull();
  });

  test("без приміток поле є і дорівнює null, а не зникає", async () => {
    const { doc } = await extract({ model: fake(reply()), text: "документ" });
    expect(doc.note).toBeNull();
    expect(doc.lines.every((l) => l.note === null)).toBe(true);
  });

  test("промпт просить переписати слова постачальника, а не вигадати", async () => {
    const model = new Recorder([reply()]);
    await extract({ model, text: "документ" });
    expect(model.prompts[0]).toContain("на пробу");
    expect(model.prompts[0]).toContain("нічого не вигадуй");
  });
});

describe("ідентифікатори після витягу", () => {
  test("номери й код магазину зведені до латиниці — інакше заявку не знайти", async () => {
    const { doc } = await extract({
      model: fake(reply({ poNumber: "РО-2026-1041", docNumber: "РН-5512", storeCode: "КV-LUK" })),
      text: "лист",
    });
    expect(doc.poNumber).toBe("PO-2026-1041");
    expect(doc.docNumber).toBe("PH-5512");
    expect(doc.storeCode).toBe("KV-LUK");
    // Назви товарів не чіпаємо: на них тримаються аляси й матчинг.
    expect(doc.lines[0].rawName).toBe(LINES[0].rawName);
  });
});
