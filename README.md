# RAG на LangChain за 100 рядків

Питай свої markdown-файли. LLM — через твій `opencode-go` (OpenAI-сумісний шлюз),
embeddings — локально на CPU, бо embedding-моделей той шлюз не віддає.

## Запуск

```bash
python -m venv .venv
.venv/Scripts/python -m pip install -r requirements.txt

.venv/Scripts/python rag.py --self-check          # перевірка пошуку, без мережі
.venv/Scripts/python rag.py "що таке retriever?"
```

Питати власний волт (PowerShell, один раз на сесію):

```powershell
$env:DOCS = "C:\Users\vladi\Desktop\disertation"
.venv\Scripts\python rag.py "які методики оцінки шкоди від порушення земель я розглядаю?"
```

116 файлів дисертації (2.4 МБ) → 2200 чанків, індексація 2.3 с на запуск.

## Налаштування

Ключ береться з `OPENCODE_API_KEY`, інакше — з `~/.local/share/opencode/auth.json`, де його
вже тримає opencode CLI. Решта — через env:

| Змінна | Дефолт | Нащо |
|---|---|---|
| `DOCS` | `./docs` | тека з `.md`, шукає рекурсивно |
| `MODEL` | `qwen3.8-flash` | список: `opencode models \| grep opencode-go` |
| `OPENCODE_PROVIDER` | `opencode-go` | `opencode` — Zen, pay-as-you-go |
| `EMBED_MODEL` | `minishlab/potion-multilingual-128M` | `intfloat/multilingual-e5-large` для якості (2.2 GB) |

Дві шпички шлюзу Go, на які я вже наступив:

- **Потрібен хедер `x-opencode-session`** (стабільний id розмови) і власний `user-agent`,
  інакше `400 MissingSessionID`. Обидва вже є в коді.
- **Не всі моделі говорять OpenAI-протоколом.** Claude, Grok, GPT Luna дають
  `ModelProtocolUnsupported` — їм потрібен ендпоінт `.../inference/go/anthropic/v1` і пакет
  `langchain-anthropic` замість `langchain-openai`. GLM, Qwen, Kimi, MiniMax працюють як є.
- Go за їхньою докою розрахований на coding-агентів і трафік модерується. Для навчального
  пет-проекту це нормально, але якщо почнеш ганяти обсяги — переходь на `OPENCODE_PROVIDER=opencode`.

## Що де в коді

| Код у [rag.py](rag.py) | Концепт LangChain |
|---|---|
| `load_docs` | `Document` — текст + metadata |
| `RecursiveCharacterTextSplitter` | розбиття на чанки з перекриттям |
| `LocalEmbeddings` | інтерфейс `Embeddings` (два методи) |
| `InMemoryVectorStore.from_documents` | vector store + індексація |
| `store.as_retriever(search_type="mmr")` | retriever + MMR: `k` релевантних, але не дублів |
| `ChatPromptTemplate.from_template` | шаблон промпту |
| `ChatOpenAI(base_url=...)` | чат-модель через OpenAI-сумісний шлюз |
| `{...} \| prompt \| llm \| StrOutputParser()` | LCEL: паралельний словник + конвеєр |
| `.stream(question)` | стрімінг, безкоштовно для всього ланцюжка |

Теорія до кожного пункту — у [docs/langchain-101.md](docs/langchain-101.md), і вона ж є корпусом
для пошуку: проект відповідає на питання про самого себе.

## Свідомо спрощено

- Сховище в пам'яті, переіндексація на кожному запуску (2.3 с на 2200 чанків) → Chroma + `persist_directory`, коли секунди почнуть дратувати.
- Тільки `.md` через `pathlib` → `pypdf` + `PyPDFLoader`, коли знадобляться PDF.
- Без історії діалогу → LangGraph + checkpointer, коли треба чат, а не одне питання.
