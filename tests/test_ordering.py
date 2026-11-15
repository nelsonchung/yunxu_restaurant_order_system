import base64
import tempfile
import unittest
from datetime import datetime
from pathlib import Path
from unittest.mock import patch
from urllib.parse import parse_qs, urlsplit

import cv2
import numpy as np

from app import create_app
from orders import TAIPEI


class OrderingTest(unittest.TestCase):
    def setUp(self):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        self.database = Path(folder.name) / 'orders.sqlite3'
        self.password = 'test-only-admin-password'
        self.base = 'http://192.168.8.235:8083'
        self.app = create_app(self.database, self.password, self.base)
        self.staff = self.app.test_client()
        self.customer = self.app.test_client()
        self.assertEqual(self.staff.get('/api/admin/state').status_code, 401)
        response = self.staff.post('/api/admin/login', json={'password': self.password})
        self.assertEqual(response.status_code, 200)
        qr = self.staff.get('/api/admin/qr').get_json()
        self.qr = qr['tables']
        self.tables = {entry['table']: parse_qs(urlsplit(entry['url']).query)['key'][0] for entry in self.qr}
        self.item = self.customer.get('/api/menu').get_json()[0]

    def submit(self, table, count, token, key=None):
        return self.customer.post('/api/orders', headers={'Idempotency-Key': token}, json={
            'table': table, 'key': key or self.tables[table],
            'items': [{'id': self.item['id'], 'quantity': count, 'price': 1}], 'note': '不要辣',
        })

    def test_qr_codes_decode_to_six_distinct_table_links(self):
        self.assertEqual(set(self.tables), set(range(1, 7)))
        self.assertEqual(len(set(self.tables.values())), 6)
        for result in self.qr:
            with self.subTest(table=result['table']):
                image = base64.b64decode(result['image'].split(',', 1)[1])
                code = cv2.imdecode(np.frombuffer(image, dtype=np.uint8), cv2.IMREAD_GRAYSCALE)
                decoded, _, _ = cv2.QRCodeDetector().detectAndDecode(code)
                self.assertEqual(decoded, result['url'])
                self.assertEqual(urlsplit(decoded).path, f"/table/{result['table']}")

    def test_checkout_rejects_stale_bill_and_preserves_other_table(self):
        self.assertEqual(self.submit(2, 1, 'invalid-table-key', self.tables[1]).status_code, 403)
        first = self.submit(1, 2, 'same-request-001').get_json()
        retry = self.submit(1, 2, 'same-request-001').get_json()
        self.assertEqual(first, retry)
        self.assertEqual(first['total'], 2 * self.item['price'])
        self.assertEqual(self.submit(1, 1, 'same-request-001').status_code, 409)
        self.assertEqual(self.submit(2, 1, 'other-table-001').status_code, 201)

        request_body = {'table': 1, 'key': self.tables[1]}
        checkout = self.customer.post('/api/checkout', json=request_body).get_json()
        self.assertTrue(checkout['checkoutRequested'])
        state = self.staff.get('/api/admin/state').get_json()
        self.assertEqual(state['tables'][0]['checkoutRequested'], checkout['checkoutRequested'])
        self.assertEqual(state['totals']['day'], 0)
        additional = self.submit(1, 1, 'extra-order-001').get_json()
        bill = {'table': 1, 'orderIds': [first['orders'][0]['id']]}
        self.assertEqual(self.staff.post('/api/admin/settle', json=bill).status_code, 409)
        bill['orderIds'] = [order['id'] for order in additional['orders']]
        result = self.staff.post('/api/admin/settle', json=bill).get_json()
        self.assertEqual(result['totals'], {period: 3 * self.item['price'] for period in ('day', 'month', 'year')})
        self.assertEqual(result['tables'][0], {'table': 1, 'total': 0, 'orders': [], 'checkoutRequested': None})
        self.assertEqual(result['tables'][1]['total'], self.item['price'])
        self.assertEqual(self.staff.post('/api/admin/settle', json=bill).status_code, 409)

        restarted = create_app(self.database, self.password, self.base).test_client()
        restarted.post('/api/admin/login', json={'password': self.password})
        self.assertEqual(restarted.get('/api/admin/state').get_json(), result)
        self.assertEqual(restarted.get('/api/admin/qr').get_json()['tables'], self.qr)

    def test_sales_follow_taipei_settlement_date(self):
        def settle_at(year, month, day, number, quantity):
            with patch('orders.now', return_value=datetime(year, month, day, 0, 1, tzinfo=TAIPEI)):
                result = self.submit(1, quantity, f'date-test-{number:04}').get_json()
                response = self.staff.post('/api/admin/settle', json={
                    'table': 1, 'orderIds': [result['orders'][0]['id']],
                })
                self.assertEqual(response.status_code, 200)
                return response.get_json()

        settle_at(2025, 12, 31, 1, 1)
        settle_at(2026, 10, 31, 2, 2)
        settle_at(2026, 11, 14, 3, 3)
        state = settle_at(2026, 11, 15, 4, 4)
        price = self.item['price']
        self.assertEqual(state['totals'], {'day': 4 * price, 'month': 7 * price, 'year': 9 * price})
        self.assertEqual(len(state['orders']), 1)
        self.assertEqual(state['orders'][0]['status'], 'paid')


if __name__ == '__main__':
    unittest.main()
