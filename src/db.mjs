/**
 * Один файл БД і один драйвер — вбудований `node:sqlite`.
 *
 * Планували `better-sqlite3`, бо офіційний чекпойнтер LangGraph залежить від нього.
 * Виявилось, що тут не збирається нативний модуль (немає тулчейна, install-скрипти
 * заблоковані), зате сам `SqliteSaver` приймає готовий db у конструктор і чіпає лише
 * чотири методи. Тому: драйвер — стдлібний, чекпойнтер — офіційний, між ними шим на
 * двадцять рядків. `SqliteSaver.fromConnString` викликати не можна — саме він і лізе
 * в нативний конструктор.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";

import { parseKop } from "./text.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DB_PATH = process.env.SUPPLY_DB ?? path.join(HERE, "..", "supply.db");
const SEED_PATH = path.join(HERE, "..", "seed", "data.json");

const SCHEMA = `
CREATE TABLE IF NOT EXISTS store (
  id    INTEGER PRIMARY KEY,
  code  TEXT NOT NULL UNIQUE,
  name  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS supplier (
  id      INTEGER PRIMARY KEY,
  edrpou  TEXT NOT NULL UNIQUE,
  name    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sku (
  id               INTEGER PRIMARY KEY,
  code             TEXT NOT NULL UNIQUE,
  name             TEXT NOT NULL,
  unit             TEXT NOT NULL,              -- шт | кг | л
  pack_size        REAL NOT NULL DEFAULT 1,    -- 1 = кратність не застосовується (вагові)
  vat_rate         INTEGER NOT NULL,           -- 20 | 14 | 7 | 0
  shelf_life_days  INTEGER,                    -- NULL = не псується
  min_shelf_pct    INTEGER                     -- мінімальний залишковий термін, %
);

CREATE TABLE IF NOT EXISTS price_protocol (
  id             INTEGER PRIMARY KEY,
  supplier_id    INTEGER NOT NULL REFERENCES supplier(id),
  sku_id         INTEGER NOT NULL REFERENCES sku(id),
  price_net_kop  INTEGER NOT NULL,
  valid_from     TEXT NOT NULL,                -- ISO, включно
  valid_to       TEXT,                          -- ISO, включно; NULL = без обмеження
  UNIQUE(supplier_id, sku_id, valid_from)
);

CREATE TABLE IF NOT EXISTS po (
  id           INTEGER PRIMARY KEY,
  number       TEXT NOT NULL UNIQUE,
  store_id     INTEGER NOT NULL REFERENCES store(id),
  supplier_id  INTEGER NOT NULL REFERENCES supplier(id),
  created_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS po_line (
  id      INTEGER PRIMARY KEY,
  po_id   INTEGER NOT NULL REFERENCES po(id),
  sku_id  INTEGER NOT NULL REFERENCES sku(id),
  qty     REAL NOT NULL,
  UNIQUE(po_id, sku_id)
);

-- Аляс прив'язаний до постачальника: та сама назва від двох постачальників — різні SKU.
-- Пишеться тільки з підтвердження людини, ніколи з рішення LLM.
CREATE TABLE IF NOT EXISTS sku_alias (
  id                   INTEGER PRIMARY KEY,
  supplier_id          INTEGER NOT NULL REFERENCES supplier(id),
  raw_name_normalized  TEXT NOT NULL,
  sku_id               INTEGER NOT NULL REFERENCES sku(id),
  created_at           TEXT NOT NULL,
  UNIQUE(supplier_id, raw_name_normalized)
);

-- Другий рівень ідемпотентності: той самий документ, що прийшов двома каналами,
-- має різний хеш (а отже різний thread_id), але провестися вдруге не зможе.
CREATE TABLE IF NOT EXISTS receipt (
  id             INTEGER PRIMARY KEY,
  thread_id      TEXT NOT NULL,
  supplier_id    INTEGER NOT NULL REFERENCES supplier(id),
  store_id       INTEGER NOT NULL REFERENCES store(id),
  doc_number     TEXT NOT NULL,
  doc_date       TEXT NOT NULL,
  total_net_kop  INTEGER NOT NULL,
  status         TEXT NOT NULL,                 -- posted | partial
  created_at     TEXT NOT NULL,
  UNIQUE(supplier_id, doc_number, doc_date)
);

CREATE TABLE IF NOT EXISTS receipt_line (
  id             INTEGER PRIMARY KEY,
  receipt_id     INTEGER NOT NULL REFERENCES receipt(id),
  sku_id         INTEGER NOT NULL REFERENCES sku(id),
  raw_name       TEXT NOT NULL,
  qty            REAL NOT NULL,
  price_net_kop  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS discrepancy_act (
  id          INTEGER PRIMARY KEY,
  thread_id   TEXT NOT NULL,
  receipt_id  INTEGER REFERENCES receipt(id),   -- NULL, якщо відмовили повністю
  message     TEXT NOT NULL,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS discrepancy_line (
  id           INTEGER PRIMARY KEY,
  act_id       INTEGER NOT NULL REFERENCES discrepancy_act(id),
  line_idx     INTEGER,                         -- NULL = розбіжність рівня документа
  raw_name     TEXT,
  reason_code  TEXT NOT NULL,
  detail       TEXT
);

-- Проєкція для CLI. Істина про стан графа живе в таблицях чекпойнтера; черга існує,
-- щоб команда review не читала чекпойнти руками.
CREATE TABLE IF NOT EXISTS review_queue (
  thread_id      TEXT PRIMARY KEY,
  store_code     TEXT,
  supplier_name  TEXT,
  doc_number     TEXT,
  issues_count   INTEGER NOT NULL,
  status         TEXT NOT NULL,                 -- pending | resolved
  created_at     TEXT NOT NULL
);
`;

export function openDb(file = DB_PATH) {
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(SCHEMA);
  return db;
}

const depth = new WeakMap();

/** Транзакція, терпима до вкладення: внутрішній виклик їде на зовнішній замість
 *  `cannot start a transaction within a transaction`. Відкату лише внутрішньої
 *  частини немає — для цього були б SAVEPOINT, яких тут нікому не треба. */
export function tx(db, fn) {
  const d = depth.get(db) ?? 0;
  if (d > 0) {
    depth.set(db, d + 1);
    try {
      return fn();
    } finally {
      depth.set(db, d);
    }
  }
  db.exec("BEGIN");
  depth.set(db, 1);
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  } finally {
    depth.set(db, 0);
  }
}

/** `node:sqlite` у вигляді, якого чекає SqliteSaver від better-sqlite3. */
class BetterSqliteShim {
  constructor(db) {
    this.db = db;
  }

  pragma(text) {
    this.db.exec(`PRAGMA ${text}`);
  }

  exec(sql) {
    this.db.exec(sql);
  }

  prepare(sql) {
    const stmt = this.db.prepare(sql);
    // better-sqlite3 приймає undefined як NULL, node:sqlite — ні. Перший чекпойнт
    // треда приходить без parent_checkpoint_id, тому без цього рядка падає кожен прогін.
    const bind = (args) => args.map((a) => (a === undefined ? null : a));
    return {
      get: (...a) => stmt.get(...bind(a)),
      all: (...a) => stmt.all(...bind(a)),
      run: (...a) => stmt.run(...bind(a)),
    };
  }

  transaction(fn) {
    return (...args) => tx(this.db, () => fn(...args));
  }
}

export const checkpointerFor = (db) => new SqliteSaver(new BetterSqliteShim(db));

export const loadSeedData = (file = SEED_PATH) => JSON.parse(readFileSync(file, "utf8"));

/** Ідемпотентний seed: повторний запуск не множить рядки й не змінює id. */
export function seedDb(db, data = loadSeedData()) {
  return tx(db, () => {
    const put = (sql) => db.prepare(sql);
    const upStore = put(
      "INSERT INTO store(code,name) VALUES(?,?) ON CONFLICT(code) DO UPDATE SET name=excluded.name",
    );
    const upSupplier = put(
      "INSERT INTO supplier(edrpou,name) VALUES(?,?) ON CONFLICT(edrpou) DO UPDATE SET name=excluded.name",
    );
    const upSku = put(`
      INSERT INTO sku(code,name,unit,pack_size,vat_rate,shelf_life_days,min_shelf_pct)
      VALUES(?,?,?,?,?,?,?)
      ON CONFLICT(code) DO UPDATE SET
        name=excluded.name, unit=excluded.unit, pack_size=excluded.pack_size,
        vat_rate=excluded.vat_rate, shelf_life_days=excluded.shelf_life_days,
        min_shelf_pct=excluded.min_shelf_pct`);
    const upProtocol = put(`
      INSERT INTO price_protocol(supplier_id,sku_id,price_net_kop,valid_from,valid_to)
      VALUES(?,?,?,?,?)
      ON CONFLICT(supplier_id,sku_id,valid_from) DO UPDATE SET
        price_net_kop=excluded.price_net_kop, valid_to=excluded.valid_to`);
    const upPo = put(`
      INSERT INTO po(number,store_id,supplier_id,created_at) VALUES(?,?,?,?)
      ON CONFLICT(number) DO UPDATE SET
        store_id=excluded.store_id, supplier_id=excluded.supplier_id,
        created_at=excluded.created_at`);
    const upPoLine = put(`
      INSERT INTO po_line(po_id,sku_id,qty) VALUES(?,?,?)
      ON CONFLICT(po_id,sku_id) DO UPDATE SET qty=excluded.qty`);

    const storeId = (code) => db.prepare("SELECT id FROM store WHERE code=?").get(code).id;
    const supplierId = (edrpou) =>
      db.prepare("SELECT id FROM supplier WHERE edrpou=?").get(edrpou).id;
    const skuId = (code) => db.prepare("SELECT id FROM sku WHERE code=?").get(code).id;

    for (const s of data.stores) upStore.run(s.code, s.name);
    for (const s of data.suppliers) upSupplier.run(s.edrpou, s.name);
    for (const s of data.sku) {
      upSku.run(s.code, s.name, s.unit, s.pack, s.vat, s.shelf ?? null, s.minShelf ?? null);
    }
    for (const p of data.protocols) {
      const kop = parseKop(p.priceNet);
      if (kop === null) throw new Error(`seed: не ціна в протоколі ${p.sku}: ${p.priceNet}`);
      upProtocol.run(supplierId(p.edrpou), skuId(p.sku), kop, p.from, p.to ?? null);
    }
    for (const order of data.po) {
      upPo.run(order.number, storeId(order.store), supplierId(order.supplier), order.createdAt);
      const poId = db.prepare("SELECT id FROM po WHERE number=?").get(order.number).id;
      for (const line of order.lines) upPoLine.run(poId, skuId(line.sku), line.qty);
    }

    return {
      stores: data.stores.length,
      suppliers: data.suppliers.length,
      sku: data.sku.length,
      protocols: data.protocols.length,
      po: data.po.length,
    };
  });
}

/** Чинна протокольна ціна без ПДВ на дату документа, або null. */
export function protocolFor(db, supplierId, skuId, onDate) {
  const row = db
    .prepare(
      `SELECT price_net_kop FROM price_protocol
        WHERE supplier_id=? AND sku_id=? AND valid_from<=?
          AND (valid_to IS NULL OR valid_to>=?)
        ORDER BY valid_from DESC LIMIT 1`,
    )
    .get(supplierId, skuId, onDate, onDate);
  return row ? row.price_net_kop : null;
}
