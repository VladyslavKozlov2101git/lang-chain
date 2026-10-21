/**
 * Генератор двох xlsx-фікстур: `npm run fixtures`.
 *
 * Бінарник у git тримати нормально, а зробити його руками — ні. Тут видно, що
 * всередині: шапка парами «ключ — значення», порожній рядок, таблиця позицій.
 * Кількості й ціни — числами, а не рядками: саме так приходить справжній xlsx,
 * і саме цим шлях відрізняється від txt, де ціна виглядає як "14,20".
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

import ExcelJS from "exceljs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

const sheet = (docNumber, lines) => [
  ["ФГ «Свіжа Нива»"],
  ["ЄДРПОУ", "39104523"],
  ["Накладна", docNumber],
  ["Дата", "21.10.2026"],
  ["Магазин", "KV-POD"],
  ["Заявка", "PO-2026-1045"],
  [],
  ["№", "Найменування", "Од.", "Кількість", "Ціна без ПДВ", "Сума"],
  ...lines.map(([name, unit, qty, price], i) => [i + 1, name, unit, qty, price, +(qty * price).toFixed(2)]),
  ["", "Разом", "", "", "", +lines.reduce((acc, [, , qty, price]) => acc + qty * price, 0).toFixed(2)],
];

const DOCS = [
  {
    file: "clean-03-ovochi.xlsx",
    rows: sheet("ВН-00817", [
      ["Картопля біла", "кг", 150, 14.2],
      ["Морква мита", "кг", 60, 16.8],
      ["Помідори тепличні", "кг", 40, 64.9],
    ]),
  },
  {
    // R5: картоплі привезли 180 проти заявлених 150.
    file: "r05-nad-zayavku.xlsx",
    rows: sheet("ВН-00823", [
      ["Картопля біла", "кг", 180, 14.2],
      ["Морква мита", "кг", 60, 16.8],
      ["Помідори тепличні", "кг", 40, 64.9],
    ]),
  },
];

for (const { file, rows } of DOCS) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Накладна");
  ws.addRows(rows);
  ws.columns = [{ width: 4 }, { width: 34 }, { width: 6 }, { width: 11 }, { width: 14 }, { width: 12 }];
  const out = path.join(HERE, "inbox", file);
  await wb.xlsx.writeFile(out);
  console.error(`[fixtures] ${file}: ${rows.length} рядків`);
}
