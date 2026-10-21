/**
 * Текст документа → структура. Єдиний вузол, де LLM бачить вільну форму.
 *
 * Чому не `withStructuredOutput()`: він просить у провайдера function-calling або
 * `response_format: json_schema`, а шлюз opencode-go цього може не тримати — і
 * з'ясувалося б це на першому ж реальному листі. Промпт + zod + ретрай не залежить
 * від можливостей провайдера, а ретрай-ребро в графі все одно потрібне.
 *
 * Ціни LLM переписує рядком «як у документі» і нічого не рахує: у копійки їх
 * переводить parseKop, бо арифметика грошей — не робота моделі.
 */
import { z } from "zod";

import { parseKop, replyText } from "./text.mjs";

export class ExtractError extends Error {
  constructor(message, { lastReply } = {}) {
    super(message);
    this.name = "ExtractError";
    this.lastReply = lastReply;
  }
}

const Line = z.object({
  rawName: z.string().min(1),
  qty: z.coerce.number().positive(),
  unit: z.string().nullable(),
  price: z.union([z.string(), z.number()]),
  expiresOn: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable(),
});

export const DocSchema = z.object({
  supplierEdrpou: z
    .string()
    .regex(/^\d{8,10}$/, "ЄДРПОУ — 8–10 цифр")
    .nullable(),
  supplierName: z.string().nullable(),
  storeCode: z.string().nullable(),
  poNumber: z.string().nullable(),
  docNumber: z.string().min(1),
  docDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "дата у форматі YYYY-MM-DD"),
  pricesIncludeVat: z.boolean(),
  total: z.union([z.string(), z.number()]).nullable(),
  lines: z.array(Line).min(1),
});

const SHAPE = `{
  "supplierEdrpou": "31245678" | null,
  "supplierName": "ТОВ «Молочний Дім»" | null,
  "storeCode": "KV-LUK" | null,
  "poNumber": "PO-2026-1041" | null,
  "docNumber": "РН-5512",
  "docDate": "2026-10-21",
  "pricesIncludeVat": false,
  "total": "3738,40" | null,
  "lines": [
    { "rawName": "Молоко пастеризоване 2,6% 900г п/е", "qty": 24, "unit": "шт",
      "price": "38,90", "expiresOn": null }
  ]
}`;

const INSTRUCTIONS = `Ти оператор приймання товару в мережі продуктових магазинів.
Перетвори документ постачальника у JSON. Нічого не рахуй, нічого не вигадуй.

Правила:
- Віддай ТІЛЬКИ JSON, без пояснень і без markdown-огорожі.
- Ціну й суму переписуй рівно так, як у документі ("38,90"). Не переводь, не округлюй,
  не перераховуй підсумок — навіть якщо бачиш, що він не сходиться.
- qty — число: 24, 12.5.
- docDate і expiresOn — YYYY-MM-DD.
- pricesIncludeVat: true лише якщо в документі прямо сказано, що ціни з ПДВ.
- storeCode — код магазину-отримувача, як у документі. Немає — null.
- Чого немає в документі — null. Рядків, яких немає, не додавай.

Схема:
${SHAPE}`;

/** Модель любить огорнути JSON у ```json … ``` або додати привітання. */
function jsonFrom(raw) {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : raw;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error("у відповіді немає JSON-об'єкта");
  return JSON.parse(body.slice(start, end + 1));
}

/** Ціни з документа → копійки. Окремим кроком після zod, щоб повідомлення про
 *  нечитабельну ціну поїхало моделі так само, як помилка схеми. */
function toKop(parsed) {
  const lines = parsed.lines.map((line, idx) => {
    const priceKop = parseKop(line.price);
    if (priceKop === null) {
      throw new Error(`рядок ${idx + 1}: ціну "${line.price}" не вдалося прочитати як число`);
    }
    return {
      rawName: line.rawName,
      qty: line.qty,
      unit: line.unit,
      priceKop,
      expiresOn: line.expiresOn,
    };
  });
  let totalKop = null;
  if (parsed.total !== null) {
    totalKop = parseKop(parsed.total);
    if (totalKop === null) {
      throw new Error(`підсумок "${parsed.total}" не вдалося прочитати як число`);
    }
  }
  const { total, ...rest } = parsed;
  return { ...rest, totalKop, lines };
}

/**
 * Одна спроба. Ретраєм керує граф: ребро `extract → extract` із попередньою
 * помилкою в `feedback`. Так кожна спроба лягає в чекпойнт окремо, і падіння
 * шлюзу на другій не губить першу.
 *
 * @param model     будь-яка чат-модель LangChain; у тестах — FakeListChatModel
 * @param text      нормалізований текст документа
 * @param feedback  текст помилки попередньої спроби, або ""
 * @returns { doc }
 * @throws ExtractError якщо відповідь не стала валідним документом
 */
export async function extract({ model, text, feedback = "" }) {
  const retry = feedback
    ? `\n\nПопередня спроба не підійшла: ${feedback}\nВиправ і віддай лише JSON.`
    : "";
  const prompt = `${INSTRUCTIONS}${retry}\n\nДокумент:\n"""\n${text}\n"""`;

  const reply = replyText(await model.invoke(prompt));
  try {
    return { doc: toKop(DocSchema.parse(jsonFrom(reply))) };
  } catch (e) {
    const message = e instanceof z.ZodError ? zodMessage(e) : e.message;
    throw new ExtractError(message, { lastReply: reply });
  }
}

const zodMessage = (error) =>
  error.issues
    .map((i) => `${i.path.join(".") || "корінь"}: ${i.message}`)
    .slice(0, 5)
    .join("; ");
