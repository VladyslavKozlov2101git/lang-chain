/**
 * Чисті текстові хелпери. Ні БД, ні LLM, ні мережі.
 *
 * Живуть окремо від intake/extract/match, бо потрібні всім трьом:
 * parseKop — і для xlsx-клітинок, і для JSON від LLM; normalizeName — і для шортліста,
 * і для ключа алясів.
 */

const SPACES = /[\s   ]+/g;

/** Текст або число → цілі копійки, або null якщо це не ціна.
 *  Приймає "45,80", "45.80", "45 грн 80 коп", "1 234,56", "45", 45.8. */
export function parseKop(raw) {
  // xlsx віддає числа, не рядки.
  if (typeof raw === "number") return Number.isFinite(raw) ? Math.round(raw * 100) : null;
  if (typeof raw !== "string") return null;

  const s = raw.replace(SPACES, " ").trim().toLowerCase();
  if (!s) return null;

  // "45 грн 80 коп" / "45 грн"
  const split = s.match(/^(\d+)\s*(?:грн|uah|₴)\.?(?:\s*(\d{1,2})\s*(?:коп|к)\.?)?$/);
  if (split) return Number(split[1]) * 100 + (split[2] ? Number(split[2].padEnd(2, "0")) : 0);

  // "1 234,56" / "1234.5" / "45" / "45,80 грн"
  const num = s.replace(/(?:грн|uah|₴)\.?/g, "").replace(/ /g, "").replace(",", ".");
  if (!/^\d+(?:\.\d{1,2})?$/.test(num)) return null;
  const [int, frac = ""] = num.split(".");
  // Копійки складаємо цілими: 45.80 через множення на 100 дає 4579.999...
  return Number(int) * 100 + Number(frac.padEnd(2, "0"));
}

/** Копійки → "45,80" для виводу людині. */
export function formatUah(kop) {
  const sign = kop < 0 ? "-" : "";
  const abs = Math.abs(kop);
  return `${sign}${Math.floor(abs / 100)},${String(abs % 100).padStart(2, "0")}`;
}

// кг перед г, мл перед л — інакше коротша одиниця з'їсть довшу.
const UNITS = /(\d)\s*(кг|мл|шт|уп|пак|г|л)(?![\p{L}])/gu;

/** Назва товару → канонічний вигляд для порівняння й для ключа алясів.
 *  "Молоко Яготинське 2,6% 900г п/е" → "молоко яготинське 2.6% 900 г п е" */
export function normalizeName(raw) {
  return String(raw)
    .toLowerCase()
    .replace(SPACES, " ")
    .replace(/(\d),(\d)/g, "$1.$2") // 2,6% → 2.6%
    .replace(/(?<!\d)\.(?!\d)/g, " ") // точка не між цифрами — це пунктуація
    .replace(UNITS, "$1 $2")
    .replace(/[^\p{L}\p{N}.%]+/gu, " ")
    .replace(/ +/g, " ")
    .trim();
}

/** Токени нормалізованої назви — основа шортліста. */
export const tokens = (raw) => normalizeName(raw).split(" ").filter(Boolean);
