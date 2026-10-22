/**
 * Фото й скан → текст через ту саму чат-модель, що робить витяг.
 *
 * Окремим кроком, а не картинкою прямо в `extract`, з трьох причин:
 *
 *  1. Далі все однакове. Після транскрипції документ — такий самий текст, як лист
 *     із пошти, тому схема, ретрай і eval `extract` працюють без жодної гілки.
 *  2. Людина бачить, що модель прочитала. Транскрипція лягає в `raw.text`, і її
 *     видно і в панелі листа, і в чекпойнті. Розбіжність «ціна 49,90» проти
 *     протоколу треба вміти звірити з оригіналом, а не з JSON.
 *  3. Ретрай `extract` не перечитує фото. Помилка схеми — це помилка структури,
 *     а не зору: повторювати розпізнавання на неї нема сенсу.
 *
 * Важкі залежності (`@napi-rs/canvas`, `unpdf`) вантажаться лише тут і лише коли
 * справді прийшла картинка: текстові листи не платять за них стартом.
 */
import { readFile } from "node:fs/promises";

import { HumanMessage } from "@langchain/core/messages";

import { replyText } from "./text.mjs";

/** Довша сторона після стиснення. Дрібний шрифт накладної ще читається, а
 *  фото з телефона на 12 Мп не їде шлюзом на кілька мегабайт. */
export const MAX_SIDE = 2000;

// ponytail: накладна рідко довша за 3 сторінки; довший скан обрізається з попередженням.
export const MAX_PAGES = 5;

export const OCR_PROMPT = `Це фото або скан документа постачальника: накладна, рахунок або лист.
Перепиши текст дослівно, зверху вниз, як він написаний.

- Кожна позиція таблиці — окремим рядком, колонки розділяй " | ".
- Числа, коди, дати, ЄДРПОУ, номери документів — символ у символ. Нічого не
  округлюй, не перераховуй і не виправляй, навіть якщо сума виглядає неправильною.
- Нерозбірливий фрагмент пиши як [?], а не вгадуй.
- Рукописні позначки на полях теж переписуй, з поміткою [від руки].
- Нічого не додавай від себе: ні пояснень, ні markdown, ні підсумків.

Якщо на зображенні немає документа, відповідай одним словом: НЕМАЄ`;

const canvas = () => import("@napi-rs/canvas");

/**
 * HEIC — формат камери айфона, і жодна модель шлюзу його не приймає, а Skia під
 * canvas не декодує. `heic-decode` — це libheif у WebAssembly: без нативних збірок,
 * поворот із контейнера застосовує сам.
 */
async function decodeHeic(bytes) {
  const [{ default: decode }, { createCanvas, ImageData }] = await Promise.all([import("heic-decode"), canvas()]);
  const { width, height, data } = await decode({ buffer: bytes });
  const image = createCanvas(width, height);
  image.getContext("2d").putImageData(new ImageData(new Uint8ClampedArray(data), width, height), 0, 0);
  return image;
}

/** Фото → JPEG не більше MAX_SIDE по довшій стороні, як data URL. */
async function photoPage(file) {
  const { createCanvas, loadImage } = await canvas();
  const bytes = await readFile(file);
  const image = /\.hei[cf]$/i.test(file) ? await decodeHeic(bytes) : await loadImage(bytes);
  const k = Math.min(1, MAX_SIDE / Math.max(image.width, image.height));
  const out = createCanvas(Math.round(image.width * k), Math.round(image.height * k));
  out.getContext("2d").drawImage(image, 0, 0, out.width, out.height);
  return `data:image/jpeg;base64,${(await out.encode("jpeg", 85)).toString("base64")}`;
}

/** Скан PDF → PNG на сторінку. Масштаб такий, щоб A4 вийшов ~MAX_SIDE заввишки. */
async function scanPages(file) {
  const { getDocumentProxy, renderPageAsImage } = await import("unpdf");
  const pdf = await getDocumentProxy(new Uint8Array(await readFile(file)));
  if (pdf.numPages > MAX_PAGES) {
    console.error(`[ocr] ${pdf.numPages} сторінок, читаю перші ${MAX_PAGES}`);
  }
  const pages = [];
  for (let n = 1; n <= Math.min(pdf.numPages, MAX_PAGES); n++) {
    const { height } = (await pdf.getPage(n)).getViewport({ scale: 1 });
    pages.push(
      await renderPageAsImage(pdf, n, { canvasImport: canvas, scale: MAX_SIDE / height, toDataURL: true }),
    );
  }
  return pages;
}

/** @param source { path, kind: "image" | "scan" } — як повертає intake */
export async function pagesOf(source) {
  if (source.kind === "image") return [await photoPage(source.path)];
  if (source.kind === "scan") return scanPages(source.path);
  throw new Error(`розпізнавати нема чого: ${source.kind}`);
}

/** Сторінки одним повідомленням: модель бачить документ цілком, а не шматками. */
export const ocrMessage = (pages) => [
  new HumanMessage({
    content: [
      { type: "text", text: OCR_PROMPT },
      ...pages.map((url) => ({ type: "image_url", image_url: { url } })),
    ],
  }),
];

/** @returns текст документа; порожній рядок, якщо документа на зображенні немає */
export async function transcribe({ model, source }) {
  const text = replyText(await model.invoke(ocrMessage(await pagesOf(source)))).trim();
  return text === "НЕМАЄ" ? "" : text;
}
