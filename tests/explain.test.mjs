import { explainIssues, issueLines, reasonText } from "../src/explain.mjs";
import { Scripted } from "./helpers.mjs";

const doc = {
  docNumber: "РН-5512",
  docDate: "2026-10-21",
  totalKop: 379360,
  lines: [
    { rawName: "Молоко пастеризоване 2,6% 900г п/е", qty: 24, priceKop: 3890 },
    { rawName: "Сметана 20% 350г", qty: 24, priceKop: 4990 },
  ],
};

const issues = [
  {
    lineIdx: 1,
    code: "price_above_protocol",
    detail: "MLK-006: 4990 коп проти протокольних 4760 коп",
    blocking: true,
  },
  { lineIdx: 0, code: "under_delivery", detail: "MLK-001: привезли 24, заявлено 30", blocking: false },
];

describe("AC-24 — текст для постачальника", () => {
  test("віддає те, що написала модель", async () => {
    const model = new Scripted(["Просимо погодити нову ціну протоколом."]);
    const message = await explainIssues({ model, doc, issues, accepted: [0] });
    expect(message).toBe("Просимо погодити нову ціну протоколом.");
  });

  test("у промпті моделі вже готові цифри, і прямо сказано їх не рахувати", async () => {
    const model = new Scripted(["текст"]);
    await explainIssues({ model, doc, issues, accepted: [0], supplierName: "ТОВ «Молочний Дім»" });
    const prompt = model.prompts[0];
    expect(prompt).toContain("РН-5512");
    expect(prompt).toContain("4990 коп проти протокольних 4760 коп");
    expect(prompt).toContain("не перераховуй");
    expect(prompt).toContain("Молочний Дім");
    expect(prompt).toContain("3793,60");
  });

  test("модель відвалилась → детермінований текст, а не виняток", async () => {
    // Накладна на цей момент уже проведена: втратити прогін через генератор тексту
    // було б найдурнішою з можливих причин.
    const model = new Scripted([new Error("502 Bad Gateway")]);
    const message = await explainIssues({ model, doc, issues, accepted: [0] });
    expect(message).toContain("Акт розбіжностей до накладної РН-5512");
    expect(message).toContain("ціна вище протоколу");
    expect(message).toContain("Прийнято рядків: 1.");
  });

  describe("дві суми, обидві підписані", () => {
    // Через голий «підсумок документа» лист про часткове приймання називав суму,
    // якої ніхто не приймав.
    test("у промпті вони розрізнені, і сказано їх не плутати", async () => {
      const model = new Scripted(["текст"]);
      await explainIssues({ model, doc, issues, accepted: [0], acceptedTotalKop: 93360 });
      const prompt = model.prompts[0];
      expect(prompt).toContain("Сума за документом постачальника: 3793,60 грн без ПДВ.");
      expect(prompt).toContain("Прийнято на суму: 933,60 грн без ПДВ.");
      expect(prompt).toContain("різні числа");
    });

    test("у детермінованому запасі — так само", async () => {
      const message = await explainIssues({
        model: new Scripted([new Error("502")]),
        doc,
        issues,
        accepted: [0],
        acceptedTotalKop: 93360,
      });
      expect(message).toContain("Сума за документом постачальника: 3793,60 грн без ПДВ.");
      expect(message).toContain("Прийнято на суму: 933,60 грн без ПДВ.");
    });

    test("документ із цінами з ПДВ підписаний як з ПДВ", async () => {
      const model = new Scripted(["текст"]);
      await explainIssues({
        model,
        doc: { ...doc, pricesIncludeVat: true },
        issues,
        accepted: [],
      });
      expect(model.prompts[0]).toContain("3793,60 грн з ПДВ.");
    });

    test("нічого не прийнято → про прийняту суму ні слова", async () => {
      const model = new Scripted(["текст"]);
      await explainIssues({ model, doc, issues, accepted: [] });
      expect(model.prompts[0]).toContain("Сума за документом постачальника");
      expect(model.prompts[0]).not.toContain("Прийнято на суму");
    });
  });

  test("порожня відповідь моделі — теж запас", async () => {
    const message = await explainIssues({ model: new Scripted(["   "]), doc, issues });
    expect(message).toContain("Акт розбіжностей");
    expect(message).toContain("Приймання не відбулося.");
  });

  test("запас працює і без документа — коли витяг провалився", async () => {
    const failed = [{ lineIdx: null, code: "extract_failed", detail: "у відповіді немає JSON", blocking: true }];
    const message = await explainIssues({
      model: new Scripted([new Error("знову 502")]),
      doc: null,
      issues: failed,
    });
    expect(message).toContain("без номера");
    expect(message).toContain("документ не вдалося прочитати");
  });
});

describe("issueLines / reasonText", () => {
  test("рядки нумеруються з одиниці, неблокуючі позначені", () => {
    expect(issueLines(doc, issues)).toEqual([
      "2. Сметана 20% 350г — ціна вище протоколу: MLK-006: 4990 коп проти протокольних 4760 коп",
      "1. Молоко пастеризоване 2,6% 900г п/е — недопоставка проти заявки (не блокує приймання): MLK-001: привезли 24, заявлено 30",
    ]);
  });

  test("розбіжність рівня документа підписана як документ", () => {
    const docLevel = [{ lineIdx: null, code: "total_mismatch", detail: "сума рядків 1 коп", blocking: true }];
    expect(issueLines(doc, docLevel)[0]).toMatch(/^документ — сума документа не дорівнює сумі рядків/);
  });

  test("усі коди правил мають людську назву", () => {
    const codes = [
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
    ];
    for (const code of codes) expect(reasonText(code)).not.toBe(code);
  });

  test("невідомий код віддається як є, а не ховається", () => {
    expect(reasonText("щось_нове")).toBe("щось_нове");
  });
});
