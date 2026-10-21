/**
 * Мінімальний RAG на LangChain.js
 *
 * Потік:  ./docs/*.md -> split -> embeddings -> vector store -> retriever -> prompt -> LLM
 *
 *     node rag.mjs "що таке retriever?"
 *     node rag.mjs --self-check     # без мережі й без ключа
 */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { pipeline } from "@huggingface/transformers";
// У LangChain.js v1 in-memory сховище живе тут, а не в @langchain/core чи langchain.
import { MemoryVectorStore } from "@langchain/classic/vectorstores/memory";
import { Document } from "@langchain/core/documents";
import { Embeddings } from "@langchain/core/embeddings";
import { StringOutputParser } from "@langchain/core/output_parsers";
import { ChatPromptTemplate } from "@langchain/core/prompts";
import { RunnableLambda, RunnablePassthrough, RunnableSequence } from "@langchain/core/runnables";
import { ChatOpenAI } from "@langchain/openai";
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DOCS = process.env.DOCS ?? path.join(HERE, "docs");
// Обидва шлюзи opencode мають OpenAI-сумісний ендпоінт. "opencode" = Zen (pay-as-you-go),
// "opencode-go" = підписка Go, яка вимагає хедерів нижче й розрахована на coding-агентів.
const PROVIDER = process.env.OPENCODE_PROVIDER ?? "opencode-go";
const BASE_URL = `https://opencode.ai/inference/${PROVIDER === "opencode-go" ? "go/" : ""}openai/v1`;
// ponytail: не всі моделі Go говорять OpenAI-протоколом (Claude/Grok/GPT — ні, їм потрібен
// .../inference/go/anthropic/v1 і @langchain/anthropic). qwen3.8-flash говорить і не "думає" вголос.
const MODEL = process.env.MODEL ?? "qwen3.8-flash";
// ponytail: JS-овий fastembed з мультимовних має лише e5-large (2.2 GB), тому transformers.js.
// paraphrase-multilingual-MiniLM провалює українські запити і в fp32, і в q8 — справа не в квантизації.
const EMBED_MODEL = process.env.EMBED_MODEL ?? "Xenova/multilingual-e5-small";
const CHUNK = 1000;
const TOP_K = 4;
const BATCH = 32;
// Справжній трансформер на CPU дає ~3 чанки/с: 2147 чанків волта = 12 хвилин. На Python
// там статична модель (potion, таблиця пошуку) і ті самі чанки займають 2 секунди, тому
// кеш потрібен саме тут. Ключ — хеш тексту, тож правка одного файлу не переіндексовує волт.
const CACHE = path.join(HERE, ".cache", `vectors-${EMBED_MODEL.replace(/\//g, "_")}.json`);

const hash = (text) => createHash("sha1").update(text).digest("hex").slice(0, 16);

async function apiKey() {
  if (process.env.OPENCODE_API_KEY) return process.env.OPENCODE_API_KEY;
  const auth = path.join(homedir(), ".local", "share", "opencode", "auth.json");
  return JSON.parse(await readFile(auth, "utf8"))[PROVIDER].key;
}

/** У opencode немає embedding-моделей, тож вектори рахуємо локально (ONNX, CPU).
 *  Два методи — це весь інтерфейс Embeddings у LangChain. */
class LocalEmbeddings extends Embeddings {
  constructor(model = EMBED_MODEL) {
    super({});
    // e5 розрізняє роль тексту: питання йде з "query: ", документ — з "passage: ".
    this.e5 = model.includes("e5");
    this.ready = pipeline("feature-extraction", model, { dtype: "fp32" });
  }

  async #embed(texts, kind) {
    const extract = await this.ready;
    const prefix = this.e5 ? `${kind}: ` : "";
    const loud = texts.length > BATCH;
    const out = [];
    // Батчами: MemoryVectorStore віддає всі чанки одним викликом, а тензор на 2000 текстів
    // з padding до найдовшого з'їдає пам'ять.
    for (let i = 0; i < texts.length; i += BATCH) {
      const batch = texts.slice(i, i + BATCH).map((t) => prefix + t);
      out.push(...(await extract(batch, { pooling: "mean", normalize: true })).tolist());
      if (loud) process.stderr.write(`\r  embeddings ${Math.min(i + BATCH, texts.length)}/${texts.length}`);
    }
    if (loud) process.stderr.write("\n");
    return out;
  }

  /** Кешуємо лише документи: запити щоразу нові й приходять по одному. */
  async embedDocuments(texts) {
    const cache = JSON.parse(await readFile(CACHE, "utf8").catch(() => "{}"));
    const keys = texts.map(hash);
    const missing = texts.filter((_, i) => !cache[keys[i]]);
    if (missing.length > 0) {
      const fresh = await this.#embed(missing, "passage");
      missing.forEach((t, i) => (cache[hash(t)] = fresh[i]));
      await mkdir(path.dirname(CACHE), { recursive: true });
      await writeFile(CACHE, JSON.stringify(cache));
    }
    return keys.map((k) => cache[k]);
  }

  async embedQuery(text) {
    return (await this.#embed([text], "query"))[0];
  }
}

async function loadDocs() {
  // ponytail: тільки .md через readdir. Для PDF/HTML -> npm i pdf-parse, PDFLoader.
  const names = (await readdir(DOCS, { recursive: true })).filter((f) => f.endsWith(".md")).sort();
  if (names.length === 0) {
    console.error(`Немає .md файлів у ${DOCS}`);
    process.exit(1);
  }
  return Promise.all(
    names.map(
      async (rel) =>
        new Document({
          pageContent: await readFile(path.join(DOCS, rel), "utf8"),
          // Шлях відносно DOCS, а не basename: у вкладених теках імена повторюються.
          metadata: { source: rel.split(path.sep).join("/") },
        }),
    ),
  );
}

async function buildStore(docs) {
  const splitter = new RecursiveCharacterTextSplitter({ chunkSize: CHUNK, chunkOverlap: CHUNK / 5 });
  // ponytail: MemoryVectorStore тримає вектори в пам'яті, на диску лежить тільки кеш.
  // Корпус виріс -> @langchain/qdrant або chromadb з власним індексом.
  return MemoryVectorStore.fromDocuments(await splitter.splitDocuments(docs), new LocalEmbeddings());
}

const formatDocs = (docs) =>
  docs.map((d) => `[${d.metadata.source}]\n${d.pageContent}`).join("\n\n---\n\n");

async function buildChain(store) {
  const prompt = ChatPromptTemplate.fromTemplate(
    "Відповідай ЛИШЕ на основі контексту. Якщо відповіді в контексті немає — так і скажи.\n\n" +
      "Контекст:\n{context}\n\nПитання: {question}",
  );
  const llm = new ChatOpenAI({
    model: MODEL,
    apiKey: await apiKey(),
    temperature: 0,
    configuration: {
      baseURL: BASE_URL,
      // Go вимагає стабільний id розмови та власний user-agent, інакше 400 MissingSessionID.
      defaultHeaders: {
        "x-opencode-session": randomUUID(),
        "user-agent": "langchain-rag-pet/1.0",
      },
    },
  });
  // MMR замість простої схожості: у волті чернетки лежать поруч з чистовими версіями,
  // і звичайний top-k забивався дублями того самого тексту.
  const retriever = store.asRetriever({
    k: TOP_K,
    searchType: "mmr",
    searchKwargs: { fetchK: TOP_K * 5 },
  });
  // Ось і весь LCEL: об'єкт підставляє змінні промпту, RunnableSequence з'єднує кроки.
  return RunnableSequence.from([
    { context: retriever.pipe(RunnableLambda.from(formatDocs)), question: new RunnablePassthrough() },
    prompt,
    llm,
    new StringOutputParser(),
  ]);
}

async function selfCheck() {
  const docs = [
    new Document({ pageContent: "Борщ варять з буряком, капустою та картоплею.", metadata: { source: "borsch.md" } }),
    new Document({ pageContent: "Retriever дістає зі сховища найближчі до питання чанки.", metadata: { source: "rag.md" } }),
    new Document({ pageContent: "Ключ opencode лежить в auth.json у домашній теці.", metadata: { source: "keys.md" } }),
  ];
  const store = await buildStore(docs);
  let hits = await store.asRetriever({ k: 1 }).invoke("Що кладуть у борщ?");
  assert.equal(hits[0].metadata.source, "borsch.md");
  assert.ok(formatDocs(hits).startsWith("[borsch.md]"));
  hits = await store.asRetriever({ k: 1 }).invoke("Хто дістає чанки зі сховища?");
  assert.equal(hits[0].metadata.source, "rag.md");
  console.log("self-check OK");
}

const question = process.argv.slice(2).join(" ");
if (question === "--self-check") {
  await selfCheck();
} else if (question) {
  const chain = await buildChain(await buildStore(await loadDocs()));
  for await (const token of await chain.stream(question)) process.stdout.write(token);
  process.stdout.write("\n");
} else {
  console.error('node rag.mjs "питання"  |  node rag.mjs --self-check');
  process.exit(1);
}
