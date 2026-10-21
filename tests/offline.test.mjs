import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src");

describe("AC-30 — усе працює без мережі й без ключа", () => {
  test("кожен модуль завантажується з порожнім середовищем", async () => {
    const saved = {
      OPENCODE_API_KEY: process.env.OPENCODE_API_KEY,
      OPENCODE_PROVIDER: process.env.OPENCODE_PROVIDER,
      MODEL: process.env.MODEL,
    };
    delete process.env.OPENCODE_API_KEY;
    delete process.env.OPENCODE_PROVIDER;
    delete process.env.MODEL;

    try {
      const modules = readdirSync(SRC).filter((f) => f.endsWith(".mjs"));
      expect(modules.length).toBeGreaterThanOrEqual(9);
      for (const file of modules) {
        // Падіння тут означає, що хтось завів модель або ключ на рівні модуля —
        // саме те, через що тести почали б вимагати мережі.
        await expect(import(path.join(SRC, file))).resolves.toBeDefined();
      }
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  test("створення моделі — єдине місце, яке потребує ключа, і воно відкладене", async () => {
    const llm = await import("../src/llm.mjs");
    expect(typeof llm.createModel).toBe("function");
    // Фабрика асинхронна: ключ читається при виклику, не при імпорті.
    expect(llm.createModel.constructor.name).toBe("AsyncFunction");
  });

  test("граф збирається без моделі — залежності приходять аргументами", async () => {
    const { buildGraph } = await import("../src/graph.mjs");
    const { checkpointerFor, openDb } = await import("../src/db.mjs");
    const db = openDb(":memory:");
    const graph = buildGraph({ model: null, db, checkpointer: checkpointerFor(db) });
    expect(typeof graph.invoke).toBe("function");
  });
});
