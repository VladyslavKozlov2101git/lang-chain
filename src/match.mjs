/**
 * Рядок документа → SKU мережі.
 *
 * Дві третини роботи робить детермінований код, і це не економія на LLM, а умова
 * керованості: весь каталог у промпті ламається після ~200 SKU й дає різні відповіді
 * на однакове питання. Тому шортліст рахується тут, а модель лише вибирає з п'яти
 * варіантів і каже, наскільки впевнена.
 *
 * Аляси роблять систему дешевшою з кожним листом: підтверджений людиною збіг
 * більше ніколи не йде ні в LLM, ні до людини.
 */
import { z } from "zod";

import { normalizeName, tokens } from "./text.mjs";

const PickSchema = z.object({
  code: z.string().nullable(),
  confidence: z.coerce.number().min(0).max(1),
});

/**
 * Кандидати за перетином токенів. Токени з цифрами («2.6%», «900», «450») важать
 * удвічі: у молочці саме жирність і фасування відрізняють дві сусідні позиції,
 * тоді як слово «молоко» є в десятку назв.
 */
export function shortlist(rawName, skus, limit = 5) {
  const want = new Set(tokens(rawName));
  if (!want.size) return [];

  return skus
    .map((sku) => {
      const have = tokens(sku.name);
      let hits = 0;
      for (const token of have) if (want.has(token)) hits += /\d/.test(token) ? 2 : 1;
      // Нормалізація, щоб довга назва не вигравала самою довжиною.
      return { sku, score: hits / Math.max(have.length, want.size) };
    })
    .filter((c) => c.score > 0)
    // Код у tie-break, щоб шортліст був однаковий між прогонами.
    .sort((a, b) => b.score - a.score || a.sku.code.localeCompare(b.sku.code))
    .slice(0, limit)
    .map((c) => c.sku);
}

const textOf = (reply) => {
  if (typeof reply === "string") return reply;
  const content = reply?.content;
  if (Array.isArray(content)) return content.map((part) => part.text ?? "").join("");
  return String(content ?? "");
};

const PROMPT = (rawName, candidates) => `Ти оператор приймання товару в мережі магазинів.
Постачальник написав у накладній: "${rawName}"

Варіанти з номенклатури мережі:
${candidates.map((sku) => `${sku.code} — ${sku.name} (${sku.unit})`).join("\n")}

Вибери той, що означає той самий товар. Дивись на фасування, жирність і одиницю:
900 г і 0,9 л молока — це одне й те саме, а 350 г і 180 г сметани — ні.
Якщо жоден варіант не підходить — code: null.

Віддай ТІЛЬКИ JSON, без пояснень:
{"code": "MLK-001" | null, "confidence": 0.95}`;

async function pick({ model, rawName, candidates }) {
  const raw = textOf(await model.invoke(PROMPT(rawName, candidates)));
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end <= start) return { code: null, confidence: 0 };
  try {
    return PickSchema.parse(JSON.parse(raw.slice(start, end + 1)));
  } catch {
    // Невалідна відповідь матчингу — не аварія: рядок просто поїде до людини.
    return { code: null, confidence: 0 };
  }
}

/**
 * @param model     чат-модель; у тестах FakeListChatModel
 * @param lines     рядки документа з extract
 * @param skus      номенклатура
 * @param aliasFor  (нормалізована назва) => skuId | null — інжектується, щоб
 *                  матчинг тестувався без БД
 * @returns [{ lineIdx, skuId, confidence, via }] — via: alias | llm | none
 */
export async function matchLines({ model, lines, skus, aliasFor = () => null, limit = 5 }) {
  const byCode = new Map(skus.map((sku) => [sku.code, sku]));
  const matched = [];
  let stats = { alias: 0, llm: 0, none: 0 };

  for (const [lineIdx, line] of lines.entries()) {
    const key = normalizeName(line.rawName);

    const aliased = aliasFor(key);
    if (aliased) {
      matched.push({ lineIdx, skuId: aliased, confidence: 1, via: "alias" });
      stats.alias += 1;
      continue;
    }

    const candidates = shortlist(line.rawName, skus, limit);
    if (!candidates.length) {
      matched.push({ lineIdx, skuId: undefined, confidence: 0, via: "none" });
      stats.none += 1;
      continue;
    }

    const choice = await pick({ model, rawName: line.rawName, candidates });
    const sku = choice.code ? byCode.get(choice.code) : undefined;
    // AC-6: модель не може вийти за межі шортліста. Якщо вийшла — це не збіг.
    const inShortlist = sku && candidates.some((c) => c.id === sku.id);
    if (!inShortlist) {
      matched.push({ lineIdx, skuId: undefined, confidence: 0, via: "none" });
      stats.none += 1;
      continue;
    }

    matched.push({ lineIdx, skuId: sku.id, confidence: choice.confidence, via: "llm" });
    stats.llm += 1;
  }

  console.error(
    `[match] ${lines.length} рядків: ${stats.alias} alias, ${stats.llm} llm, ${stats.none} без збігу`,
  );
  return matched;
}
