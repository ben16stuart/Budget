import { api } from './api.js';
import { openEntryForm } from './forms.js';
import { toast } from './modal.js';
import { onRefresh, state } from './store.js';
import { h, setCurrency, todayISO } from './util.js';
import { renderAccounts } from './views/accounts.js';
import { renderCalendar } from './views/calendar.js';
import { renderEntries } from './views/entries.js';
import { renderSettings } from './views/settings.js';

const VIEWS = {
  calendar: renderCalendar,
  entries: renderEntries,
  accounts: renderAccounts,
  settings: renderSettings,
};

const viewEl = document.getElementById('view');

function route() {
  const [, view, param] = location.hash.replace(/^#\/?/, '/').split('/');
  return VIEWS[view] ? { view, param } : { view: 'calendar', param: undefined };
}

let rendering = Promise.resolve();

function render() {
  // Serialize renders so a slow one never overwrites a newer one.
  rendering = rendering.then(async () => {
    const { view, param } = route();
    document.querySelectorAll('#tabs a').forEach((a) => a.classList.toggle('active', a.dataset.view === view));
    try {
      await VIEWS[view](viewEl, param);
    } catch (err) {
      viewEl.replaceChildren(h('div', { class: 'page' }, h('div', { class: 'panel error' },
        h('h2', null, 'Something went wrong'), h('p', null, err.message || String(err)))));
    }
  });
  return rendering;
}

function updateBadge() {
  const count = state.alerts.action_items.length + state.alerts.balance_alerts.length;
  document.title = count ? `(${count}) Budget` : 'Budget';
  const tab = document.querySelector('#tabs a[data-view="calendar"]');
  tab.querySelector('.count')?.remove();
  if (count) tab.append(h('span', { class: 'count' }, count));
}

async function loadData() {
  state.today = todayISO();
  const [accounts, alerts] = await Promise.all([api.accounts(state.today), api.alerts(state.today)]);
  state.accounts = accounts;
  state.alerts = alerts;
  updateBadge();
}

async function start() {
  try {
    state.settings = await api.settings();
    setCurrency(state.settings.currency);
    await loadData();
  } catch (err) {
    toast(`Could not load data: ${err.message}`, 'error');
  }
  await render();
}

// Re-read settings too: currency and week start can change.
onRefresh(async () => {
  state.settings = await api.settings();
  setCurrency(state.settings.currency);
  await loadData();
  await render();
});

window.addEventListener('hashchange', render);
document.getElementById('add-entry').addEventListener('click', () => openEntryForm());

// Refresh when coming back to a tab left open (e.g. the next morning).
let hiddenAt = 0;
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    hiddenAt = Date.now();
  } else if (Date.now() - hiddenAt > 60_000 && !document.body.classList.contains('modal-open')) {
    if (state.today !== todayISO() && state.month === state.today.slice(0, 7)) state.month = todayISO().slice(0, 7);
    loadData().then(render).catch(() => {});
  }
});

document.addEventListener('keydown', (ev) => {
  if (document.body.classList.contains('modal-open') || ev.target.closest('input, select, textarea')) return;
  if (route().view !== 'calendar' || ev.metaKey || ev.ctrlKey || ev.altKey) return;
  if (ev.key === 'ArrowLeft' || ev.key === 'ArrowRight') {
    const [y, m] = state.month.split('-').map(Number);
    const d = new Date(Date.UTC(y, m - 1 + (ev.key === 'ArrowLeft' ? -1 : 1), 1));
    location.hash = `#/calendar/${d.toISOString().slice(0, 7)}`;
  }
});

start();
