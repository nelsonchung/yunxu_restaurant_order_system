import { api, element, failure, message, money, node, orderDetails, orderTime } from './common.js';

const table = Number(location.pathname.split('/').filter(Boolean).at(-1));
const key = new URLSearchParams(location.search).get('key') || '';
const identity = { table, key };
const query = new URLSearchParams(identity);
const menu = new Map();
const cart = new Map();
const maxQuantity = 99;
const cartDialog = element('cart-dialog');
const billDialog = element('bill-dialog');
const noteInput = element('order-note');
const cartError = element('cart-error');
const billMessage = element('bill-message');
const submitOrder = element('submit-order');
const checkoutButton = element('request-checkout');
let tableState;
let selectedCategory = '';
let orderRequest;
let sending = false;
let requestingCheckout = false;
let billPollBusy = false;
let billVersion = 0;

function cartTotal() {
  let total = 0;
  let count = 0;
  for (const [id, quantity] of cart) {
    total += menu.get(id).price * quantity;
    count += quantity;
  }
  return { total, count };
}

function announce(text) {
  element('customer-status').textContent = text;
}

function updateQuantity(id, amount) {
  if (sending) return;
  const quantity = Math.min(maxQuantity, (cart.get(id) || 0) + amount);
  if (quantity > 0) cart.set(id, quantity);
  else cart.delete(id);
  orderRequest = undefined;
  message(cartError, '');
  renderCart();
  updateMenuButtons();
  announce(menu.get(id).name + '，購物車中有 ' + Math.max(quantity, 0) + ' 份');
}

function makeStepper(item) {
  const stepper = node('div', 'stepper');
  const minus = node('button', 'stepper-button', '−');
  minus.type = 'button';
  minus.setAttribute('aria-label', '減少一份' + item.name);
  minus.addEventListener('click', () => updateQuantity(item.id, -1));
  const value = node('span', 'stepper-value', '0');
  const plus = node('button', 'stepper-button', '+');
  plus.type = 'button';
  plus.setAttribute('aria-label', '增加一份' + item.name);
  plus.addEventListener('click', () => updateQuantity(item.id, 1));
  stepper.append(minus, value, plus);
  return { stepper, minus, value, plus };
}

function updateStepper(item, controls) {
  const quantity = cart.get(item.id) || 0;
  controls.minus.disabled = sending || quantity === 0;
  controls.plus.disabled = sending || quantity >= maxQuantity;
  controls.value.textContent = quantity;
}

const menuSteppers = new Map();

function updateMenuButtons() {
  for (const [id, controls] of menuSteppers) updateStepper(menu.get(id), controls);
}

function renderMenu() {
  const grid = element('menu-items');
  menuSteppers.clear();
  const items = [...menu.values()].filter((item) => !selectedCategory || item.category === selectedCategory);
  element('menu-count').textContent = items.length + ' 道餐點';
  grid.replaceChildren();
  for (const item of items) {
    const card = node('article', 'menu-card');
    if (item.image) {
      const image = node('img', 'menu-photo');
      image.loading = 'lazy';
      image.alt = '';
      image.src = item.image;
      card.append(image);
    }
    const body = node('div', 'menu-card-body');
    body.append(node('h3', '', item.name));
    if (item.description) body.append(node('p', 'muted menu-description', item.description));
    const footer = node('div', 'menu-card-footer');
    const controls = makeStepper(item);
    menuSteppers.set(item.id, controls);
    footer.append(node('strong', 'item-price', money(item.price)), controls.stepper);
    body.append(footer);
    card.append(body);
    grid.append(card);
  }
  updateMenuButtons();
}

function renderCategories() {
  const categoryBar = element('categories');
  const categories = [...new Set([...menu.values()].map((item) => item.category).filter(Boolean))];
  if (!categories.length) return;
  for (const category of ['', ...categories]) {
    const button = node('button', 'category-button', category || '全部餐點');
    button.type = 'button';
    button.setAttribute('aria-pressed', String(!category));
    button.addEventListener('click', () => {
      selectedCategory = category;
      for (const child of categoryBar.children) child.setAttribute('aria-pressed', String(child === button));
      renderMenu();
    });
    categoryBar.append(button);
  }
  categoryBar.hidden = false;
}

const cartRows = new Map();

function renderCart() {
  const { total, count } = cartTotal();
  element('cart-bar').hidden = !count;
  element('cart-count').textContent = count + ' 份餐點';
  element('cart-total').textContent = money(total);
  element('cart-dialog-total').textContent = money(total);
  submitOrder.disabled = sending || !count;
  submitOrder.textContent = sending ? '送單中…' : '送出訂單';
  noteInput.disabled = sending;
  const lines = element('cart-lines');
  for (const [id, row] of cartRows) {
    if (!cart.has(id)) {
      row.container.remove();
      cartRows.delete(id);
    }
  }
  for (const [id, quantity] of cart) {
    const item = menu.get(id);
    let row = cartRows.get(id);
    if (!row) {
      const container = node('div', 'cart-line');
      const label = node('div');
      const price = node('span', 'muted');
      const controls = makeStepper(item);
      label.append(node('strong', '', item.name), price);
      container.append(label, controls.stepper);
      lines.append(container);
      row = { container, controls, price };
      cartRows.set(id, row);
    }
    row.price.textContent = money(item.price * quantity);
    updateStepper(item, row.controls);
  }
  const empty = element('empty-cart');
  if (count) empty?.remove();
  else if (!empty) {
    const text = node('p', 'muted', '購物車還沒有餐點。');
    text.id = 'empty-cart';
    lines.append(text);
  }
}

function refreshBill(state) {
  tableState = state;
  const orders = element('bill-orders');
  orders.replaceChildren();
  for (const order of state.orders) {
    const card = node('article', 'bill-order');
    const header = node('div', 'order-header');
    header.append(node('strong', '', '訂單 #' + order.id), node('time', 'muted', orderTime(order.createdAt)));
    card.append(header, orderDetails(order));
    orders.append(card);
  }
  if (!state.orders.length) orders.append(node('p', 'muted', '目前沒有待結帳的訂單。'));
  element('bill-total').textContent = money(state.total);
  checkoutButton.disabled = requestingCheckout || !state.orders.length || Boolean(state.checkoutRequested);
  checkoutButton.textContent = state.checkoutRequested ? '已通知店員' : '通知店員結帳';
  element('show-bill').textContent = state.orders.length ? '本桌帳單 · ' + money(state.total) : '本桌帳單';
  if (state.checkoutRequested) message(billMessage, '店員已收到結帳通知，請在店內付款。');
  else if (!billMessage.classList.contains('error')) message(billMessage, '');
}

async function loadBill() {
  if (!billDialog.open || billPollBusy || requestingCheckout || sending || document.hidden) return;
  billPollBusy = true;
  const version = billVersion;
  try {
    const state = await api('/api/table?' + query);
    if (version === billVersion) {
      message(billMessage, '');
      refreshBill(state);
    }
  } catch (error) {
    if (version === billVersion) message(billMessage, failure(error), { error: true });
  } finally {
    billPollBusy = false;
  }
}

function generateRequestId() {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

element('show-cart').addEventListener('click', () => cartDialog.showModal());
element('show-bill').addEventListener('click', () => {
  message(billMessage, '');
  if (tableState) refreshBill(tableState);
  billDialog.showModal();
  loadBill();
});
setInterval(loadBill, 3000);
noteInput.addEventListener('input', () => { orderRequest = undefined; });
element('order-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (sending || !cart.size) return;
  const items = [...cart].map(([id, quantity]) => ({ id, quantity }));
  orderRequest ||= generateRequestId();
  sending = true;
  billVersion += 1;
  renderCart();
  updateMenuButtons();
  message(cartError, '');
  try {
    const state = await api('/api/orders', {
      data: { ...identity, items, note: noteInput.value.trim() },
      headers: { 'Idempotency-Key': orderRequest },
    });
    orderRequest = undefined;
    cart.clear();
    noteInput.value = '';
    cartDialog.close();
    refreshBill(state);
    element('show-bill').focus();
    message(billMessage, '餐點已送出。');
    if (!billDialog.open) billDialog.showModal();
    announce('餐點已送出');
  } catch (error) {
    message(cartError, failure(error), { error: true });
  } finally {
    sending = false;
    renderCart();
    updateMenuButtons();
  }
});
checkoutButton.addEventListener('click', async () => {
  if (requestingCheckout) return;
  requestingCheckout = true;
  billVersion += 1;
  checkoutButton.disabled = true;
  message(billMessage, '');
  try {
    refreshBill(await api('/api/checkout', { data: identity }));
  } catch (error) {
    message(billMessage, failure(error), { error: true });
  } finally {
    requestingCheckout = false;
    checkoutButton.disabled = !tableState?.orders.length || Boolean(tableState.checkoutRequested);
  }
});

async function initialize() {
  const status = element('menu-status');
  try {
    const [catalog, state] = await Promise.all([api('/api/menu'), api('/api/table?' + query)]);
    for (const item of catalog) menu.set(item.id, item);
    const heroItem = catalog.find((item) => item.image);
    if (heroItem) {
      element('hero-image').src = heroItem.image;
      element('hero-image').hidden = false;
    }
    element('table-label').textContent = '第 ' + state.table + ' 桌';
    element('table-label').hidden = false;
    refreshBill(state);
    element('show-bill').hidden = false;
    renderCategories();
    renderMenu();
    message(status, catalog.length ? '' : '目前沒有可點選的餐點。');
  } catch (error) {
    message(status, '');
    message(element('customer-error'), error.status
      ? '無法開啟本桌菜單，請重新掃描桌牌上的 QR Code。'
      : failure(error), { error: true });
  }
}

initialize();
