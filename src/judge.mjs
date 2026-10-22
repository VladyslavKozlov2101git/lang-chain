/**
 * Рядок документа → SKU мережі через System One (Jev).
 *
 * Альтернатива `match.mjs`, і відрізняється вона не швидкістю, а тим, яке число
 * потрапляє в R8.
 *
 * У `match.mjs` впевненість пише про себе сама чат-модель. На 473 рішеннях двох
 * різних моделей це дало чотири-п'ять унікальних значень у діапазоні [0.95, 1.0]
 * і жодного нижче 0.8 — тобто поріг `CONFIDENCE_MIN` не спрацював ні разу й за
 * такого розподілу спрацювати не може. Заміряно, записано в specs під T13.
 *
 * Тут впевненість — це окреме судження про наявність (`exists`), а не впевненість
 * вибору. Різниця не теоретична: на «Сир твердий Чеддер 50%» Choice упевнено
 * зіставляє Гауду з імовірністю 100%, і саме так народжується тиха помилка, проти
 * якої існує R8. `exists` на тому ж рядку дає 8–13%.
 *
 * Три рішення, кожне з заміру (деталі в specs/001-goods-receipt/tasks.md):
 *
 *  1. Каталог іде і в `state`, і в `criteria`. Noul без каталогу в стані відповідає
 *     монеткою (0.46–0.60 там, де відповідь очевидна) — йому нема куди дивитись.
 *     Choice без описів у `criteria` працює, але розрив між «приймати» і «до людини»
 *     падає з 64 пунктів до 8. Дублювання коштує ~$0.0007 на документ.
 *
 *  2. Усі рядки — одним запитом. Питання в межах запиту виконуються паралельно:
 *     16 рядків за 416 мс проти 3 641 мс по одному запиту на рядок.
 *
 *  3. Шортліста немає. Choice тримає до 255 опцій, і доки радять давати повний
 *     список: модель фізично не може вибрати те, чого в опціях немає, тому AC-6
 *     («модель не виходить за межі шортліста») тут не перевіряється, а
 *     забезпечується формою запиту.
 */
import { TypeSafeClient } from "@typesafe-ai/sdk";

import { normalizeName } from "./text.mjs";

/** `jev-latest` — це 1.13; 1.14 доступна як `jev-preview`. */
export const JEV_MODEL = process.env.JEV_MODEL ?? "jev-latest";

/** Межа Choice. Більший каталог доведеться вибирати двоступенево. */
export const MAX_OPTIONS = 255;

/**
 * Клієнт створюється тут, але нікуди не імпортується сам собою: граф отримує
 * його аргументом — так само, як чат-модель. Ключ SDK бере з TYPESAFE_API_KEY.
 */
export async function createJudge({ model = JEV_MODEL } = {}) {
  // Відсутність ключа — це конфігурація, а не аварія: граф лишається на чат-моделі.
  if (!process.env.TYPESAFE_API_KEY) {
    console.error("[judge] немає TYPESAFE_API_KEY — зіставлення піде через чат-модель");
    return null;
  }
  const client = new TypeSafeClient();
  return (request) => client.systemOne({ model, ...request });
}

const HOW =
  "Дивись на фасування, жирність, смак і одиницю: 900 мл і 0,9 л молока — це одне " +
  "й те саме, а 350 г і 180 г сметани — ні.";

/**
 * Ворота. Формулювання «або за назвою неможливо визначити, яка саме позиція» —
 * не стилістика: без нього питання читається як «чи є схожий товар», і «Сметана»
 * без жирності отримує високу оцінку, хоча вибрати між 20% 350 г і 15% 180 г
 * не можна.
 */
const existsQuestion = (idx) => ({
  type: "noul",
  instructions:
    `Чи є серед позицій \`catalog\` саме той товар, який постачальник назвав ` +
    `у \`lines[${idx}].rawName\`? ${HOW}`,
  criteria: {
    true: "У `catalog` є позиція, яка означає рівно цей товар.",
    false:
      "Такого товару в `catalog` немає, або за назвою неможливо визначити, " +
      "яка саме позиція мається на увазі.",
  },
});

const skuQuestion = (idx, criteria) => ({
  type: "choice",
  instructions:
    `Яка позиція номенклатури означає той самий товар, що ` +
    `\`lines[${idx}].rawName\`? ${HOW}`,
  criteria,
});

/**
 * Той самий контракт, що й у `matchLines`, навмисно: `validate.mjs` порівнює
 * `confidence` з `CONFIDENCE_MIN` і не повинен знати, звідки це число взялось.
 *
 * @param judge     (request) => Promise<response>; у тестах — заглушка
 * @param lines     рядки документа з extract
 * @param skus      номенклатура цілком
 * @param aliasFor  (нормалізована назва) => skuId | null — той самий контракт,
 *                  що й у matchLines: у БД аляс лежить під normalizeName()
 * @returns [{ lineIdx, skuId, confidence, via }] — via: alias | jev | none
 */
export async function judgeLines({ judge, lines, skus, aliasFor = () => null }) {
  if (skus.length > MAX_OPTIONS) {
    throw new Error(
      `номенклатура ${skus.length} позицій — більше за межу Choice ${MAX_OPTIONS}`,
    );
  }

  const matched = new Array(lines.length);
  const ask = [];

  // Аляси першими й без мережі: підтверджений людиною збіг більше ніколи не
  // йде ні в модель, ні до людини. Це те, що робить систему дешевшою з кожним
  // листом, і Jev цього не змінює.
  lines.forEach((line, lineIdx) => {
    const aliased = aliasFor(normalizeName(line.rawName));
    if (aliased) matched[lineIdx] = { lineIdx, skuId: aliased, confidence: 1, via: "alias" };
    else ask.push({ lineIdx, rawName: line.rawName });
  });

  if (ask.length) {
    const byCode = new Map(skus.map((sku) => [sku.code, sku]));
    const criteria = Object.fromEntries(skus.map((s) => [s.code, `${s.name} (${s.unit})`]));

    const { answers } = await judge({
      state: {
        catalog: skus.map((s) => ({ code: s.code, name: s.name, unit: s.unit })),
        lines: ask.map((a) => ({ rawName: a.rawName })),
      },
      questions: Object.fromEntries(
        ask.flatMap((_, i) => [
          [`exists_${i}`, existsQuestion(i)],
          [`sku_${i}`, skuQuestion(i, criteria)],
        ]),
      ),
    });

    ask.forEach(({ lineIdx }, i) => {
      const exists = answers[`exists_${i}`].noul;
      const sku = byCode.get(answers[`sku_${i}`].choice);
      // Вийти за межі опцій Choice не вміє, тому `sku` тут завжди є. Перевірка
      // лишається на випадок, коли каталог і запит розійшлися між викликами.
      matched[lineIdx] = sku
        ? { lineIdx, skuId: sku.id, confidence: exists, via: "jev" }
        : { lineIdx, skuId: undefined, confidence: 0, via: "none" };
    });
  }

  const stats = matched.reduce((acc, m) => ({ ...acc, [m.via]: (acc[m.via] ?? 0) + 1 }), {});
  console.error(
    `[judge] ${lines.length} рядків: ` +
      Object.entries(stats).map(([k, v]) => `${v} ${k}`).join(", "),
  );
  return matched;
}
