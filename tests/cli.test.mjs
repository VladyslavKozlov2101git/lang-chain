import path from "node:path";
import { fileURLToPath } from "node:url";

import { openDb, pendingReviews, receiptOf } from "../src/db.mjs";
import { decisionFrom, main, parseArgs } from "../src/cli.mjs";
import { docReply, LINES, overPriced, picks, Scripted, setup, TODAY } from "./helpers.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixture = (name) => path.join(ROOT, "fixtures", "inbox", name);

/** Збирає вивід команди в один рядок, щоб перевіряти, що бачить людина. */
const runCli = async (argv, { dbFile, model }) => {
  const out = [];
  const code = await main(argv, {
    dbFile,
    today: TODAY,
    log: (line) => out.push(String(line)),
    makeModel: async () => {
      if (!model) throw new Error("ця команда не повинна створювати модель");
      return model;
    },
    // Явно без Jev: тести офлайн, а ключ у середовищі розробника є.
    makeJudge: async () => null,
  });
  return { code, text: out.join("\n") };
};

describe("parseArgs / decisionFrom", () => {
  test("розбирає позиційні, --flag, --flag=значення і --flag значення", () => {
    expect(parseArgs(["intake", "лист.txt", "--approve"])).toEqual({
      _: ["intake", "лист.txt"],
      approve: true,
    });
    expect(parseArgs(["resume", "t1", "--lines=1,3"])).toEqual({ _: ["resume", "t1"], lines: "1,3" });
    expect(parseArgs(["resume", "t1", "--lines", "1,3"])).toEqual({ _: ["resume", "t1"], lines: "1,3" });
  });

  test("номери рядків людські, у графі вони з нуля", () => {
    expect(decisionFrom({ lines: "1,3" })).toEqual({ action: "partial", lines: [0, 2] });
    expect(decisionFrom({ approve: true })).toEqual({ action: "approve" });
    expect(decisionFrom({ reject: true })).toEqual({ action: "reject" });
    expect(decisionFrom({})).toBeNull();
  });

  test("сміття в --lines не стає рішенням", () => {
    expect(() => decisionFrom({ lines: "перший" })).toThrow("--lines");
    expect(() => decisionFrom({ lines: "0,1" })).toThrow("--lines");
  });
});

describe("AC-29 — команди", () => {
  test("seed друкує обсяги й не вимагає моделі", async () => {
    const { dbFile } = await setup({ file: true });
    const { code, text } = await runCli(["seed"], { dbFile });
    expect(code).toBe(0);
    expect(text).toContain("SKU 40");
    expect(text).toContain("заявок 6");
  });

  test("порожня черга так і каже", async () => {
    const { dbFile } = await setup({ file: true });
    const { code, text } = await runCli(["review"], { dbFile });
    expect(code).toBe(0);
    expect(text).toContain("черга порожня");
  });

  test("чистий документ: intake проводить і друкує накладну", async () => {
    const { dbFile } = await setup({ file: true });
    const model = new Scripted([docReply(), ...picks()]);
    const { code, text } = await runCli(["intake", fixture("clean-01-molochka.txt")], { dbFile, model });

    expect(code).toBe(0);
    expect(text).toContain("проведено повністю");
    expect(text).toContain("3 738,40 грн без ПДВ");
    expect(text).toContain("тред ");
  });

  test("розбіжність: intake спиняється, друкує таблицю й команди продовження", async () => {
    const { dbFile } = await setup({ file: true });
    const model = new Scripted([docReply(overPriced()), ...picks()]);
    const { code, text } = await runCli(["intake", fixture("r01-cina-vyshche.txt")], { dbFile, model });

    expect(code).toBe(2);
    expect(text).toContain("Потрібне рішення");
    expect(text).toContain("Сметана 20% 350г");
    expect(text).toContain("ціна вище протоколу");
    // Без приміток колонки немає взагалі.
    expect(text).not.toContain("Коментар");
    expect(text).toContain("49,90");
    expect(text).toContain("--lines 1,2");
    expect(receiptOf(openDb(dbFile), "x")).toBeNull();
  });

  test("AC-31: примітки постачальника видно в блоці рішень", async () => {
    const { dbFile } = await setup({ file: true });
    const lines = [
      ...LINES,
      ["Йогурт суничний 2,5% 280г", 12, "25,40", "MLK-010", "на пробу, ціна протокольна"],
    ];
    const model = new Scripted([
      docReply({ note: "Поклали ящик нового йогурта на пробу", lines, total: "4043,20" }),
      ...picks(lines),
    ]);
    const { code, text } = await runCli(["intake", fixture("r09-nenazvanyi-tovar.txt")], {
      dbFile,
      model,
    });

    expect(code).toBe(2);
    // Загальна примітка — над таблицею, примітка рядка — своєю колонкою.
    expect(text).toContain("постачальник пише: «Поклали ящик нового йогурта на пробу»");
    expect(text).toContain("Коментар");
    expect(text).toMatch(/Йогурт суничний.*на пробу, ціна протокольна/);
    // І розбіжність на місці: примітка пояснює, а не погоджує.
    expect(text).toContain("позиції немає в заявці");
  });

  test("review показує застряглий тред — і це працює без моделі", async () => {
    const { dbFile } = await setup({ file: true });
    const model = new Scripted([docReply(overPriced()), ...picks()]);
    await runCli(["intake", fixture("r01-cina-vyshche.txt")], { dbFile, model });

    const { code, text } = await runCli(["review"], { dbFile });
    expect(code).toBe(0);
    expect(text).toContain("PH-5540");
    expect(text).toContain("KV-LUK");
    expect(text).toContain("Молочний Дім");
  });

  test("AC-23: resume --lines 1,2 проводить частково й друкує текст постачальнику", async () => {
    const { dbFile } = await setup({ file: true });
    const intakeModel = new Scripted([docReply(overPriced()), ...picks()]);
    const file = fixture("r01-cina-vyshche.txt");
    const first = await runCli(["intake", file], { dbFile, model: intakeModel });
    const thread = first.text.match(/тред ([0-9a-f]{64})/)[1];

    const resumeModel = new Scripted(["Просимо погодити нову ціну протоколом."]);
    const { code, text } = await runCli(["resume", thread, "--lines", "1,2"], {
      dbFile,
      model: resumeModel,
    });

    expect(code).toBe(0);
    expect(text).toContain("проведено частково");
    expect(text).toContain("Текст для постачальника");
    expect(text).toContain("погодити нову ціну");

    const db = openDb(dbFile);
    expect(db.prepare("SELECT count(*) n FROM receipt_line").get().n).toBe(2);
    expect(pendingReviews(db)).toEqual([]);
  });

  test("resume без рішення на треді, що чекає людину, не вгадує за неї", async () => {
    const { dbFile } = await setup({ file: true });
    const model = new Scripted([docReply(overPriced()), ...picks()]);
    const first = await runCli(["intake", fixture("r01-cina-vyshche.txt")], { dbFile, model });
    const thread = first.text.match(/тред ([0-9a-f]{64})/)[1];

    await expect(
      runCli(["resume", thread], { dbFile, model: new Scripted([]) }),
    ).rejects.toThrow("чекає рішення");
  });

  test("resume на неіснуючому треді говорить, де дивитись", async () => {
    const { dbFile } = await setup({ file: true });
    await expect(
      runCli(["resume", "немає-такого"], { dbFile, model: new Scripted([]) }),
    ).rejects.toThrow("review");
  });

  test("AC-25: другий intake того самого листа не проводить його вдруге", async () => {
    const { dbFile } = await setup({ file: true });
    const file = fixture("clean-01-molochka.txt");
    await runCli(["intake", file], { dbFile, model: new Scripted([docReply(), ...picks()]) });

    // Модель без відповідей: якщо граф полізе в LLM — тест упаде.
    const { code, text } = await runCli(["intake", file], { dbFile, model: new Scripted([]) });
    expect(code).toBe(0);
    expect(text).toContain("проведено повністю");
    expect(openDb(dbFile).prepare("SELECT count(*) n FROM receipt").get().n).toBe(1);
  });

  test("AC-1: xlsx проходить тим самим шляхом", async () => {
    const { dbFile } = await setup({ file: true });
    const vegLines = [
      ["Картопля біла", 150, "14,20", "VEG-001"],
      ["Морква мита", 60, "16,80", "VEG-002"],
      ["Помідори тепличні", 40, "64,90", "VEG-007"],
    ];
    const model = new Scripted([
      docReply({
        docNumber: "ВН-00817",
        supplierEdrpou: "39104523",
        supplierName: "ФГ «Свіжа Нива»",
        storeCode: "KV-POD",
        poNumber: "PO-2026-1045",
        total: "5734,00",
        lines: vegLines,
      }),
      ...picks(vegLines),
    ]);
    const { code, text } = await runCli(["intake", fixture("clean-03-ovochi.xlsx")], { dbFile, model });

    expect(code).toBe(0);
    expect(text).toContain("xlsx:");
    expect(text).toContain("проведено повністю");
    expect(text).toContain("5 734,00 грн без ПДВ");
  });

  test("AC-27: падіння шлюзу друкує команду відновлення, а не стектрейс", async () => {
    const { dbFile } = await setup({ file: true });
    const model = new Scripted([docReply(), new Error("502 Bad Gateway")]);
    const { code, text } = await runCli(["intake", fixture("clean-01-molochka.txt")], { dbFile, model });

    expect(code).toBe(1);
    expect(text).toContain("502 Bad Gateway");
    expect(text).toMatch(/продовжити: node supply\.mjs resume [0-9a-f]{64}/);
  });

  test("AC-27: продовження після падіння не починає з витягу заново", async () => {
    const { dbFile } = await setup({ file: true });
    const file = fixture("clean-01-molochka.txt");
    const crashing = new Scripted([docReply(), new Error("502 Bad Gateway")]);
    const first = await runCli(["intake", file], { dbFile, model: crashing });
    const thread = first.text.match(/resume ([0-9a-f]{64})/)[1];

    // Витяг уже в чекпойнті, тому моделі лишились тільки виклики матчингу.
    const { code, text } = await runCli(["resume", thread], {
      dbFile,
      model: new Scripted(picks()),
    });
    expect(code).toBe(0);
    expect(text).toContain("проведено повністю");
  });

  test("без аргументів друкує підказку", async () => {
    const { dbFile } = await setup({ file: true });
    const { code, text } = await runCli([], { dbFile });
    expect(code).toBe(0);
    expect(text).toContain("node supply.mjs intake");
  });
});
