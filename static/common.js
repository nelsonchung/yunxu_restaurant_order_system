export const element = (id) => document.getElementById(id);

export function node(tag, className, value) {
  const item = document.createElement(tag);
  if (className) item.className = className;
  if (value !== undefined) item.textContent = value;
  return item;
}

export function message(target, value, { error = false } = {}) {
  target.textContent = value;
  target.hidden = !value;
  target.classList.toggle('error', error);
}

export async function api(path, { data, headers = {} } = {}) {
  const response = await fetch(path, {
    method: data === undefined ? 'GET' : 'POST',
    headers: data === undefined ? headers : { 'Content-Type': 'application/json', ...headers },
    body: data === undefined ? undefined : JSON.stringify(data),
    cache: 'no-store',
  });
  const payload = await response.json();
  if (!response.ok) {
    const error = new Error(payload.error || '操作失敗，請稍後再試。');
    error.status = response.status;
    throw error;
  }
  return payload;
}

export function failure(error) {
  return error.status ? error.message : '暫時無法連線，請確認 Wi-Fi 後再試。';
}

const currency = new Intl.NumberFormat('zh-TW');
export const money = (value) => 'NT$ ' + currency.format(value);

const dateTime = new Intl.DateTimeFormat('zh-TW', {
  timeZone: 'Asia/Taipei', month: 'numeric', day: 'numeric',
  hour: '2-digit', minute: '2-digit', hour12: false,
});
export const orderTime = (value) => dateTime.format(new Date(value));

export function orderDetails(order) {
  const details = node('div', 'order-detail');
  const items = node('ul', 'order-items');
  for (const item of order.items) {
    const line = node('li');
    line.append(node('span', '', item.name + ' × ' + item.quantity));
    line.append(node('span', '', money(item.price * item.quantity)));
    items.append(line);
  }
  details.append(items);
  if (order.note) details.append(node('p', 'order-note', '備註：' + order.note));
  return details;
}
