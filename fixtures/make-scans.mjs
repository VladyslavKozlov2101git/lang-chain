/**
 * Генератор фікстур для каналів без тексту: `npm run fixtures`.
 *
 * Три файли з тим самим змістом, що й txt-фікстури, тому золото для них те саме:
 *
 *  - clean-01-molochka.pdf    PDF з текстовим шаром — так виглядає вивантаження з 1С;
 *  - clean-02-hlib-skan.pdf   PDF лише з картинкою — паперова накладна зі сканера;
 *  - r01-cina-vyshche-foto.jpg фото накладної на телефон: нахил, тінь, нерівне тло.
 *
 * Фото навмисно не жорстоке: фікстура має перевіряти канал, а не межу зору моделі.
 * Межу міряти окремими кейсами, коли з'являться справжні фото з магазинів.
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createCanvas, PDFDocument } from "@napi-rs/canvas";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const INBOX = path.join(HERE, "inbox");
const linesOf = (name) => readFileSync(path.join(INBOX, name), "utf8").replace(/\r/g, "").trimEnd().split("\n");

// A4 у пунктах PDF.
const W = 595;
const H = 842;
const FONT = "Arial";

/** Сторінка документа: той самий макет і в PDF, і на растрі. */
function drawPage(ctx, lines, scale = 1) {
  ctx.save();
  ctx.scale(scale, scale);
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = "#111";
  ctx.font = `11px ${FONT}`;
  lines.forEach((line, i) => ctx.fillText(line, 48, 64 + i * 17));
  ctx.restore();
}

function textPdf(lines) {
  const doc = new PDFDocument({ title: "Накладна" });
  drawPage(doc.beginPage(W, H), lines);
  doc.endPage();
  return doc.close();
}

/** Скан: сторінка растром ~150 dpi, у PDF лише картинка, тексту немає. */
function scanPdf(lines) {
  const scale = 150 / 72;
  const raster = createCanvas(Math.round(W * scale), Math.round(H * scale));
  drawPage(raster.getContext("2d"), lines, scale);
  const doc = new PDFDocument({ title: "Скан" });
  doc.beginPage(W, H).drawImage(raster, 0, 0, W, H);
  doc.endPage();
  return doc.close();
}

/** Фото: аркуш під кутом на сірому столі, тінь з одного боку. */
function photo(lines) {
  const canvas = createCanvas(1600, 2000);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#6f6a63";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  ctx.save();
  ctx.translate(140, 90);
  ctx.rotate((2.2 * Math.PI) / 180);
  ctx.shadowColor = "rgba(0,0,0,.45)";
  ctx.shadowBlur = 30;
  ctx.shadowOffsetX = 18;
  ctx.fillStyle = "#f4f1ea";
  ctx.fillRect(0, 0, W * 2.2, H * 2.2);
  ctx.shadowColor = "transparent";
  ctx.scale(2.2, 2.2);
  ctx.fillStyle = "#1d1d1f";
  ctx.font = `11px ${FONT}`;
  lines.forEach((line, i) => ctx.fillText(line, 48, 64 + i * 17));
  ctx.restore();

  // Світло з лівого верхнього кута: правий нижній темніший.
  const light = ctx.createLinearGradient(0, 0, canvas.width, canvas.height);
  light.addColorStop(0, "rgba(255,255,255,0)");
  light.addColorStop(1, "rgba(0,0,0,.28)");
  ctx.fillStyle = light;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  return canvas.toBuffer("image/jpeg", 82);
}

const out = [
  ["clean-01-molochka.pdf", textPdf(linesOf("clean-01-molochka.txt"))],
  ["clean-02-hlib-skan.pdf", scanPdf(linesOf("clean-02-hlib.txt"))],
  ["r01-cina-vyshche-foto.jpg", photo(linesOf("r01-cina-vyshche.txt"))],
];
for (const [name, bytes] of out) {
  writeFileSync(path.join(INBOX, name), bytes);
  console.log(`  ${name}: ${Math.round(bytes.length / 1024)} КБ`);
}
