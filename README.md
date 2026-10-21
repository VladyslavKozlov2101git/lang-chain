# RAG на LangChain.js за 180 рядків

Питай свої markdown-файли. LLM — через твій `opencode-go` (OpenAI-сумісний шлюз),
embeddings — локально на CPU, бо embedding-моделей той шлюз не віддає.

Це Node-порт гілки [`python`](../../tree/python). Логіка однакова, різниці — внизу.

## Запуск

```bash
npm install

node rag.mjs --self-check          # перевірка пошуку, без мережі
node rag.mjs "що таке retriever?"
```

Питати власний волт (PowerShell, один раз на сесію):

```powershell
$env:DOCS = "C:\Users\vladi\Desktop\disertation"
node rag.mjs "які методики оцінки шкоди від порушення земель я розглядаю?"
```

## Налаштування

Ключ береться з `OPENCODE_API_KEY`, інакше — з `~/.local/share/opencode/auth.json`, де його
вже тримає opencode CLI. Решта — через env:

| Змінна | Дефолт | Нащо |
|---|---|---|
| `DOCS` | `./docs` | тека з `.md`, шукає рекурсивно |
| `MODEL` | `qwen3.8-flash` | список: `opencode models \| grep opencode-go` |
| `OPENCODE_PROVIDER` | `opencode-go` | `opencode` — Zen, pay-as-you-go |
| `EMBED_MODEL` | `Xenova/multilingual-e5-small` | будь-яка transformers.js модель з `feature-extraction` |

Дві шпички шлюзу Go, на які я вже наступив:

- **Потрібен хедер `x-opencode-session`** (стабільний id розмови) і власний `user-agent`,
  інакше `400 MissingSessionID`. Обидва вже є в коді.
- **Не всі моделі говорять OpenAI-протоколом.** Claude, Grok, GPT Luna дають
  `ModelProtocolUnsupported` — їм потрібен ендпоінт `.../inference/go/anthropic/v1` і пакет
  `@langchain/anthropic`. GLM, Qwen, Kimi, MiniMax працюють як є.
- Go за їхньою докою розрахований на coding-агентів і трафік модерується. Для навчального
  пет-проекту це нормально, але якщо почнеш ганяти обсяги — переходь на `OPENCODE_PROVIDER=opencode`.

## Що де в коді

| Код у [rag.mjs](rag.mjs) | Концепт LangChain |
|---|---|
| `loadDocs` | `Document` — текст + metadata |
| `RecursiveCharacterTextSplitter` | розбиття на чанки з перекриттям |
| `LocalEmbeddings extends Embeddings` | інтерфейс `Embeddings` (два методи) |
| `MemoryVectorStore.fromDocuments` | vector store + індексація |
| `store.asRetriever({ searchType: "mmr" })` | retriever + MMR: `k` релевантних, але не дублів |
| `ChatPromptTemplate.fromTemplate` | шаблон промпту |
| `new ChatOpenAI({ configuration: { baseURL } })` | чат-модель через OpenAI-сумісний шлюз |
| `RunnableSequence.from([{...}, prompt, llm, parser])` | LCEL: паралельний об'єкт + конвеєр |
| `chain.stream(question)` | стрімінг, безкоштовно для всього ланцюжка |

Теорія до кожного пункту — у [docs/langchain-101.md](docs/langchain-101.md), і вона ж є корпусом
для пошуку: проект відповідає на питання про самого себе.

## Чим Node-версія відрізняється від Python

Три речі, які не видно з доків, поки не наступиш:

1. **`MemoryVectorStore` переїхав у `@langchain/classic`.** У JS v1 його немає ні в
   `@langchain/core`, ні в `langchain`, ні в `@langchain/community` — тільки там, разом з MMR.
2. **Немає швидкої мультимовної embedding-моделі.** JS-овий `fastembed` з мультимовних має лише
   `e5-large` (2.2 ГБ), тому тут `transformers.js` + `multilingual-e5-small`. Python тим часом
   бере `potion-multilingual-128M` — *статичну* модель (таблиця пошуку, без трансформера).
3. **Через це індексація повільніша в ~300 разів** — і це не про Node, а про вибір моделі:
   справжній 12-шаровий трансформер на CPU дає ~3 чанки/с.

| | Python | Node |
|---|---|---|
| залежності на диску | 254 МБ | 575 МБ |
| embedding-модель | `potion-multilingual-128M` (статична) | `multilingual-e5-small` (трансформер) |
| 2147 чанків волта | 2.3 с на кожен запуск | ~12 хв перший раз, далі з кешу |
| кеш векторів | не потрібен | `.cache/vectors-*.json` за хешем тексту |

Тому тут є те, чого немає на Python: **дисковий кеш embeddings**. Ключ — sha1 тексту чанка,
тож правка одного файлу волта переіндексовує тільки його чанки, а не весь корпус.

## Свідомо спрощено

- Вектори в пам'яті, на диску лише кеш → `@langchain/qdrant` або `chromadb`, коли треба справжній індекс.
- Тільки `.md` через `readdir` → `pdf-parse` + `PDFLoader`, коли знадобляться PDF.
- Без історії діалогу → LangGraph + checkpointer, коли треба чат, а не одне питання.
