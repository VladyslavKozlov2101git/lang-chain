"""Мінімальний RAG на LangChain 1.x.

Потік:  ./docs/*.md -> split -> embeddings -> vector store -> retriever -> prompt -> LLM

    .venv/Scripts/python rag.py "що таке retriever?"
    .venv/Scripts/python rag.py --self-check     # без мережі й без ключа
"""

import json
import os
import sys
import uuid
from pathlib import Path

from fastembed import TextEmbedding
from langchain_core.documents import Document
from langchain_core.embeddings import Embeddings
from langchain_core.output_parsers import StrOutputParser
from langchain_core.prompts import ChatPromptTemplate
from langchain_core.runnables import RunnablePassthrough
from langchain_core.vectorstores import InMemoryVectorStore
from langchain_openai import ChatOpenAI
from langchain_text_splitters import RecursiveCharacterTextSplitter

DOCS = Path(os.getenv("DOCS", Path(__file__).parent / "docs"))
# Обидва шлюзи opencode мають OpenAI-сумісний ендпоінт. "opencode" = Zen (pay-as-you-go),
# "opencode-go" = підписка Go, яка вимагає хедерів нижче й розрахована на coding-агентів.
PROVIDER = os.getenv("OPENCODE_PROVIDER", "opencode-go")
BASE_URL = f"https://opencode.ai/inference/{'go/' if PROVIDER == 'opencode-go' else ''}openai/v1"
# ponytail: не всі моделі Go говорять OpenAI-протоколом (Claude/Grok/GPT — ні, їм потрібен
# .../inference/go/anthropic/v1 і langchain-anthropic). qwen3.8-flash говорить і не "думає" вголос.
MODEL = os.getenv("MODEL", "qwen3.8-flash")
EMBED_MODEL = os.getenv("EMBED_MODEL", "minishlab/potion-multilingual-128M")
# ponytail: статичні embeddings (швидко, 512 токенів, 0.5 GB) замість трансформера. Якість пошуку
# стане вузьким місцем -> EMBED_MODEL=intfloat/multilingual-e5-large (2.2 GB) і префікси query:/passage:.
# Квантизована paraphrase-multilingual-MiniLM з fastembed на українському тексті помітно гірша.
CHUNK = 1000
TOP_K = 4


def api_key() -> str:
    """Ключ з OPENCODE_API_KEY, інакше — звідти, де його вже тримає opencode CLI."""
    if key := os.getenv("OPENCODE_API_KEY"):
        return key
    auth = Path.home() / ".local" / "share" / "opencode" / "auth.json"
    return json.loads(auth.read_text(encoding="utf-8"))[PROVIDER]["key"]


class LocalEmbeddings(Embeddings):
    """У opencode-go немає embedding-моделей, тож вектори рахуємо локально (ONNX, CPU).

    Два методи — це весь інтерфейс Embeddings у LangChain.
    """

    def __init__(self, model: str = EMBED_MODEL):
        self.model = TextEmbedding(model)  # перший запуск качає ~0.5 GB у кеш

    def embed_documents(self, texts: list[str]) -> list[list[float]]:
        return [v.tolist() for v in self.model.embed(texts)]

    def embed_query(self, text: str) -> list[float]:
        return self.embed_documents([text])[0]


def load_docs() -> list[Document]:
    # ponytail: тільки .md через pathlib. Для PDF/HTML -> pip install pypdf, PyPDFLoader.
    files = sorted(DOCS.rglob("*.md"))
    if not files:
        sys.exit(f"Немає .md файлів у {DOCS}")
    return [
        Document(
            page_content=f.read_text(encoding="utf-8"),
            # Шлях відносно DOCS, а не f.name: у вкладених теках імена повторюються.
            metadata={"source": f.relative_to(DOCS).as_posix()},
        )
        for f in files
    ]


def build_store(docs: list[Document]) -> InMemoryVectorStore:
    splitter = RecursiveCharacterTextSplitter(chunk_size=CHUNK, chunk_overlap=CHUNK // 5)
    # ponytail: InMemoryVectorStore переіндексовує все на кожному запуску (~1 с на сотні чанків).
    # Корпус виріс -> langchain-chroma і persist_directory.
    return InMemoryVectorStore.from_documents(splitter.split_documents(docs), LocalEmbeddings())


def format_docs(docs: list[Document]) -> str:
    return "\n\n---\n\n".join(f"[{d.metadata['source']}]\n{d.page_content}" for d in docs)


def build_chain(store: InMemoryVectorStore):
    prompt = ChatPromptTemplate.from_template(
        "Відповідай ЛИШЕ на основі контексту. Якщо відповіді в контексті немає — так і скажи.\n\n"
        "Контекст:\n{context}\n\nПитання: {question}"
    )
    llm = ChatOpenAI(
        model=MODEL,
        base_url=BASE_URL,
        api_key=api_key(),
        temperature=0,
        # Go вимагає стабільний id розмови та власний user-agent, інакше 400 MissingSessionID.
        default_headers={
            "x-opencode-session": str(uuid.uuid4()),
            "user-agent": "langchain-rag-pet/1.0",
        },
    )
    # MMR замість простої схожості: у волті лежать чернетки поруч з чистовими версіями,
    # і звичайний top-k забивався дублями того самого тексту.
    retriever = store.as_retriever(
        search_type="mmr", search_kwargs={"k": TOP_K, "fetch_k": TOP_K * 5}
    )
    # Ось і весь LCEL: dict підставляє змінні промпту, | з'єднує кроки.
    return (
        {"context": retriever | format_docs, "question": RunnablePassthrough()}
        | prompt
        | llm
        | StrOutputParser()
    )


def self_check() -> None:
    docs = [
        Document(page_content="Борщ варять з буряком, капустою та картоплею.", metadata={"source": "borsch.md"}),
        Document(page_content="Retriever дістає зі сховища найближчі до питання чанки.", metadata={"source": "rag.md"}),
        Document(page_content="Ключ opencode лежить в auth.json у домашній теці.", metadata={"source": "keys.md"}),
    ]
    store = build_store(docs)
    hits = store.as_retriever(search_kwargs={"k": 1}).invoke("Що кладуть у борщ?")
    assert hits[0].metadata["source"] == "borsch.md", hits
    assert format_docs(hits).startswith("[borsch.md]")
    hits = store.as_retriever(search_kwargs={"k": 1}).invoke("Хто дістає чанки зі сховища?")
    assert hits[0].metadata["source"] == "rag.md", hits
    print("self-check OK")


if __name__ == "__main__":
    question = " ".join(sys.argv[1:])
    if question == "--self-check":
        self_check()
    elif question:
        for token in build_chain(build_store(load_docs())).stream(question):
            print(token, end="", flush=True)
        print()
    else:
        sys.exit(__doc__)
