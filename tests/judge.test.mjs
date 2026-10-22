import { allSkus, openDb, seedDb } from "../src/db.mjs";
import { normalizeName } from "../src/text.mjs";
import { judgeLines, MAX_OPTIONS } from "../src/judge.mjs";
import { validate, CONFIDENCE_MIN } from "../src/validate.mjs";

const seeded = () => {
  const db = openDb(":memory:");
  seedDb(db);
  return db;
};

/**
 * Заглушка, яка лічить запити й зберігає їх. Лічильник тут не косметика: уся
 * цінність форми запиту в тому, що рядків багато, а запит один.
 */
class Counting {
  constructor(answerFor) {
    this.answerFor = answerFor;
    this.requests = [];
  }

  async judge(request) {
    this.requests.push(request);
    const answers = {};
    request.state.lines.forEach((line, i) => {
      const { code, exists, confidence = 1 } = this.answerFor(line.rawName, i);
      answers[`exists_${i}`] = { type: "noul", noul: exists };
      answers[`sku_${i}`] = { type: "choice", choice: code, confidence, probabilities: { [code]: confidence } };
    });
    return { answers, usage: { input_tokens: 0 } };
  }
}

const lines = (...names) => names.map((rawName) => ({ rawName }));

describe("judgeLines — форма запиту", () => {
  test("усі рядки їдуть одним запитом, а не запитом на рядок", async () => {
    const skus = allSkus(seeded());
    const stub = new Counting(() => ({ code: "MLK-001", exists: 0.97 }));

    await judgeLines({
      judge: (r) => stub.judge(r),
      lines: lines("Молоко 2,6% 900", "Кефір 450", "Сметана 20% 350", "Сир 9% 350"),
      skus,
    });

    expect(stub.requests).toHaveLength(1);
    expect(stub.requests[0].state.lines).toHaveLength(4);
    expect(Object.keys(stub.requests[0].questions)).toHaveLength(8); // exists + sku на рядок
  });

  test("каталог лежить і в state, і в criteria", async () => {
    const skus = allSkus(seeded());
    const stub = new Counting(() => ({ code: "MLK-006", exists: 0.98 }));

    await judgeLines({ judge: (r) => stub.judge(r), lines: lines("Сметана 20% 350 г"), skus });

    const [req] = stub.requests;
    // Без каталогу в state Noul відповідає монеткою — заміряно, 0.46–0.60 там,
    // де відповідь очевидна.
    expect(req.state.catalog).toHaveLength(skus.length);
    // Без описів у criteria розрив між «приймати» і «до людини» падає з 64 пунктів до 8.
    expect(Object.keys(req.questions.sku_0.criteria)).toHaveLength(skus.length);
    expect(req.questions.sku_0.criteria["MLK-006"]).toMatch(/Сметана/);
  });

  test("каталог більший за межу Choice — помилка, а не тихий шортліст", async () => {
    const skus = Array.from({ length: MAX_OPTIONS + 1 }, (_, i) => ({
      id: i, code: `X-${i}`, name: `Товар ${i}`, unit: "шт",
    }));
    await expect(
      judgeLines({ judge: async () => ({ answers: {} }), lines: lines("Товар 1"), skus }),
    ).rejects.toThrow(/більше за межу Choice/);
  });
});

describe("judgeLines — аляси", () => {
  test("рядок з алясом не потрапляє в запит узагалі", async () => {
    const skus = allSkus(seeded());
    const mlk006 = skus.find((s) => s.code === "MLK-006");
    const stub = new Counting(() => ({ code: "MLK-001", exists: 0.95 }));

    const matched = await judgeLines({
      judge: (r) => stub.judge(r),
      lines: lines("Сметана 20% 350 г", "Молоко 2,6% 900"),
      skus,
      // Ключ нормалізований — той самий контракт, що й у matchLines.
      aliasFor: (key) => (key === normalizeName("Сметана 20% 350 г") ? mlk006.id : null),
    });

    expect(stub.requests[0].state.lines).toEqual([{ rawName: "Молоко 2,6% 900" }]);
    expect(matched[0]).toEqual({ lineIdx: 0, skuId: mlk006.id, confidence: 1, via: "alias" });
    expect(matched[1].via).toBe("jev");
  });

  test("усі рядки з алясами — модель не кликана жодного разу", async () => {
    const skus = allSkus(seeded());
    const mlk006 = skus.find((s) => s.code === "MLK-006");
    const stub = new Counting(() => { throw new Error("не мало статись"); });

    const matched = await judgeLines({
      judge: (r) => stub.judge(r),
      lines: lines("Сметана 20% 350 г"),
      skus,
      aliasFor: () => mlk006.id,
    });

    expect(stub.requests).toHaveLength(0);
    expect(matched[0].via).toBe("alias");
  });
});

describe("judgeLines — впевненість це exists, а не впевненість вибору", () => {
  test("впевнений вибір при низькому exists блокує рядок (Чеддер → Гауда)", async () => {
    const db = seeded();
    const skus = allSkus(db);
    // Заміряно на живому Jev: Choice віддає Гауду з 84–100%, exists — 8–13%.
    const stub = new Counting(() => ({ code: "MLK-016", exists: 0.11, confidence: 1 }));

    const [match] = await judgeLines({
      judge: (r) => stub.judge(r),
      lines: lines("Сир твердий Чеддер 50%"),
      skus,
    });

    expect(match.confidence).toBeLessThan(CONFIDENCE_MIN);

    // І це саме те, що R8 мусить упіймати — перевіряємо через самі правила.
    const issues = validate({
      doc: { docDate: "2026-10-21", pricesIncludeVat: false, totalKop: null,
             lines: [{ rawName: "Сир твердий Чеддер 50%", qty: 1, priceKop: 10000, expiresOn: null }] },
      matched: [match],
      ctx: { store: null, supplier: null, po: null, skuById: new Map(), protocolFor: () => null, today: "2026-10-21" },
    });
    expect(issues.some((i) => i.code === "no_sku_match" && i.blocking)).toBe(true);
  });

  test("високий exists пропускає рядок далі", async () => {
    const skus = allSkus(seeded());
    const stub = new Counting(() => ({ code: "MLK-006", exists: 0.98 }));

    const [match] = await judgeLines({
      judge: (r) => stub.judge(r),
      lines: lines("смет.20 350"),
      skus,
    });

    expect(match.confidence).toBeGreaterThanOrEqual(CONFIDENCE_MIN);
    expect(match.via).toBe("jev");
    expect(skus.find((s) => s.id === match.skuId).code).toBe("MLK-006");
  });
});
