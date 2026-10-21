import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { intake, normalizeContent } from "../src/intake.mjs";

const INBOX = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "inbox");
const fixture = (name) => path.join(INBOX, name);

describe("AC-1 — формати входу", () => {
  test("txt читається як текст", async () => {
    const { source, raw } = await intake(fixture("clean-01-molochka.txt"));
    expect(source.kind).toBe("txt");
    expect(raw.text).toContain("РН-5512");
    expect(raw.text).toContain("ЄДРПОУ 31245678");
  });

  test("xlsx перетворюється на рядки й на текст для LLM", async () => {
    const { source, raw } = await intake(fixture("clean-03-ovochi.xlsx"));
    expect(source.kind).toBe("xlsx");
    expect(raw.rows.length).toBeGreaterThan(8);
    expect(raw.rows[1]).toEqual(["ЄДРПОУ", "39104523"]);
    // числа лишаються числами — саме цим xlsx відрізняється від txt
    const potato = raw.rows.find((r) => String(r[1]).startsWith("Картопля"));
    expect(potato[3]).toBe(150);
    expect(potato[4]).toBe(14.2);
    expect(raw.text).toContain("Картопля біла");
  });

  test("невідоме розширення читається як текст, а не падає", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "supply-"));
    const file = path.join(dir, "лист.eml");
    await writeFile(file, "Накладна № 1 від 21.10.2026", "utf8");
    const { source, raw } = await intake(file);
    expect(source.kind).toBe("txt");
    expect(raw.text).toContain("Накладна");
  });
});

describe("AC-25 — thread_id як ідемпотентність", () => {
  test("той самий вміст дає той самий thread_id", async () => {
    const a = await intake(fixture("clean-01-molochka.txt"));
    const b = await intake(fixture("dubl-clean-01.txt"));
    expect(a.threadId).toBe(b.threadId);
    expect(a.threadId).toMatch(/^[0-9a-f]{64}$/);
  });

  test("різні документи дають різні thread_id", async () => {
    const a = await intake(fixture("clean-01-molochka.txt"));
    const b = await intake(fixture("r01-cina-vyshche.txt"));
    expect(a.threadId).not.toBe(b.threadId);
  });

  test("CRLF, BOM і кінцеві пробіли на thread_id не впливають", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "supply-"));
    const plain = path.join(dir, "a.txt");
    const mangled = path.join(dir, "b.txt");
    await writeFile(plain, "Накладна № 1\nМолоко — 24 шт\n", "utf8");
    await writeFile(mangled, "﻿Накладна № 1  \r\nМолоко — 24 шт\r\n\r\n", "utf8");
    const a = await intake(plain);
    const b = await intake(mangled);
    expect(a.threadId).toBe(b.threadId);
  });

  test("normalizeContent не склеює рядки й не чіпає внутрішні пробіли", () => {
    expect(normalizeContent("а  б\r\nв\t\n")).toBe("а  б\nв");
  });
});
