import json
import secrets
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

TABLES = range(1, 7)
TAIPEI = ZoneInfo('Asia/Taipei')


def now():
    return datetime.now(TAIPEI)


class Conflict(Exception):
    pass


class Orders:
    def __init__(self, path):
        self.path = path
        with self.connect() as db:
            db.execute('PRAGMA journal_mode = WAL')
            db.executescript('''
                CREATE TABLE IF NOT EXISTS restaurant_tables (
                    id INTEGER PRIMARY KEY,
                    access_key TEXT NOT NULL UNIQUE,
                    checkout_requested TEXT
                );
                CREATE TABLE IF NOT EXISTS orders (
                    id INTEGER PRIMARY KEY,
                    table_id INTEGER NOT NULL REFERENCES restaurant_tables(id),
                    created_at TEXT NOT NULL,
                    paid_at TEXT,
                    items TEXT NOT NULL,
                    note TEXT NOT NULL,
                    total INTEGER NOT NULL CHECK (total >= 0),
                    request_key TEXT,
                    request_body TEXT,
                    UNIQUE (table_id, request_key)
                );
                CREATE INDEX IF NOT EXISTS orders_created ON orders(created_at);
                CREATE INDEX IF NOT EXISTS orders_paid ON orders(paid_at);
                CREATE INDEX IF NOT EXISTS orders_open ON orders(table_id) WHERE paid_at IS NULL;
            ''')
            db.executemany('INSERT OR IGNORE INTO restaurant_tables (id, access_key) VALUES (?, ?)',
                           [(table, secrets.token_urlsafe(18)) for table in TABLES])

    @contextmanager
    def connect(self):
        db = sqlite3.connect(self.path, timeout=5, autocommit=True)
        db.row_factory = sqlite3.Row
        db.execute('PRAGMA foreign_keys = ON')
        try:
            yield db
        finally:
            db.close()

    @contextmanager
    def transaction(self, *, write=False):
        with self.connect() as db:
            db.execute('BEGIN IMMEDIATE' if write else 'BEGIN')
            yield db
            db.execute('COMMIT')

    def keys(self):
        with self.connect() as db:
            return {row['id']: row['access_key'] for row in db.execute('SELECT id, access_key FROM restaurant_tables')}

    @staticmethod
    def order_data(row):
        return dict(id=row['id'], table=row['table_id'], createdAt=row['created_at'],
                    paidAt=row['paid_at'], status='paid' if row['paid_at'] else 'open',
                    items=json.loads(row['items']), note=row['note'], total=row['total'])

    def table_data(self, db, table):
        row = db.execute('SELECT checkout_requested FROM restaurant_tables WHERE id = ?', (table,)).fetchone()
        orders = [self.order_data(order) for order in db.execute('''
            SELECT * FROM orders WHERE table_id = ? AND paid_at IS NULL ORDER BY id
        ''', (table,))]
        return dict(table=table, orders=orders, total=sum(order['total'] for order in orders),
                    checkoutRequested=row['checkout_requested'])

    def table_state(self, table):
        with self.transaction() as db:
            return self.table_data(db, table)

    def add(self, table, items, note, request_key):
        item_data = json.dumps(items, ensure_ascii=False)
        request_body = json.dumps([[(item['id'], item['quantity']) for item in items], note], ensure_ascii=False)
        total = sum(item['price'] * item['quantity'] for item in items)
        with self.transaction(write=True) as db:
            previous = db.execute('SELECT request_body FROM orders WHERE table_id = ? AND request_key = ?',
                                  (table, request_key)).fetchone()
            if previous:
                if previous['request_body'] != request_body:
                    raise Conflict('這次送單已處理，請重新確認購物車。')
                return self.table_data(db, table)
            db.execute('''
                INSERT INTO orders (table_id, created_at, items, note, total, request_key, request_body)
                VALUES (?, ?, ?, ?, ?, ?, ?)
            ''', (table, now().isoformat(timespec='microseconds'), item_data, note, total, request_key, request_body))
            return self.table_data(db, table)

    def checkout(self, table):
        with self.transaction(write=True) as db:
            if not db.execute('SELECT 1 FROM orders WHERE table_id = ? AND paid_at IS NULL', (table,)).fetchone():
                raise Conflict('這桌目前沒有未結帳的餐點。')
            db.execute('''
                UPDATE restaurant_tables SET checkout_requested = COALESCE(checkout_requested, ?) WHERE id = ?
            ''', (now().isoformat(timespec='microseconds'), table))
            return self.table_data(db, table)

    def settle(self, table, order_ids):
        with self.transaction(write=True) as db:
            current = {row['id'] for row in db.execute('''
                SELECT id FROM orders WHERE table_id = ? AND paid_at IS NULL
            ''', (table,))}
            if current != order_ids:
                raise Conflict('這桌的訂單已變更，請確認最新金額後再結帳。')
            db.execute('UPDATE orders SET paid_at = ? WHERE table_id = ? AND paid_at IS NULL',
                       (now().isoformat(timespec='microseconds'), table))
            db.execute('UPDATE restaurant_tables SET checkout_requested = NULL WHERE id = ?', (table,))
            return self.admin_data(db)

    def admin_data(self, db):
        today = now().date()
        day = today.isoformat()
        tomorrow = (today + timedelta(days=1)).isoformat()
        month = today.replace(day=1).isoformat()
        year = today.replace(month=1, day=1).isoformat()
        totals = db.execute('''
            SELECT COALESCE(SUM(CASE WHEN paid_at >= ? THEN total END), 0) AS day,
                   COALESCE(SUM(CASE WHEN paid_at >= ? THEN total END), 0) AS month,
                   COALESCE(SUM(total), 0) AS year
            FROM orders WHERE paid_at >= ? AND paid_at < ?
        ''', (day, month, year, tomorrow)).fetchone()
        orders = [self.order_data(row) for row in db.execute('''
            SELECT * FROM orders WHERE created_at >= ? AND created_at < ? ORDER BY id DESC
        ''', (day, tomorrow))]
        return dict(date=day, totals=dict(totals), orders=orders,
                    tables=[self.table_data(db, table) for table in TABLES])

    def admin_state(self):
        with self.transaction() as db:
            return self.admin_data(db)
