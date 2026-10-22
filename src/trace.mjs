/**
 * Обгортка моделі й судді, яка записує кожен виклик: промпт, відповідь, час.
 *
 * Потрібна, щоб у фронті й у `--trace` було видно не лише результат вузла, а і його
 * вхід — промпт із шортлістом і сире JSON у відповідь. Саме там зазвичай і лежить
 * причина, коли результат виглядає дивно.
 *
 * Обгортка, а не прапорець усередині вузлів: `extract` і `match` кличуть у моделі
 * тільки `.invoke`, а граф у судді — одну функцію, тому підміна на цьому рівні нічого
 * не знає про їхній код і нічого в ньому не псує. Якщо колись знадобиться `.stream`
 * чи `.batch` — додавати сюди, а не в вузли.
 *
 * Суддя (System One) — не чат-модель: у нього запит і відповідь — структури, а не
 * текст. У трасі вони лежать як JSON, щоб панель викликів показувала їх тим самим
 * `<pre>`, що й промпти.
 */
import { replyText } from "./text.mjs";

/** Короткий підпис виклику для логів і UI: за промптом видно, який це крок. */
export function callKind(prompt) {
  if (prompt.includes("Перетвори документ постачальника")) return "extract";
  if (prompt.includes("Варіанти з номенклатури")) return "match";
  if (prompt.includes("лист постачальнику")) return "explain";
  if (prompt.includes("Перепиши текст дослівно")) return "ocr";
  return "llm";
}

/**
 * Промпт для показу. Розпізнавання шле масив повідомлень із картинками, і base64
 * фото — це мегабайти в панелі й у терміналі. Картинку замінюємо підписом.
 */
export function promptText(prompt) {
  if (typeof prompt === "string") return prompt;
  return prompt
    .flatMap((message) => (Array.isArray(message.content) ? message.content : [{ text: message.content }]))
    .map((part) =>
      part.image_url
        ? `[зображення, ${Math.round((part.image_url.url.length * 3) / 4 / 1024)} КБ]`
        : part.text,
    )
    .join("\n");
}

const json = (value) => JSON.stringify(value, null, 2);

/**
 * @param model  чат-модель; `null`, коли граф будується лише для читання стану
 * @param judge  функція судді з `createJudge`, або `null`/`undefined` без ключа
 * @returns { model, judge, calls } — calls наповнюється по ходу прогону
 */
export function withTrace(model, judge = null) {
  const calls = [];

  const record = async (kind, prompt, call, show) => {
    const started = Date.now();
    try {
      const reply = await call();
      calls.push({ kind, prompt, reply: show(reply), ms: Date.now() - started });
      return reply;
    } catch (e) {
      calls.push({ kind, prompt, error: e.message, ms: Date.now() - started });
      throw e;
    }
  };

  return {
    calls,
    model: model && {
      invoke: (prompt) => {
        const shown = promptText(prompt);
        return record(callKind(shown), shown, () => model.invoke(prompt), replyText);
      },
    },
    judge: judge && ((request) => record("match · jev", json(request), () => judge(request), json)),
  };
}
