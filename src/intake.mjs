/**
 * Вхід у флоу: файл → нормалізований текст + thread_id.
 *
 * Межа, за якою формат уже не має значення: далі граф бачить тільки `text`.
 * Новий канал (EDI) додається тут новою гілкою, не чіпаючи вузлів.
 *
 * Фото і скан — виняток: тексту в них немає, і без моделі його не дістати. Інтейк
 * моделі не кличе — він має працювати офлайн, щоб лист можна було відкрити й
 * перевірити на дубль без мережі. Тому для них `text: null`, а читає їх вузол
 * `ocr` у графі (`ocr.mjs`).
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import ExcelJS from "exceljs";

const IMAGES = new Set([".jpg", ".jpeg", ".png", ".webp", ".heic", ".heif"]);

/** Формати, які інтейк уміє читати. Решта йде як текст. */
export const ACCEPTED = /\.(txt|xlsx|pdf|jpe?g|png|webp|hei[cf])$/i;

// Менше за це — текстового шару немає, є хіба що номер сторінки чи підпис сканера.
const MIN_PDF_LETTERS = 40;

const sha256 = (data) => createHash("sha256").update(data).digest("hex");

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
 * PDF з текстовим шаром (вивантаження з облікової системи) читається як текст, без
 * моделі. Без шару — це скан, і його доведеться розпізнавати як фото.
 */
async function readPdf(file) {
  const { extractText } = await import("unpdf");
  const { text } = await extractText(new Uint8Array(await readFile(file)), { mergePages: true });
  const letters = text.match(/\p{L}/gu)?.length ?? 0;
  return letters >= MIN_PDF_LETTERS ? { kind: "pdf", text: normalizeContent(text) } : { kind: "scan" };
}

/**
 * @returns { source: {path, kind}, raw: {text, rows?}, threadId }
 *          kind: txt | xlsx | pdf | scan | image; для scan і image `text: null`
 *          threadId — sha256 нормалізованого тексту (AC-25, перший рівень ідемпотентності)
 */
export async function intake(file) {
  const ext = path.extname(file).toLowerCase();

  if (ext === ".xlsx") return withThread(file, "xlsx", await readXlsx(file));
  if (ext === ".pdf") {
    const { kind, text } = await readPdf(file);
    if (text) return withThread(file, kind, { text });
  }
  if (ext === ".pdf" || IMAGES.has(ext)) {
    // Хеш від байтів, а не від тексту: розпізнавання недетерміноване, і той самий
    // файл, надісланий двічі, інакше дав би два треди й дві накладні. Перезняте
    // фото — інші байти; його ловить другий рівень, UNIQUE на накладній.
    const kind = ext === ".pdf" ? "scan" : "image";
    return { source: { path: file, kind }, raw: { text: null }, threadId: sha256(await readFile(file)) };
  }
  return withThread(file, "txt", { text: normalizeContent(await readFile(file, "utf8")) });
}

const withThread = (file, kind, raw) => ({
  source: { path: file, kind },
  raw,
  threadId: sha256(Buffer.from(raw.text, "utf8")),
});
