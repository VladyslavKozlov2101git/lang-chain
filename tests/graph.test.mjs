import path from "node:path";
import { fileURLToPath } from "node:url";

import { allSkus, openDb, pendingReviews, receiptOf } from "../src/db.mjs";
import {
  cfg,
  docReply,
  graphOver,
  interruptOf,
  LINES,
  overPriced,
  picks,
  resume,
  run,
  Scripted,
  ScriptedJudge,
  setup,
  TODAY,
} from "./helpers.mjs";

describe("AC-19 — чистий документ проводиться без людини", () => {
  test("статус posted, накладна в БД, черга review порожня", async () => {
    const { db } = await setup();
    const model = new Scripted([docReply(), ...picks()]);
    const out = await run(graphOver(db, model), "t-clean");

    expect(interruptOf(out)).toBeNull();
    expect(out.status).toBe("posted");
    expect(out.issues).toEqual([]);

    const receipt = receiptOf(db, "t-clean");
    expect(receipt.status).toBe("posted");
    expect(receipt.totalNetKop).toBe(373840);
    expect(db.prepare("SELECT count(*) n FROM receipt_line").get().n).toBe(4);
    expect(pendingReviews(db)).toEqual([]);
    // акта немає: нема про що писати постачальнику
    expect(db.prepare("SELECT count(*) n FROM discrepancy_act").get().n).toBe(0);
  });

  test("без рішення людини алясів не з'являється", async () => {
    const { db } = await setup();
    await run(graphOver(db, new Scripted([docReply(), ...picks()])), "t-clean");
    expect(db.prepare("SELECT count(*) n FROM sku_alias").get().n).toBe(0);
  });
});

describe("AC-20 — блокуюча розбіжність спиняє граф", () => {
  test("interrupt із таблицею розбіжностей, накладної немає, тред у черзі", async () => {
    const { db } = await setup();
    const model = new Scripted([docReply(overPriced()), ...picks()]);
    const out = await run(graphOver(db, model), "t-r01");

    const paused = interruptOf(out);
    expect(paused.docNumber).toBe("PH-5540");
    expect(paused.issues.map((i) => i.code)).toEqual(["price_above_protocol"]);
    expect(receiptOf(db, "t-r01")).toBeNull();

    const queue = pendingReviews(db);
    expect(queue).toHaveLength(1);
    expect(queue[0]).toMatchObject({ threadId: "t-r01", docNumber: "PH-5540", issuesCount: 1 });
  });

  test("AC-21: resume --approve проводить усі рядки й пише акт", async () => {
    const { db } = await setup();
    const model = new Scripted([docReply(overPriced()), ...picks(), "Доброго дня! Просимо погодити ціну."]);
    const graph = graphOver(db, model);
    await run(graph, "t-r01");
    const out = await resume(graph, "t-r01", { action: "approve" });

    expect(out.status).toBe("posted");
    expect(db.prepare("SELECT count(*) n FROM receipt_line").get().n).toBe(4);
    expect(out.message).toContain("погодити ціну");
    expect(db.prepare("SELECT count(*) n FROM discrepancy_act").get().n).toBe(1);
    expect(pendingReviews(db)).toEqual([]);
  });

  test("AC-22: resume --reject не створює накладної, але створює акт", async () => {
    const { db } = await setup();
    const model = new Scripted([docReply(overPriced()), ...picks(), "Відмовляємо в прийманні."]);
    const graph = graphOver(db, model);
    await run(graph, "t-r01");
    const out = await resume(graph, "t-r01", { action: "reject" });

    expect(out.status).toBe("rejected");
    expect(receiptOf(db, "t-r01")).toBeNull();
    expect(db.prepare("SELECT count(*) n FROM discrepancy_act").get().n).toBe(1);
    expect(pendingReviews(db)).toEqual([]);
  });

  test("AC-23: часткове приймання — накладна на схвалені, акт на решту", async () => {
    const { db } = await setup();
    const model = new Scripted([docReply(overPriced()), ...picks(), "Прийнято частково."]);
    const graph = graphOver(db, model);
    await run(graph, "t-r01");
    const out = await resume(graph, "t-r01", { action: "partial", lines: [0, 1] });

    expect(out.status).toBe("partial");
    const names = db.prepare("SELECT raw_name FROM receipt_line ORDER BY id").all();
    expect(names).toHaveLength(2);
    expect(names[0].raw_name).toContain("Молоко");
    expect(receiptOf(db, "t-r01").status).toBe("partial");
    expect(db.prepare("SELECT count(*) n FROM discrepancy_act").get().n).toBe(1);
  });

  test("AC-23: відкинуті рядки не повертаються в чергу — тред закритий", async () => {
    const { db } = await setup();
    const model = new Scripted([docReply(overPriced()), ...picks(), "Прийнято частково."]);
    const graph = graphOver(db, model);
    await run(graph, "t-r01");
    await resume(graph, "t-r01", { action: "partial", lines: [0] });

    expect(pendingReviews(db)).toEqual([]);
    const state = await graph.getState(cfg("t-r01"));
    expect(state.next).toEqual([]);
  });

  test("акт містить коди причин по рядках", async () => {
    const { db } = await setup();
    const model = new Scripted([docReply(overPriced()), ...picks(), "текст"]);
    const graph = graphOver(db, model);
    await run(graph, "t-r01");
    await resume(graph, "t-r01", { action: "approve" });

    const rows = db.prepare("SELECT line_idx, reason_code FROM discrepancy_line").all();
    expect(rows).toEqual([{ line_idx: 2, reason_code: "price_above_protocol" }]);
  });
});

describe("AC-8 — аляси народжуються з підтвердження людини", () => {
  test("після approve аляси є, і наступний документ матчиться без LLM", async () => {
    const { db } = await setup();
    const first = new Scripted([docReply(overPriced()), ...picks(), "текст акта"]);
    const graph1 = graphOver(db, first);
    await run(graph1, "t-first");
    await resume(graph1, "t-first", { action: "approve" });
    expect(db.prepare("SELECT count(*) n FROM sku_alias").get().n).toBe(4);

    // Другий документ з тими самими назвами: модель кличеться лише на extract.
    const second = new Scripted([docReply({ docNumber: "РН-5513" })]);
    const out = await run(graphOver(db, second), "t-second");
    expect(out.status).toBe("posted");
    expect(second.prompts).toHaveLength(1);
    expect(out.matched.every((m) => m.via === "alias")).toBe(true);
  });
});

describe("AC-8 — чого аляс НЕ вчить", () => {
  const aliasCodes = (db) =>
    db
      .prepare(
        `SELECT s.code FROM sku_alias a JOIN sku s ON s.id = a.sku_id ORDER BY s.code`,
      )
      .all()
      .map((r) => r.code);

  test("рядок, відкинутий через ціну, аляс усе одно вчить: збіг людина не заперечила", async () => {
    const { db } = await setup();
    const model = new Scripted([docReply(overPriced()), ...picks(), "текст акта"]);
    const graph = graphOver(db, model);
    await run(graph, "t-partial");
    // Прийняті 1 і 2; сметана (3) відкинута через ціну; сир (4) — без причини.
    await resume(graph, "t-partial", { action: "partial", lines: [0, 1] });

    expect(aliasCodes(db)).toEqual(["MLK-001", "MLK-004", "MLK-006"]);
  });

  test("рядок, виключений без жодної розбіжності, аляс не вчить: причина невідома", async () => {
    const { db } = await setup();
    const model = new Scripted([docReply(overPriced()), ...picks(), "текст акта"]);
    const graph = graphOver(db, model);
    await run(graph, "t-silent");
    await resume(graph, "t-silent", { action: "partial", lines: [0, 1] });

    // MLK-011 — саме той рядок, який людина викинула молча.
    expect(aliasCodes(db)).not.toContain("MLK-011");
  });

  test("низька впевненість матчингу не вчить аляса навіть після approve", async () => {
    const { db } = await setup();
    const shaky = picks();
    shaky[0] = JSON.stringify({ code: "MLK-001", confidence: 0.5 });
    const model = new Scripted([docReply(), ...shaky, "текст акта"]);
    const graph = graphOver(db, model);
    const paused = await run(graph, "t-shaky");
    expect(interruptOf(paused).issues.map((i) => i.code)).toEqual(["no_sku_match"]);

    const out = await resume(graph, "t-shaky", { action: "approve" });
    expect(out.status).toBe("posted");
    // Рядок проведено — людина його схвалила; але вчитися на невпевненому збігу
    // не можна, бо одна галюцинація закріпилась би назавжди.
    expect(db.prepare("SELECT count(*) n FROM receipt_line").get().n).toBe(4);
    expect(aliasCodes(db)).toEqual(["MLK-004", "MLK-006", "MLK-011"]);
  });

  test("у текст акта їде прийнята сума, а не сума за документом", async () => {
    const { db } = await setup();
    const model = new Scripted([docReply(overPriced()), ...picks(), "текст акта"]);
    const graph = graphOver(db, model);
    await run(graph, "t-sums");
    await resume(graph, "t-sums", { action: "partial", lines: [0, 1] });

    const prompt = model.prompts.at(-1);
    expect(prompt).toContain("Сума за документом постачальника: 3 793,60 грн без ПДВ.");
    expect(prompt).toContain("Прийнято на суму: 1 356,00 грн без ПДВ.");
  });
});

describe("AC-25/AC-26 — ідемпотентність", () => {
  test("AC-25: той самий thread_id двічі не дає другої накладної", async () => {
    const { db } = await setup();
    const graph = graphOver(db, new Scripted([docReply(), ...picks()]));
    const first = await run(graph, "t-same");
    expect(first.status).toBe("posted");

    // Той самий лист прийшов знову: thread_id той самий, модель уже не потрібна.
    const again = await run(graph, "t-same");
    expect(again.status).toBe("posted");
    expect(db.prepare("SELECT count(*) n FROM receipt").get().n).toBe(1);
  });

  test("AC-26: той самий документ іншим каналом → duplicate, друга накладна не проходить", async () => {
    const { db } = await setup();
    await run(graphOver(db, new Scripted([docReply(), ...picks()])), "t-txt");

    // Інший хеш (лист і xlsx), той самий (ЄДРПОУ, номер, дата).
    const out = await run(graphOver(db, new Scripted([docReply(), ...picks()])), "t-xlsx");
    expect(out.status).toBe("duplicate");
    expect(db.prepare("SELECT count(*) n FROM receipt").get().n).toBe(1);
  });
});

describe("AC-3 — ретрай витягу ребром графа", () => {
  test("перша відповідь смітник, друга валідна → граф доїжджає до proведення", async () => {
    const { db } = await setup();
    const model = new Scripted(["Доброго дня, уточніть питання", docReply(), ...picks()]);
    const out = await run(graphOver(db, model), "t-retry");
    expect(out.attempt).toBe(2);
    expect(out.status).toBe("posted");
  });

  test("обидві спроби провалились → review з extract_failed, накладної немає", async () => {
    const { db } = await setup();
    const model = new Scripted(["ні", "знову ні"]);
    const out = await run(graphOver(db, model), "t-failed");

    const paused = interruptOf(out);
    expect(paused.issues.map((i) => i.code)).toEqual(["extract_failed"]);
    expect(paused.docNumber).toBeNull();
    expect(pendingReviews(db)).toHaveLength(1);
  });

  test("нечитабельний документ навіть після approve не проводиться", async () => {
    const { db } = await setup();
    const model = new Scripted(["ні", "знову ні", "Не змогли прочитати накладну."]);
    const graph = graphOver(db, model);
    await run(graph, "t-failed");
    const out = await resume(graph, "t-failed", { action: "approve" });

    expect(receiptOf(db, "t-failed")).toBeNull();
    expect(out.actId).toBeGreaterThan(0);
    expect(pendingReviews(db)).toEqual([]);
  });

  test("третьої спроби не буде", async () => {
    const { db } = await setup();
    const model = new Scripted(["ні", "знову ні"]);
    await run(graphOver(db, model), "t-limit");
    expect(model.prompts).toHaveLength(2);
  });
});

describe("AC-27 — падіння шлюзу", () => {
  test("помилка мережі летить нагору, а стан лишається відновлюваним", async () => {
    const { db } = await setup();
    const model = new Scripted([docReply(), new Error("502 Bad Gateway")]);
    const graph = graphOver(db, model);

    await expect(run(graph, "t-boom")).rejects.toThrow("502 Bad Gateway");

    // Витяг уже в чекпойнті: повтор не починає з нуля, а йде на match.
    const state = await graph.getState(cfg("t-boom"));
    expect(state.values.doc.docNumber).toBe("PH-5512");
    expect(state.next).toEqual(["match"]);
    expect(receiptOf(db, "t-boom")).toBeNull();
  });
});

describe("AC-28 — інший процес бачить тред", () => {
  test("нове з'єднання з тим самим файлом БД відновлює приймання", async () => {
    const { db, dbFile } = await setup({ file: true });
    await run(graphOver(db, new Scripted([docReply(overPriced()), ...picks()])), "t-cross");
    db.close();

    // «Другий процес»: інший DatabaseSync, інший граф, той самий файл.
    const db2 = openDb(dbFile);
    expect(pendingReviews(db2).map((r) => r.threadId)).toEqual(["t-cross"]);

    const graph2 = graphOver(db2, new Scripted(["Просимо погодити ціну протоколом."]));
    const state = await graph2.getState(cfg("t-cross"));
    expect(state.next).toEqual(["review"]);

    const out = await resume(graph2, "t-cross", { action: "approve" });
    expect(out.status).toBe("posted");
    expect(receiptOf(db2, "t-cross").totalNetKop).toBe(379360);
    expect(pendingReviews(db2)).toEqual([]);
  });
});

describe("межі", () => {
  test("невідомий магазин: проводити нікуди навіть після approve", async () => {
    const { db } = await setup();
    const model = new Scripted([
      docReply({ storeCode: "KV-XXX" }),
      ...picks(),
      "Уточніть магазин-отримувач.",
    ]);
    const graph = graphOver(db, model);
    const out = await run(graph, "t-store");
    expect(interruptOf(out).issues.map((i) => i.code)).toContain("unknown_store");

    const done = await resume(graph, "t-store", { action: "approve" });
    expect(receiptOf(db, "t-store")).toBeNull();
    expect(done.status).toBe("rejected");
  });

  test("неблокуюча розбіжність проводиться сама, але акт усе одно пишеться", async () => {
    const { db } = await setup();
    const short = {
      lines: LINES.map((l) => (l[3] === "MLK-001" ? [l[0], 18, l[2], l[3]] : l)),
      total: "3505,00",
    };
    const model = new Scripted([docReply(short), ...picks(), "Повідомляємо про недопоставку."]);
    const out = await run(graphOver(db, model), "t-under");

    expect(out.status).toBe("posted");
    expect(out.issues.map((i) => i.code)).toEqual(["under_delivery"]);
    expect(db.prepare("SELECT count(*) n FROM discrepancy_act").get().n).toBe(1);
  });

  test("ціни з ПДВ: у накладну лягає сума без ПДВ", async () => {
    const { db } = await setup();
    const skus = allSkus(db);
    const vat = (code) => skus.find((s) => s.code === code).vatRate;
    expect(vat("MLK-001")).toBe(20);

    const withVat = {
      lines: LINES.map(([name, qty, , code]) => {
        const net = { "MLK-001": 3890, "MLK-004": 2640, "MLK-006": 4760, "MLK-011": 6200 }[code];
        const gross = Math.round((net * 120) / 100);
        return [name, qty, `${Math.floor(gross / 100)},${String(gross % 100).padStart(2, "0")}`, code];
      }),
      total: null,
    };
    const model = new Scripted([docReply({ ...withVat, pricesIncludeVat: true }), ...picks()]);
    const out = await run(graphOver(db, model), "t-vat");

    expect(out.issues).toEqual([]);
    expect(receiptOf(db, "t-vat").totalNetKop).toBe(373840);
  });
});

describe("AC-31 — примітки постачальника доїжджають до рішення", () => {
  // Дірка, знайдена на живому прогоні: «позиції немає в заявці» читається як
  // помилка там, де постачальник привіз товар на пробу і прямо про це написав.
  const sample = () => ({
    note: "Поклали ящик нового йогурта на пробу, ціна протокольна",
    lines: [
      ...LINES,
      ["Йогурт суничний 2,5% 280г", 12, "25,40", "MLK-010", "на пробу, ціна протокольна"],
    ],
    total: "4043,20",
  });

  test("примітка документа й примітка рядка видні в паузі", async () => {
    const { db } = await setup();
    const lines = sample();
    const model = new Scripted([docReply(lines), ...picks(lines.lines)]);
    const out = await run(graphOver(db, model), "t-note");

    const paused = interruptOf(out);
    expect(paused.note).toBe("Поклали ящик нового йогурта на пробу, ціна протокольна");
    expect(paused.lines[4].note).toBe("на пробу, ціна протокольна");
    // Розбіжність усе одно блокуюча: пояснення не погоджує позицію.
    expect(paused.issues.map((i) => i.code)).toContain("not_in_po");
  });

  test("примітка на валідацію не впливає — це слова, не факт", async () => {
    const { db } = await setup();
    const lines = sample();
    const quiet = { ...lines, note: null, lines: lines.lines.map((l) => l.slice(0, 4)) };
    const withNote = new Scripted([docReply(lines), ...picks(lines.lines)]);
    const without = new Scripted([docReply(quiet), ...picks(quiet.lines)]);

    const a = interruptOf(await run(graphOver(db, withNote), "t-with"));
    const { db: db2 } = await setup();
    const b = interruptOf(await run(graphOver(db2, without), "t-without"));

    expect(a.issues.map((i) => i.code)).toEqual(b.issues.map((i) => i.code));
  });

  test("у листі постачальнику його ж примітка згадана", async () => {
    const { db } = await setup();
    const lines = sample();
    const model = new Scripted([docReply(lines), ...picks(lines.lines), "текст акта"]);
    const graph = graphOver(db, model);
    await run(graph, "t-note-letter");
    await resume(graph, "t-note-letter", { action: "partial", lines: [0, 1, 2, 3] });

    const prompt = model.prompts.at(-1);
    expect(prompt).toContain("на пробу, ціна протокольна");
    expect(prompt).toContain("ціну погоджують протоколом");
  });
});

describe("T16 — зіставлення через System One", () => {
  test("усі рядки одним запитом, чат-модель у матчингу не кликана", async () => {
    const { db } = await setup();
    // Одна відповідь на весь прогін — лише extract. Якщо матчинг покличе
    // чат-модель, Scripted упаде на другому виклику, і тест це покаже.
    const model = new Scripted([docReply()]);
    const judge = new ScriptedJudge(LINES.map((l) => l[3]));

    const out = await run(graphOver(db, model, (r) => judge.judge(r)), "t-jev");

    expect(out.status).toBe("posted");
    expect(model.prompts).toHaveLength(1);
    expect(judge.requests).toHaveLength(1);
    expect(judge.requests[0].state.lines).toHaveLength(LINES.length);
    expect(out.matched.every((m) => m.via === "jev")).toBe(true);
    expect(receiptOf(db, "t-jev").status).toBe("posted");
  });

  test("низький exists блокує рядок — той самий R8, але з осмисленим числом", async () => {
    const { db } = await setup();
    const model = new Scripted([docReply()]);
    // Вибір упевнений, наявність — ні: випадок «Чеддер → Гауда», заміряний на
    // живому Jev (Choice 84–100%, exists 8–13%).
    const judge = new ScriptedJudge(
      LINES.map((l) => (l[3] === "MLK-006" ? [l[3], 0.11] : l[3])),
    );

    const out = await run(graphOver(db, model, (r) => judge.judge(r)), "t-jev-low");

    expect(interruptOf(out)).not.toBeNull();
    expect(out.issues.some((i) => i.code === "no_sku_match" && i.blocking)).toBe(true);
    expect(pendingReviews(db)).toHaveLength(1);
  });

  test("аляси вчаться і з рішення над збігом від Jev, не лише від чат-моделі", async () => {
    const { db } = await setup();
    const model = new Scripted([docReply(overPriced()), "текст акта"]);
    const judge = new ScriptedJudge(LINES.map((l) => l[3]));
    const graph = graphOver(db, model, (r) => judge.judge(r));

    await run(graph, "t-jev-alias");
    await resume(graph, "t-jev-alias", { action: "approve" });

    // Було `via === "llm"`, і на цьому шляху аляси не народжувались узагалі.
    expect(db.prepare("SELECT count(*) n FROM sku_alias").get().n).toBe(LINES.length);
  });

  test("без judge граф лишається на чат-моделі", async () => {
    const { db } = await setup();
    const model = new Scripted([docReply(), ...picks()]);

    const out = await run(graphOver(db, model), "t-no-jev");

    expect(out.status).toBe("posted");
    expect(out.matched.every((m) => m.via === "llm")).toBe(true);
    expect(model.prompts).toHaveLength(1 + LINES.length);
  });
});

describe("фото й скан — вузол ocr", () => {
  const PHOTO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "inbox", "r01-cina-vyshche-foto.jpg");
  const photoInput = (threadId) => ({ threadId, source: { path: PHOTO, kind: "image" }, raw: { text: null } });
  const TRANSCRIPT = "Накладна № РН-5512 від 21.10.2026 (транскрипція)";

  test("фото розпізнається, і далі йде звичайним шляхом", async () => {
    const { db } = await setup();
    const model = new Scripted([TRANSCRIPT, docReply()]);
    const judge = new ScriptedJudge(LINES.map((l) => l[3]));

    const out = await graphOver(db, model, (r) => judge.judge(r)).invoke(photoInput("t-photo"), cfg("t-photo"));

    expect(out.status).toBe("posted");
    expect(out.raw.text).toBe(TRANSCRIPT);
    // Перший виклик — повідомлення з картинкою, другий — звичайний промпт витягу
    // з транскрипцією всередині.
    expect(Array.isArray(model.prompts[0])).toBe(true);
    expect(model.prompts[1]).toContain(TRANSCRIPT);
  });

  test("те саме фото вдруге не кличе модель узагалі — дедуп стоїть перед ocr", async () => {
    const { db } = await setup();
    const judge = new ScriptedJudge(LINES.map((l) => l[3]));
    await graphOver(db, new Scripted([TRANSCRIPT, docReply()]), (r) => judge.judge(r)).invoke(photoInput("t-twice"), cfg("t-twice"));

    const again = new Scripted([]);
    const out = await graphOver(db, again).invoke(photoInput("t-twice"), cfg("t-twice"));
    expect(out.status).toBe("posted");
    expect(again.prompts).toHaveLength(0);
  });

  test("падіння шлюзу на розпізнаванні — тред відновлюється з ocr", async () => {
    const { db } = await setup();
    await expect(
      graphOver(db, new Scripted([new Error("502 Bad Gateway")])).invoke(photoInput("t-ocr-boom"), cfg("t-ocr-boom")),
    ).rejects.toThrow("502");

    const judge = new ScriptedJudge(LINES.map((l) => l[3]));
    const graph = graphOver(db, new Scripted([TRANSCRIPT, docReply()]), (r) => judge.judge(r));
    expect((await graph.getState(cfg("t-ocr-boom"))).next).toEqual(["ocr"]);
    const out = await graph.invoke(null, cfg("t-ocr-boom"));
    expect(out.status).toBe("posted");
  });
});
