/**
 * Правила приймання R1–R10. Чиста функція: ні БД, ні LLM, ні дати «зараз».
 *
 * Це місце, де рахуються гроші, тому LLM тут не буває за визначенням: розбіжність
 * у ціні мусить бути відтворюваною й перевірною без мережі.
 */

/** Нижче цього рівня впевненості матчингу рядок іде до людини (R8). */
export const CONFIDENCE_MIN = 0.8;

const DAY = 86_400_000;

/** Протокольна ціна без ПДВ → ціна з ПДВ. */
export const grossOf = (netKop, vatRate) => Math.round((netKop * (100 + vatRate)) / 100);

const daysBetween = (from, to) => (Date.parse(to) - Date.parse(from)) / DAY;

// Кратність для вагових товарів не має сенсу, тому pack_size=1 означає «не перевіряти».
const isMultiple = (qty, pack) => Math.abs(qty / pack - Math.round(qty / pack)) < 1e-9;

/**
 * @param doc     { storeCode, docNumber, docDate, pricesIncludeVat, totalKop, lines }
 *                lines: [{ rawName, qty, unit, priceKop, expiresOn }]
 * @param matched [{ lineIdx, skuId, confidence, via }]
 * @param ctx     { store, supplier, po, skuById, protocolFor, today }
 *                protocolFor: (skuId) => копійки без ПДВ на дату документа, або null
 * @returns [{ lineIdx, code, detail, blocking }] — lineIdx=null для рівня документа
 */
export function validate({ doc, matched = [], ctx }) {
  const issues = [];
  const add = (lineIdx, code, detail, blocking = true) =>
    issues.push({ lineIdx, code, detail, blocking });

  // AC-2: без магазину-отримувача приймати нікуди.
  if (!ctx.store) {
    add(null, "unknown_store", `магазин-отримувач не визначений: ${doc.storeCode ?? "не вказано"}`);
  }

  // R9 рівня документа: заявки немає взагалі, тобто непрошене все.
  if (!ctx.po) {
    add(null, "not_in_po", "заявки на цього постачальника й магазин немає");
  }

  const byLine = new Map(matched.map((m) => [m.lineIdx, m]));
  const ordered = new Map((ctx.po?.lines ?? []).map((l) => [l.skuId, l.qty]));
  // Постачальник може розбити одну позицію заявки на кілька рядків документа, тому
  // кількість проти заявки звіряється сумою по SKU, а не рядок у рядок.
  const delivered = new Map();

  doc.lines.forEach((line, idx) => {
    const match = byLine.get(idx);

    // R8: без надійного SKU решту правил перевіряти нема на чому.
    if (!match?.skuId || match.confidence < CONFIDENCE_MIN) {
      const why =
        match?.skuId === undefined
          ? "збігу в номенклатурі не знайдено"
          : `впевненість ${match.confidence} нижча за ${CONFIDENCE_MIN}`;
      add(idx, "no_sku_match", `«${line.rawName}»: ${why}`);
      return;
    }

    const sku = ctx.skuById.get(match.skuId);
    if (!sku) {
      add(idx, "no_sku_match", `«${line.rawName}»: SKU #${match.skuId} немає в номенклатурі`);
      return;
    }

    if (!delivered.has(match.skuId)) delivered.set(match.skuId, { qty: 0, lineIdx: idx });
    delivered.get(match.skuId).qty += line.qty;

    // R4: кратність пакування.
    if (sku.packSize > 1 && !isMultiple(line.qty, sku.packSize)) {
      add(idx, "pack_multiple", `${line.qty} ${sku.unit} не кратно пакуванню ${sku.packSize}`);
    }

    // R1/R2/R3: ціна проти протоколу.
    const protocolNet = ctx.protocolFor(match.skuId);
    if (protocolNet === null) {
      add(idx, "no_price_protocol", `${sku.code}: чинного протоколу на ${doc.docDate} немає`);
    } else {
      // Порівнюємо в тому ж просторі, в якому подав документ: протокол переводимо
      // в ціну з ПДВ, а не ціну документа в чисту. Інакше зворотне ділення дає
      // копійку похибки, і при нульовому допуску R1 спрацьовує на рівній ціні.
      const limit = doc.pricesIncludeVat ? grossOf(protocolNet, sku.vatRate) : protocolNet;
      const vat = doc.pricesIncludeVat ? ` (з ПДВ ${sku.vatRate}%)` : "";
      if (line.priceKop > limit) {
        add(
          idx,
          "price_above_protocol",
          `${sku.code}: ${line.priceKop} коп проти протокольних ${limit} коп${vat}`,
        );
      } else if (line.priceKop < limit) {
        add(
          idx,
          "price_below_protocol",
          `${sku.code}: ${line.priceKop} коп нижче протокольних ${limit} коп${vat}`,
          false,
        );
      }
    }

    // R7: залишковий термін придатності.
    if (line.expiresOn && sku.shelfLifeDays && sku.minShelfPct != null) {
      const left = daysBetween(ctx.today, line.expiresOn);
      const pct = (left / sku.shelfLifeDays) * 100;
      if (pct < sku.minShelfPct) {
        add(
          idx,
          "shelf_life",
          `${sku.code}: лишилось ${Math.round(pct)}% терміну, мінімум ${sku.minShelfPct}%`,
        );
      }
    }
  });

  // R5/R6/R9: кількість проти заявки, сумою по SKU.
  if (ctx.po) {
    for (const [skuId, { qty, lineIdx }] of delivered) {
      const code = ctx.skuById.get(skuId)?.code ?? `#${skuId}`;
      const want = ordered.get(skuId);
      if (want === undefined) {
        add(lineIdx, "not_in_po", `${code}: позиції немає в заявці ${ctx.po.number}`);
      } else if (qty > want) {
        add(lineIdx, "over_po", `${code}: привезли ${qty}, заявлено ${want}`);
      } else if (qty < want) {
        add(lineIdx, "under_delivery", `${code}: привезли ${qty}, заявлено ${want}`, false);
      }
    }
  }

  // R10: сума документа проти суми рядків. Кожен рядок округлюється окремо —
  // так само, як це робить сам документ.
  if (doc.totalKop != null) {
    const sum = doc.lines.reduce((acc, l) => acc + Math.round(l.priceKop * l.qty), 0);
    if (sum !== doc.totalKop) {
      add(null, "total_mismatch", `сума рядків ${sum} коп, у документі ${doc.totalKop} коп`);
    }
  }

  return issues;
}

export const blocking = (issues) => issues.filter((i) => i.blocking);
