/**
 * Текст акта розбіжностей для постачальника.
 *
 * Тут LLM працює з найменшим ризиком: усі цифри вже порахував код, моделі лишається
 * скласти з них лист. Якщо модель недоступна — віддаємо детерміновану таблицю:
 * накладна на цей момент уже проведена, і втрачати її через збій генератора тексту
 * було б смішно.
 */
import { formatUah } from "./text.mjs";

const REASON = {
  price_above_protocol: "ціна вище протоколу",
  price_below_protocol: "ціна нижче протоколу",
  no_price_protocol: "немає чинного протоколу погодження цін",
  pack_multiple: "кількість не кратна пакуванню",
  over_po: "привезли більше, ніж заявлено",
  under_delivery: "недопоставка проти заявки",
  shelf_life: "залишковий термін придатності нижче норми",
  no_sku_match: "товар не зіставлений з номенклатурою мережі",
  not_in_po: "позиції немає в заявці",
  total_mismatch: "сума документа не дорівнює сумі рядків",
  unknown_store: "магазин-отримувач не визначений",
  unknown_supplier: "постачальник не визначений",
  extract_failed: "документ не вдалося прочитати",
};

export const reasonText = (code) => REASON[code] ?? code;

/** Один рядок таблиці: «3. Сметана 20% 350г — ціна вище протоколу (деталі)». */
export function issueLines(doc, issues) {
  return issues.map((issue) => {
    const name = issue.lineIdx === null ? null : doc?.lines?.[issue.lineIdx]?.rawName;
    const where = name ? `${issue.lineIdx + 1}. ${name}` : "документ";
    const flag = issue.blocking ? "" : " (не блокує приймання)";
    return `${where} — ${reasonText(issue.code)}${flag}: ${issue.detail}`;
  });
}

const textOf = (reply) => {
  if (typeof reply === "string") return reply;
  const content = reply?.content;
  if (Array.isArray(content)) return content.map((part) => part.text ?? "").join("");
  return String(content ?? "");
};

const fallback = (doc, issues, accepted) =>
  [
    `Акт розбіжностей до накладної ${doc?.docNumber ?? "без номера"} від ${doc?.docDate ?? "—"}.`,
    "",
    ...issueLines(doc, issues),
    "",
    accepted.length
      ? `Прийнято рядків: ${accepted.map((i) => i + 1).join(", ")}.`
      : "Приймання не відбулося.",
  ].join("\n");

/**
 * @param accepted індекси схвалених рядків (0-based)
 * @returns текст українською; ніколи не кидає
 */
export async function explainIssues({ model, doc, issues, accepted = [], supplierName }) {
  const table = issueLines(doc, issues).join("\n");
  const total = doc?.totalKop != null ? `Підсумок документа: ${formatUah(doc.totalKop)} грн.` : "";
  const prompt = `Напиши короткий лист постачальнику${supplierName ? ` (${supplierName})` : ""} про розбіжності
при прийманні накладної ${doc?.docNumber ?? ""} від ${doc?.docDate ?? ""}.

Розбіжності, які знайшла система (цифри вже перевірені, не перераховуй і не змінюй їх):
${table}

${accepted.length ? `Прийнято рядків: ${accepted.map((i) => i + 1).join(", ")}.` : "Приймання не відбулося."}
${total}

Вимоги: українською, ділово й без води, 4–8 рядків. Перелічи, що саме не зійшлося,
і попроси надіслати виправлений документ або погодити нову ціну протоколом.
Нічого не вигадуй поза списком вище.`;

  try {
    const message = textOf(await model.invoke(prompt)).trim();
    return message || fallback(doc, issues, accepted);
  } catch (e) {
    console.error(`[explain] модель недоступна (${e.message}), віддаю детермінований текст`);
    return fallback(doc, issues, accepted);
  }
}
