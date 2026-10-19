import { api } from '../api.js';
import { confirmDanger, toast } from '../modal.js';
import { run, state } from '../store.js';
import { h } from '../util.js';

const CURRENCIES = ['USD', 'CAD', 'EUR', 'GBP', 'AUD', 'NZD', 'CHF', 'JPY', 'INR', 'MXN', 'SEK', 'NOK', 'DKK', 'ZAR'];

function field(label, control, hint) {
  return h('label', { class: 'field' }, h('span', { class: 'field-label' }, label), control,
    hint ? h('span', { class: 'hint' }, hint) : null);
}

async function download() {
  try {
    const data = await api.exportData();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = h('a', { href: URL.createObjectURL(blob), download: `budget-backup-${state.today}.json` });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function restore(file) {
  let data;
  try {
    data = JSON.parse(await file.text());
  } catch {
    toast('That file is not valid JSON', 'error');
    return;
  }
  const ok = await confirmDanger('Restore this backup?',
    'Everything currently in the app is replaced by the backup. Consider exporting first.', 'Replace my data');
  if (!ok) return;
  try {
    const result = await run(() => api.importData(data));
    toast(`Restored ${result.accounts} accounts and ${result.entries} items`, 'success');
  } catch { /* toast already shown */ }
}

export async function renderSettings(root) {
  const s = state.settings;
  const notify = await api.notifyStatus().catch(() => ({ channels: [], time: '' }));
  const currencies = CURRENCIES.includes(s.currency) ? CURRENCIES : [s.currency, ...CURRENCIES];
  const currency = h('select', { value: s.currency }, currencies.map((c) => h('option', { value: c }, c)));
  const weekStart = h('select', { value: s.week_start },
    h('option', { value: '0' }, 'Sunday'), h('option', { value: '1' }, 'Monday'));
  const horizon = h('input', { type: 'number', min: 7, max: 365, value: s.horizon_days, class: 'narrow' });
  const upcoming = h('input', { type: 'number', min: 1, max: 90, value: s.upcoming_days, class: 'narrow' });
  const fileInput = h('input', {
    type: 'file', accept: 'application/json,.json', hidden: true,
    onchange: (ev) => { if (ev.target.files[0]) restore(ev.target.files[0]); ev.target.value = ''; },
  });

  async function save(ev) {
    ev.preventDefault();
    try {
      await run(() => api.saveSettings({
        currency: currency.value,
        week_start: weekStart.value,
        horizon_days: Number(horizon.value),
        upcoming_days: Number(upcoming.value),
      }), 'Settings saved');
    } catch { /* toast already shown */ }
  }

  async function testNotify(ev) {
    const btn = ev.currentTarget;
    btn.disabled = true;
    try {
      const result = await api.notifyTest(state.today);
      const failed = Object.entries(result.results).filter(([, r]) => r !== 'ok');
      if (failed.length) toast(failed.map(([c, r]) => `${c}: ${r}`).join('; '), 'error');
      else toast('Test notification sent', 'success');
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      btn.disabled = false;
    }
  }

  root.replaceChildren(h('div', { class: 'page narrow-page' },
    h('div', { class: 'page-head' }, h('h1', null, 'Settings')),

    h('section', { class: 'panel' },
      h('h2', { class: 'panel-title' }, 'Preferences'),
      h('form', { class: 'form', onsubmit: save },
        h('div', { class: 'row' }, field('Currency', currency), field('Week starts on', weekStart)),
        h('div', { class: 'row' },
          field('Low balance look-ahead (days)', horizon, 'How far ahead to check for balances dropping below your minimums.'),
          field('"Coming up" window (days)', upcoming)),
        h('div', null, h('button', { class: 'btn primary', type: 'submit' }, 'Save')))),

    h('section', { class: 'panel' },
      h('h2', { class: 'panel-title' }, 'Notifications'),
      notify.channels.length
        ? [
          h('p', null, `A daily digest of anything that needs attention is sent at ${notify.time} via ${notify.channels.join(' and ')}. Nothing is sent on days when all is clear.`),
          h('button', { class: 'btn', type: 'button', onclick: testNotify }, 'Send a test now'),
        ]
        : [
          h('p', null, 'The "Needs attention" panel always shows what to do. To also get a daily heads-up on your phone or by email, set the ntfy or SMTP options in docker-compose.yml and restart the container. See the README for details.'),
        ]),

    h('section', { class: 'panel' },
      h('h2', { class: 'panel-title' }, 'Backup'),
      h('p', null, 'Your data lives in a SQLite database inside the Docker volume. Export a JSON backup now and then, and keep it somewhere safe.'),
      h('div', { class: 'button-row' },
        h('button', { class: 'btn', type: 'button', onclick: download }, 'Export backup'),
        h('button', { class: 'btn', type: 'button', onclick: () => fileInput.click() }, 'Restore from backup…'),
        fileInput))));
}
