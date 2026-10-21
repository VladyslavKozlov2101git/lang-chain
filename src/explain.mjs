/**
 * Текст акта розбіжностей для постачальника.
 *
 * Тут LLM працює з найменшим ризиком: усі цифри вже порахував код, моделі лишається
 * скласти з них лист. Якщо модель недоступна — віддаємо детерміновану таблицю:
 * накладна на цей момент уже проведена, і втрачати її через збій генератора тексту
 * було б смішно.
 */
import { formatUah, replyText } from "./text.mjs";

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

/**
 * Суми завжди підписані, і їх дві.
 *
 * Голий «підсумок документа» — це той дефект, через який постачальник у листі про
 * часткове приймання читав суму, якої ніхто не приймав. Сума за документом ще й
 * буває з ПДВ, а прийнята завжди без, тому ставити їх поруч без підписів не можна.
 */
function sums(doc, acceptedTotalKop) {
  const out = [];
  if (doc?.totalKop != null) {
    const vat = doc.pricesIncludeVat ? "з ПДВ" : "без ПДВ";
    out.push(`Сума за документом постачальника: ${formatUah(doc.totalKop)} грн ${vat}.`);
  }
  if (acceptedTotalKop != null) {
    out.push(`Прийнято на суму: ${formatUah(acceptedTotalKop)} грн без ПДВ.`);
  }
  return out;
}

const fallback = (doc, issues, accepted, acceptedTotalKop) =>
  [
    `Акт розбіжностей до накладної ${doc?.docNumber ?? "без номера"} від ${doc?.docDate ?? "—"}.`,
    "",
    ...issueLines(doc, issues),
    "",
    accepted.length
      ? `Прийнято рядків: ${accepted.map((i) => i + 1).join(", ")}.`
      : "Приймання не відбулося.",
    ...sums(doc, acceptedTotalKop),
  ].join("\n");

/**
 * @param accepted          індекси схвалених рядків (0-based)
 * @param acceptedTotalKop  сума проведеної накладної без ПДВ, або null
 * @returns текст українською; ніколи не кидає
 */
export async function explainIssues({
  model,
  doc,
  issues,
  accepted = [],
  acceptedTotalKop = null,
  supplierName,
}) {
  const table = issueLines(doc, issues).join("\n");
  const prompt = `Напиши короткий лист постачальнику${supplierName ? ` (${supplierName})` : ""} про розбіжності
при прийманні накладної ${doc?.docNumber ?? ""} від ${doc?.docDate ?? ""}.

Розбіжності, які знайшла система (цифри вже перевірені, не перераховуй і не змінюй їх):
${table}

${accepted.length ? `Прийнято рядків: ${accepted.map((i) => i + 1).join(", ")}.` : "Приймання не відбулося."}
${sums(doc, acceptedTotalKop).join("\n")}

Вимоги: українською, ділово й без води, 4–8 рядків. Перелічи, що саме не зійшлося,
і попроси надіслати виправлений документ або погодити нову ціну протоколом.
Нічого не вигадуй поза списком вище. Якщо згадуєш суму — переписуй її разом із
підписом: сума за документом і прийнята сума це різні числа, і плутати їх не можна.`;

  try {
    const message = replyText(await model.invoke(prompt)).trim();
    return message || fallback(doc, issues, accepted, acceptedTotalKop);
  } catch (e) {
    console.error(`[explain] модель недоступна (${e.message}), віддаю детермінований текст`);
    return fallback(doc, issues, accepted, acceptedTotalKop);
  }
}
