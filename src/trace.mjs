/**
 * Обгортка моделі, яка записує кожен виклик: промпт, відповідь, час.
 *
 * Потрібна, щоб у фронті й у `--trace` було видно не лише результат вузла, а і його
 * вхід — промпт із шортлістом і сире JSON у відповідь. Саме там зазвичай і лежить
 * причина, коли результат виглядає дивно.
 *
 * Обгортка, а не прапорець усередині вузлів: `extract` і `match` кличуть у моделі
 * тільки `.invoke`, тому підміна на рівні моделі нічого не знає про їхній код і
 * нічого в ньому не псує. Якщо колись знадобиться `.stream` чи `.batch` — додавати
 * сюди, а не в вузли.
 */
import { replyText } from "./text.mjs";

/** @returns { model, calls } — calls наповнюється по ходу прогону */
export function withTrace(model) {
  const calls = [];
  return {
    calls,
    model: {
      async invoke(prompt) {
        const started = Date.now();
        try {
          const reply = await model.invoke(prompt);
          calls.push({ prompt, reply: replyText(reply), ms: Date.now() - started });
          return reply;
        } catch (e) {
          calls.push({ prompt, error: e.message, ms: Date.now() - started });
          throw e;
        }
      },
    },
  };
}

/** Короткий підпис виклику для логів і UI: за промптом видно, який це крок. */
export function callKind(prompt) {
  if (prompt.includes("Перетвори документ постачальника")) return "extract";
  if (prompt.includes("Варіанти з номенклатури")) return "match";
  if (prompt.includes("лист постачальнику")) return "explain";
  return "llm";
}
