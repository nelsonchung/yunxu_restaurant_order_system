import base64
import json
import logging
import os
import re
import secrets
from datetime import timedelta
from functools import wraps
from pathlib import Path
from urllib.parse import urlsplit

import cv2
from flask import Flask, abort, jsonify, request, send_from_directory, session
from werkzeug.exceptions import HTTPException

from orders import TABLES, Conflict, Orders

ROOT = Path(__file__).resolve().parent


def qr_image(url):
    code = cv2.QRCodeEncoder_create().encode(url)
    code = cv2.copyMakeBorder(code, 4, 4, 4, 4, cv2.BORDER_CONSTANT, value=255)
    code = cv2.resize(code, None, fx=8, fy=8, interpolation=cv2.INTER_NEAREST)
    success, png = cv2.imencode('.png', code)
    if not success:
        raise RuntimeError('Unable to encode a QR image')
    return 'data:image/png;base64,' + base64.b64encode(png).decode('ascii')


def create_app(database, password, public_base):
    app = Flask(__name__, static_folder=ROOT / 'static')
    app.config.update(
        SECRET_KEY=secrets.token_hex(32),
        MAX_CONTENT_LENGTH=16 * 1024,
        SESSION_COOKIE_NAME='yunxu_staff',
        SESSION_COOKIE_HTTPONLY=True,
        SESSION_COOKIE_SAMESITE='Strict',
        SESSION_COOKIE_SECURE=public_base.startswith('https://'),
        SESSION_REFRESH_EACH_REQUEST=False,
        PERMANENT_SESSION_LIFETIME=timedelta(hours=12),
    )
    menu = json.loads((ROOT / 'data/menu.json').read_text(encoding='utf-8'))
    products = {item['id']: item for item in menu}
    orders = Orders(database)
    table_keys = orders.keys()
    password_bytes = password.encode('utf-8')

    def error(message, status=400):
        return jsonify(error=message), status

    @app.after_request
    def set_headers(response):
        response.headers['Referrer-Policy'] = 'no-referrer'
        response.headers['X-Content-Type-Options'] = 'nosniff'
        response.headers['Content-Security-Policy'] = (
            "default-src 'self'; img-src 'self' data:; object-src 'none'; "
            "base-uri 'none'; frame-ancestors 'none'; form-action 'self'"
        )
        if response.mimetype != 'image/webp':
            response.headers['Cache-Control'] = 'no-store'
        return response

    @app.errorhandler(Conflict)
    def conflict(exc):
        return error(str(exc), 409)

    @app.errorhandler(HTTPException)
    def http_error(exc):
        messages = {
            400: '資料格式錯誤。', 404: '找不到這個頁面。', 405: '此操作不支援。',
            413: '送出的資料太長。', 415: '資料格式錯誤。', 500: '伺服器忙碌，請稍後再試。',
        }
        return error(messages.get(exc.code, '無法處理此操作。'), exc.code)

    def staff_only(handler):
        @wraps(handler)
        def protected():
            if not session.get('staff'):
                return error('請先登入店家後台。', 401)
            return handler()
        return protected

    def body():
        payload = request.get_json()
        if not isinstance(payload, dict):
            abort(400)
        return payload

    def valid_table(table, key):
        if type(table) is not int or table not in TABLES or not isinstance(key, str):
            return False
        return secrets.compare_digest(table_keys[table].encode(), key.encode('utf-8'))

    @app.get('/')
    def home():
        return send_from_directory(ROOT / 'static', 'index.html')

    @app.get('/table/<int:table>')
    def customer(table):
        if not valid_table(table, request.args.get('key')):
            return error('桌號連結無效，請重新掃描桌上的 QR Code。', 404)
        return send_from_directory(ROOT / 'static', 'customer.html')

    @app.get('/admin')
    def admin():
        return send_from_directory(ROOT / 'static', 'admin.html')

    @app.get('/admin/qr')
    def qr_page():
        return send_from_directory(ROOT / 'static', 'qr.html')

    @app.get('/healthz')
    def health():
        return jsonify(ok=True)

    @app.get('/api/menu')
    def get_menu():
        return jsonify(menu)

    @app.get('/api/table')
    def get_table():
        table = request.args.get('table', type=int)
        if not valid_table(table, request.args.get('key')):
            return error('桌號連結無效，請重新掃描桌上的 QR Code。', 403)
        return jsonify(orders.table_state(table))

    @app.post('/api/orders')
    def add_order():
        data = body()
        table = data.get('table')
        if not valid_table(table, data.get('key')):
            return error('桌號連結無效，請重新掃描桌上的 QR Code。', 403)
        items = data.get('items')
        if not isinstance(items, list) or not 1 <= len(items) <= len(products):
            return error('請確認購物車裡的餐點。')
        note = data.get('note', '')
        if not isinstance(note, str) or len(note) > 200:
            return error('備註限 200 字。')
        request_key = request.headers.get('Idempotency-Key')
        if request_key is not None and not re.fullmatch(r'[a-zA-Z0-9_-]{12,100}', request_key):
            return error('送單識別碼無效，請重新整理頁面。')
        checked = {}
        for item in items:
            if not isinstance(item, dict):
                return error('請確認購物車裡的餐點。')
            item_id, quantity = item.get('id'), item.get('quantity')
            if not isinstance(item_id, str) or item_id not in products or item_id in checked:
                return error('購物車含有無效的餐點。')
            if type(quantity) is not int or not 1 <= quantity <= 99:
                return error('每種餐點的數量須介於 1 至 99。')
            product = products[item_id]
            checked[item_id] = dict(id=item_id, name=product['name'], price=product['price'], quantity=quantity)
        ordered = [checked[item_id] for item_id in sorted(checked)]
        return jsonify(orders.add(table, ordered, note.strip(), request_key)), 201

    @app.post('/api/checkout')
    def checkout():
        data = body()
        table = data.get('table')
        if not valid_table(table, data.get('key')):
            return error('桌號連結無效，請重新掃描桌上的 QR Code。', 403)
        return jsonify(orders.checkout(table))

    @app.post('/api/admin/login')
    def login():
        attempt = body().get('password')
        if not isinstance(attempt, str) or not secrets.compare_digest(password_bytes, attempt.encode('utf-8')):
            return error('密碼錯誤。', 401)
        session.clear()
        session.permanent = True
        session['staff'] = True
        return jsonify(ok=True)

    @app.post('/api/admin/logout')
    def logout():
        body()
        session.clear()
        return jsonify(ok=True)

    @app.get('/api/admin/state')
    @staff_only
    def admin_state():
        return jsonify(orders.admin_state())

    @app.post('/api/admin/settle')
    @staff_only
    def settle():
        data = body()
        table, ids = data.get('table'), data.get('orderIds')
        if type(table) is not int or table not in TABLES or not isinstance(ids, list) or not ids:
            return error('請選擇有待結帳訂單的桌次。')
        if any(type(order) is not int or order < 1 for order in ids):
            return error('訂單資料錯誤。')
        return jsonify(orders.settle(table, set(ids)))

    @app.get('/api/admin/qr')
    @staff_only
    def qr_data():
        base = request.args.get('base', '').strip().rstrip('/') or public_base
        try:
            parsed = urlsplit(base)
            valid = (parsed.scheme in ('http', 'https') and parsed.hostname and not parsed.username
                     and parsed.password is None and not parsed.path and not parsed.query and not parsed.fragment
                     and parsed.port != 0 and re.fullmatch(r'https?://[a-zA-Z0-9.:[\]-]{1,220}', base))
        except ValueError:
            valid = False
        if not valid:
            return error('請輸入有效的網站網址，例如 http://192.168.8.235:8083。')
        result = []
        for table in TABLES:
            url = f'{base}/table/{table}?key={table_keys[table]}'
            result.append(dict(table=table, url=url, image=qr_image(url)))
        return jsonify(base=base, tables=result)

    return app


def main():
    os.umask(0o077)
    credential_dir = Path(os.environ.get('CREDENTIALS_DIRECTORY', ROOT / 'instance'))
    password = (credential_dir / 'admin-password').read_text(encoding='utf-8').strip()
    if len(password) < 12:
        raise ValueError('Admin password must have at least 12 characters')
    database = Path(os.environ.get('YUNXU_DATABASE', ROOT / 'instance/orders.sqlite3'))
    database.parent.mkdir(parents=True, exist_ok=True)
    port = int(os.environ.get('YUNXU_PORT', '8083'))
    host = os.environ.get('YUNXU_HOST', '127.0.0.1')
    public_base = os.environ.get('YUNXU_PUBLIC_BASE', f'http://{host}:{port}').rstrip('/')
    app = create_app(database, password, public_base)
    # Werkzeug's access log would include each table's access key in its URL.
    logging.getLogger('werkzeug').setLevel(logging.WARNING)
    app.run(host=host, port=port, debug=False, use_reloader=False)


if __name__ == '__main__':
    main()
