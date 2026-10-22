import { foldId, formatUah, normalizeName, parseKop, tokens } from "../src/text.mjs";

describe("parseKop", () => {
  test("AC-4: три формати ціни дають однакові копійки", () => {
    expect(parseKop("45,80")).toBe(4580);
    expect(parseKop("45.80")).toBe(4580);
    expect(parseKop("45 грн 80 коп")).toBe(4580);
  });

  test("AC-4: без копійок, з розділювачем тисяч, з числа xlsx", () => {
    expect(parseKop("45")).toBe(4500);
    expect(parseKop("45,8")).toBe(4580);
    expect(parseKop("1 234,56")).toBe(123456);
    expect(parseKop("1 234,56")).toBe(123456);
    expect(parseKop("45 грн")).toBe(4500);
    expect(parseKop(45.8)).toBe(4580);
  });

  test("AC-4: не ціна → null, а не нуль", () => {
    for (const bad of ["", "   ", "за домовленістю", "45,805", "4,5,6", null, undefined, {}]) {
      expect(parseKop(bad)).toBeNull();
    }
  });

  test("гривні для людини: розділювач тисяч, завжди дві цифри копійок", () => {
    expect(formatUah(4990)).toBe("49,90");
    expect(formatUah(373840)).toBe("3 738,40");
    expect(formatUah(100000000)).toBe("1 000 000,00");
    expect(formatUah(5)).toBe("0,05");
    expect(formatUah(0)).toBe("0,00");
    expect(formatUah(-4990)).toBe("-49,90");
    // Розділювач ставиться лише між тисячами, а не після коми.
    expect(formatUah(999999)).toBe("9 999,99");
  });

  test("AC-4: копійки цілі, без артефактів плаваючої коми", () => {
    // 45.80 * 100 у float дає 4579.999999999999
    for (const grn of ["0,01", "0,10", "8,70", "19,99", "45,80", "99,99"]) {
      expect(Number.isInteger(parseKop(grn))).toBe(true);
    }
    expect(parseKop("8,70")).toBe(870);
    expect(formatUah(parseKop("8,70"))).toBe("8,70");
  });
});

describe("normalizeName", () => {
  test("розділяє число й одиницю, кому в числі робить точкою", () => {
    expect(normalizeName("Молоко Яготинське 2,6% 900г п/е")).toBe(
      "молоко яготинське 2.6% 900 г п е",
    );
    expect(normalizeName("Молоко Яготинське 2.6% 0,9л")).toBe("молоко яготинське 2.6% 0.9 л");
  });

  test("кг не плутається з г, мл з л", () => {
    expect(normalizeName("Борошно 5кг")).toBe("борошно 5 кг");
    expect(normalizeName("Сік 200мл")).toBe("сік 200 мл");
    // 'л' у середині слова не одиниця
    expect(normalizeName("Лавровий лист")).toBe("лавровий лист");
  });

  test("однаковий ключ для різних написань того самого — це й робить аляси надійними", () => {
    const a = normalizeName('Сметана "Молочний Дім" 20%, 350 г');
    const b = normalizeName("СМЕТАНА  Молочний Дім  20% 350г");
    expect(a).toBe(b);
  });

  test("спільні токени видно навіть коли фасування записане інакше", () => {
    const doc = tokens("Молоко Яготинське 2,6% 900г п/е");
    const sku = tokens("Молоко Яготинське 2.6% 0,9л");
    expect(doc.filter((t) => sku.includes(t))).toEqual(["молоко", "яготинське", "2.6%"]);
  });
});

describe("foldId — кирилиця й латиниця, що виглядають однаково", () => {
  test("обидва прочитання з фото дають один ідентифікатор", () => {
    // Заміряно на шлюзі: qwen прочитав «РН» латиницею, deepseek — «PO» кирилицею.
    expect(foldId("РН-5540")).toBe(foldId("PH-5540"));
    expect(foldId("РО-2026-1041")).toBe("PO-2026-1041");
  });

  test("латиниця й цифри лишаються як є, null теж", () => {
    expect(foldId("KV-LUK")).toBe("KV-LUK");
    expect(foldId("4471")).toBe("4471");
    expect(foldId(null)).toBeNull();
  });

  test("кирилиця без латинського двійника не чіпається", () => {
    expect(foldId("ВН-Ж17")).toBe("BH-Ж17");
  });
});
