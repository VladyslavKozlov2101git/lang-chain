/**
 * Вхід у флоу: файл → нормалізований текст + thread_id.
 *
 * Межа, за якою формат уже не має значення: далі граф бачить тільки `text`.
 * Новий канал (PDF, EDI) додається тут новою гілкою, не чіпаючи вузлів.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import ExcelJS from "exceljs";

/** Перед хешем прибираємо те, що міняється від пересилки, а не від змісту:
 *  BOM, CRLF, кінцеві пробіли. Інакше той самий лист, перезбережений іншою
 *  поштою, дасть інший thread_id — і система проведе його вдруге. */
export const normalizeContent = (text) =>
  text
    .replace(/^﻿/, "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((row) => row.trimEnd())
    .join("\n")
    .trim();

/** Клітинка exceljs буває об'єктом: формула, rich text, посилання. */
function cellText(value) {
  if (value == null) return "";
  if (typeof value !== "object") return value;
  if (value.result !== undefined) return value.result;
  if (value.text !== undefined) return value.text;
  if (Array.isArray(value.richText)) return value.richText.map((r) => r.text).join("");
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value);
}

async function readXlsx(file) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);
  const rows = [];
  wb.worksheets[0].eachRow((row) => rows.push(row.values.slice(1).map(cellText)));
  // LLM однаково читає текст, тому таблицю віддаємо рядками з розділювачем.
  return { rows, text: rows.map((r) => r.join(" | ")).join("\n") };
}

/**
 * @returns { source: {path, kind}, raw: {text, rows?}, threadId }
 *          threadId — sha256 нормалізованого тексту (AC-25, перший рівень ідемпотентності)
 */
export async function intake(file) {
  const kind = path.extname(file).toLowerCase() === ".xlsx" ? "xlsx" : "txt";
  const raw =
    kind === "xlsx" ? await readXlsx(file) : { text: normalizeContent(await readFile(file, "utf8")) };
  const threadId = createHash("sha256").update(raw.text, "utf8").digest("hex");
  return { source: { path: file, kind }, raw, threadId };
}
