import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadImage } from "@napi-rs/canvas";

import { MAX_SIDE, OCR_PROMPT, ocrMessage, pagesOf, transcribe } from "../src/ocr.mjs";
import { promptText } from "../src/trace.mjs";

const INBOX = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "inbox");
const fixture = (name) => path.join(INBOX, name);

const sizeOf = async (dataUrl) => {
  const image = await loadImage(Buffer.from(dataUrl.split(",")[1], "base64"));
  return { width: image.width, height: image.height };
};

describe("сторінки для моделі", () => {
  test("фото стискається до MAX_SIDE по довшій стороні й їде JPEG", async () => {
    const [page] = await pagesOf({ kind: "image", path: fixture("r01-cina-vyshche-foto.jpg") });
    expect(page.startsWith("data:image/jpeg;base64,")).toBe(true);
    const { width, height } = await sizeOf(page);
    expect(Math.max(width, height)).toBe(MAX_SIDE);
  });

  test("HEIC декодується локально й їде моделі як JPEG — HEIC шлюз не приймає", async () => {
    const [page] = await pagesOf({ kind: "image", path: fixture("r01-cina-vyshche-foto.heic") });
    expect(page.startsWith("data:image/jpeg;base64,")).toBe(true);
    const { width, height } = await sizeOf(page);
    expect([width, height]).toEqual([1600, 2000]);
  });

  test("скан PDF рендериться сторінкою в PNG приблизно MAX_SIDE заввишки", async () => {
    const pages = await pagesOf({ kind: "scan", path: fixture("clean-02-hlib-skan.pdf") });
    expect(pages).toHaveLength(1);
    expect(pages[0].startsWith("data:image/png;base64,")).toBe(true);
    const { height } = await sizeOf(pages[0]);
    expect(Math.abs(height - MAX_SIDE)).toBeLessThanOrEqual(2);
  });
});

describe("transcribe", () => {
  const recorder = (reply) => ({
    calls: [],
    async invoke(messages) {
      this.calls.push(messages);
      return { content: reply };
    },
  });

  test("усі сторінки й інструкція їдуть одним повідомленням", async () => {
    const model = recorder("Накладна № РН-5540");
    const text = await transcribe({ model, source: { kind: "image", path: fixture("r01-cina-vyshche-foto.jpg") } });
    expect(text).toBe("Накладна № РН-5540");
    expect(model.calls).toHaveLength(1);
    const [message] = model.calls[0];
    expect(message.content[0]).toEqual({ type: "text", text: OCR_PROMPT });
    expect(message.content.filter((p) => p.type === "image_url")).toHaveLength(1);
  });

  test("«НЕМАЄ» — порожній текст, а не документ зі словом НЕМАЄ", async () => {
    const text = await transcribe({
      model: recorder("НЕМАЄ"),
      source: { kind: "image", path: fixture("r01-cina-vyshche-foto.jpg") },
    });
    expect(text).toBe("");
  });

  test("у трасі замість base64 — підпис із розміром", () => {
    const shown = promptText(ocrMessage(["data:image/png;base64," + "A".repeat(4096)]));
    expect(shown).toContain("Перепиши текст дослівно");
    expect(shown).toMatch(/\[зображення, 3 КБ\]/);
    expect(shown).not.toContain("AAAA");
  });
});
