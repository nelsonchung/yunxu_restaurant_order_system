import { api, element, failure, message, node } from './common.js';

const form = element('qr-form');
const input = element('qr-base');
const print = element('print-qr');
const generate = element('generate-qr');
const status = element('qr-message');

async function load(base) {
  print.disabled = true;
  generate.disabled = true;
  message(status, '正在產生桌牌…');
  const grid = element('qr-cards');
  grid.replaceChildren();
  try {
    const query = base ? '?' + new URLSearchParams({ base }) : '';
    const result = await api('/api/admin/qr' + query);
    input.value = result.base;
    const cards = result.tables.map((table) => {
      const card = node('article', 'panel qr-card');
      const image = node('img');
      image.src = table.image;
      image.alt = '第 ' + table.table + ' 桌點餐 QR Code';
      const link = node('a', 'qr-url', table.url);
      link.href = table.url;
      card.append(node('span', 'qr-brand', '雲序食堂'), node('h2', '', '第 ' + table.table + ' 桌'),
        image, node('p', 'qr-instruction', '掃碼點餐'), link);
      return { card, image };
    });
    await Promise.all(cards.map(({ image }) => image.decode()));
    grid.replaceChildren(...cards.map(({ card }) => card));
    message(status, '');
    print.disabled = false;
  } catch (error) {
    if (error.status === 401) location.replace('/admin');
    else message(status, failure(error), { error: true });
  } finally {
    generate.disabled = false;
  }
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  load(input.value);
});
print.addEventListener('click', () => window.print());
load();
