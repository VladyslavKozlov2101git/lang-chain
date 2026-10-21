/**
 * Обв'язка шлюзу opencode. Перенесена з гілки `node` разом із двома граблями,
 * на які там уже наступили:
 *
 *  1. Шлюз Go вимагає стабільний `x-opencode-session` і власний `user-agent`,
 *     інакше 400 MissingSessionID.
 *  2. Не всі моделі Go говорять OpenAI-протоколом. Claude, Grok і GPT — ні, їм
 *     потрібен .../inference/go/anthropic/v1 і @langchain/anthropic.
 *
 * Модель створюється тут, але нікуди не імпортується сама собою: граф отримує її
 * аргументом. Саме тому тести підставляють FakeListChatModel без мок-магії.
 */
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import { ChatOpenAI } from "@langchain/openai";

const PROVIDER = process.env.OPENCODE_PROVIDER ?? "opencode-go";
const BASE_URL = `https://opencode.ai/inference/${PROVIDER === "opencode-go" ? "go/" : ""}openai/v1`;
export const MODEL = process.env.MODEL ?? "qwen3.8-flash";
// Один id сесії на процес: шлюз хоче стабільний, а не новий на кожен виклик.
const SESSION = randomUUID();

async function apiKey() {
  if (process.env.OPENCODE_API_KEY) return process.env.OPENCODE_API_KEY;
  const auth = path.join(homedir(), ".local", "share", "opencode", "auth.json");
  const key = JSON.parse(await readFile(auth, "utf8"))[PROVIDER]?.key;
  if (!key) throw new Error(`немає ключа для ${PROVIDER}: ні в OPENCODE_API_KEY, ні в ${auth}`);
  return key;
}

/** temperature 0 — витяг накладної не місце для творчості. */
export async function createModel({ model = MODEL, temperature = 0 } = {}) {
  return new ChatOpenAI({
    model,
    temperature,
    apiKey: await apiKey(),
    configuration: {
      baseURL: BASE_URL,
      defaultHeaders: {
        "x-opencode-session": SESSION,
        "user-agent": "supply-flow/1.0",
      },
    },
  });
}
