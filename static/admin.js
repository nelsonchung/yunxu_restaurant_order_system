import { api, element, failure, message, money, node, orderDetails, orderTime } from './common.js';

const dashboard = element('dashboard');
const loginPanel = element('login-panel');
const adminNav = element('admin-nav');
const adminError = element('admin-error');
const settleDialog = element('settle-dialog');
const settleError = element('settle-error');
const confirmSettle = element('confirm-settle');
const soundToggle = element('sound-toggle');
let displayedState;
let previousTables;
let pendingTable;
let audio;
let pollBusy = false;
let sessionVersion = 0;
let submitting = false;

function loginView() {
  sessionVersion += 1;
  displayedState = undefined;
  previousTables = undefined;
  dashboard.hidden = true;
  adminNav.hidden = true;
  loginPanel.hidden = false;
  if (settleDialog.open) settleDialog.close();
  element('active-tables').replaceChildren();
  element('today-orders').replaceChildren();
  element('notification').hidden = true;
  element('password').focus();
}

function playAlert() {
  if (audio?.state !== 'running') return;
  for (const [delay, frequency] of [[0, 660], [0.15, 880]]) {
    const oscillator = audio.createOscillator();
    const volume = audio.createGain();
    const time = audio.currentTime + delay;
    oscillator.frequency.value = frequency;
    volume.gain.setValueAtTime(0.001, time);
    volume.gain.exponentialRampToValueAtTime(0.15, time + 0.025);
    volume.gain.exponentialRampToValueAtTime(0.001, time + 0.13);
    oscillator.connect(volume).connect(audio.destination);
    oscillator.start(time);
    oscillator.stop(time + 0.15);
  }
}

function announceChanges(tables) {
  const current = new Map(tables.map((item) => [item.table, item]));
  if (previousTables) {
    const alerts = [];
    for (const table of tables) {
      const previous = previousTables.get(table.table);
      const orderIds = new Set(previous?.orders.map((order) => order.id));
      const count = table.orders.filter((order) => !orderIds.has(order.id)).length;
      if (count) alerts.push('第 ' + table.table + ' 桌新增 ' + count + ' 筆訂單');
      if (table.checkoutRequested && table.checkoutRequested !== previous?.checkoutRequested) {
        alerts.push('第 ' + table.table + ' 桌請求結帳');
      }
    }
    if (alerts.length) {
      const box = element('notification');
      const text = element('notification-text');
      text.textContent = [...(box.hidden ? [] : [text.textContent]), ...alerts].join('。');
      box.hidden = false;
      playAlert();
    }
  }
  previousTables = current;
}

function openSettlement(table) {
  pendingTable = table;
  element('settle-description').textContent = '第 ' + table.table + ' 桌共有 ' + table.orders.length
    + ' 筆待結帳訂單。請完成現場收款後再確認。';
  element('settle-total').textContent = money(table.total);
  message(settleError, '');
  confirmSettle.disabled = false;
  settleDialog.showModal();
}

function renderTable(table) {
  const hasOrders = Boolean(table.orders.length);
  const card = node('article', 'panel table-card');
  const header = node('div', 'table-card-title');
  const badge = table.checkoutRequested ? '請求結帳' : hasOrders ? '用餐中' : '無待結帳訂單';
  header.append(node('h3', '', '第 ' + table.table + ' 桌'),
    node('span', 'badge' + (table.checkoutRequested ? ' badge-active' : ''), badge));
  card.append(header);
  if (hasOrders) {
    for (const order of table.orders) {
      const details = node('details', 'table-order');
      const summary = node('summary');
      summary.textContent = '訂單 #' + order.id + ' · ' + orderTime(order.createdAt);
      details.append(summary, orderDetails(order));
      card.append(details);
    }
    const footer = node('div', 'table-card-footer');
    const button = node('button', 'button button-outline', '登記收款');
    button.type = 'button';
    button.addEventListener('click', () => openSettlement(table));
    footer.append(node('strong', '', money(table.total)), button);
    card.append(footer);
  }
  return card;
}

function renderOrder(order) {
  const article = node('article', 'history-order panel');
  const heading = node('div', 'history-heading');
  const title = node('h3', '', '第 ' + order.table + ' 桌');
  const meta = node('p', 'muted', '訂單 #' + order.id + ' · ' + orderTime(order.createdAt));
  const badge = node('span', 'badge' + (order.status === 'paid' ? ' badge-paid' : ''), order.status === 'paid' ? '已結帳' : '待結帳');
  heading.append(title, meta, badge);
  article.append(heading, orderDetails(order), node('strong', 'history-total', money(order.total)));
  return article;
}

function render(state) {
  loginPanel.hidden = true;
  dashboard.hidden = false;
  adminNav.hidden = false;
  const status = element('connection-status');
  status.textContent = '即時更新';
  status.classList.add('connected');
  message(adminError, '');
  announceChanges(state.tables);
  element('dashboard-date').textContent = state.date.replaceAll('-', ' / ');
  for (const unit of ['day', 'month', 'year']) {
    element('sales-' + unit).textContent = money(state.totals[unit]);
  }
  if (JSON.stringify(displayedState?.tables) !== JSON.stringify(state.tables)) {
    const container = element('active-tables');
    for (const table of state.tables) {
      const previous = displayedState?.tables.find((item) => item.table === table.table);
      if (JSON.stringify(previous) === JSON.stringify(table)) continue;
      const card = renderTable(table);
      const existing = element('table-' + table.table);
      card.id = 'table-' + table.table;
      if (existing) {
        const openOrders = [...existing.querySelectorAll('details')].filter((detail) => detail.open);
        for (const detail of card.querySelectorAll('details')) {
          detail.open = openOrders.some((oldDetail) => oldDetail.firstChild.textContent === detail.firstChild.textContent);
        }
        existing.replaceWith(card);
      } else {
        container.append(card);
      }
    }
    const active = state.tables.filter((table) => table.orders.length).length;
    element('table-summary').textContent = active + ' / ' + state.tables.length + ' 桌有待結帳訂單';
  }
  if (JSON.stringify(displayedState?.orders) !== JSON.stringify(state.orders)) {
    element('today-orders').replaceChildren(...state.orders.map(renderOrder));
    element('order-count').textContent = state.orders.length + ' 筆';
    element('no-orders').hidden = Boolean(state.orders.length);
  }
  displayedState = state;
}

async function refresh() {
  if (pollBusy || submitting) return;
  pollBusy = true;
  const version = sessionVersion;
  try {
    const state = await api('/api/admin/state');
    if (version === sessionVersion) render(state);
  } catch (error) {
    if (version !== sessionVersion) return;
    if (error.status === 401) {
      if (loginPanel.hidden) loginView();
      return;
    }
    element('connection-status').textContent = '連線中斷';
    element('connection-status').classList.remove('connected');
    message(adminError, failure(error), { error: true });
  } finally {
    pollBusy = false;
  }
}

element('login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = element('login-submit');
  const errorText = element('login-error');
  button.disabled = true;
  message(errorText, '');
  submitting = true;
  sessionVersion += 1;
  try {
    await api('/api/admin/login', { data: { password: element('password').value } });
    element('password').value = '';
    render(await api('/api/admin/state'));
  } catch (error) {
    message(errorText, failure(error), { error: true });
  } finally {
    submitting = false;
    button.disabled = false;
  }
});

element('logout').addEventListener('click', async (event) => {
  const button = event.currentTarget;
  button.disabled = true;
  submitting = true;
  sessionVersion += 1;
  try {
    await api('/api/admin/logout', { data: {} });
    message(adminError, '');
    loginView();
  } catch (error) {
    if (error.status === 401) loginView();
    else message(adminError, failure(error), { error: true });
  } finally {
    submitting = false;
    button.disabled = false;
  }
});

confirmSettle.addEventListener('click', async () => {
  confirmSettle.disabled = true;
  submitting = true;
  sessionVersion += 1;
  try {
    const state = await api('/api/admin/settle', {
      data: { table: pendingTable.table, orderIds: pendingTable.orders.map((order) => order.id) },
    });
    settleDialog.close();
    render(state);
  } catch (error) {
    if (error.status === 401) loginView();
    else if (error.status === 409) {
      message(settleError, failure(error), { error: true });
    } else {
      message(settleError, failure(error), { error: true });
      confirmSettle.disabled = false;
    }
  } finally {
    submitting = false;
  }
});

soundToggle.addEventListener('click', async () => {
  const active = audio?.state === 'running';
  try {
    if (active) await audio.suspend();
    else {
      audio ||= new AudioContext();
      await audio.resume();
    }
    soundToggle.textContent = active ? '開啟提示音' : '關閉提示音';
    soundToggle.setAttribute('aria-pressed', String(!active));
    if (!active) playAlert();
  } catch {
    message(adminError, '瀏覽器無法播放提示音，仍會顯示文字提醒。', { error: true });
  }
});
element('dismiss-notification').addEventListener('click', () => { element('notification').hidden = true; });

refresh();
setInterval(refresh, 3000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
