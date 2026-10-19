import { api } from '../api.js';
import { openEntryForm } from '../forms.js';
import { accountName, state } from '../store.js';
import { KIND_LABEL, clear, describeSchedule, fmtDate, h, money, relativeDay } from '../util.js';

let kindFilter = 'all';
let search = '';
let showPast = false;

// Average monthly amount of a recurring entry (variable ones use their estimate).
function monthly(e) {
  const amt = e.variable ? e.estimate || 0 : e.amount || 0;
  const n = e.interval || 1;
  switch (e.frequency) {
    case 'day': return (amt * 365) / 12 / n;
    case 'week': return (amt * 52) / 12 / n;
    case 'month': return amt / n;
    case 'year': return amt / 12 / n;
    default: return 0;
  }
}

function amountCell(e) {
  if (!e.variable) return money(e.amount);
  return h('span', null, h('span', { class: 'tag warn' }, 'Varies'), e.estimate !== null ? ` ~${money(e.estimate)}` : '');
}

function row(e) {
  const accounts = e.kind === 'transfer'
    ? `${accountName(e.account_id)} → ${accountName(e.to_account_id)}`
    : accountName(e.account_id);
  return h('tr', { class: `kind-${e.kind}`, tabindex: 0, onclick: () => openEntryForm({ entry: e }),
    onkeydown: (ev) => { if (ev.key === 'Enter') openEntryForm({ entry: e }); } },
  h('td', null,
    h('div', { class: 'cell-name' }, h('span', { class: `kind-dot kind-${e.kind}`, title: KIND_LABEL[e.kind] }), e.name),
    e.category ? h('div', { class: 'muted-text small' }, e.category) : null),
  h('td', { class: `num ${e.kind === 'credit' ? 'pos' : ''}` }, amountCell(e)),
  h('td', null, describeSchedule(e)),
  h('td', null, accounts),
  h('td', null, e.next_date
    ? h('span', null, fmtDate(e.next_date), h('div', { class: 'muted-text small' }, relativeDay(e.next_date, state.today)))
    : h('span', { class: 'muted-text' }, 'Done')),
  h('td', null, e.autopay ? h('span', { class: 'tag' }, 'Autopay') : e.kind !== 'credit'
    ? h('span', { class: 'tag muted', title: `Reminder ${e.remind_days} days before` }, `Remind ${e.remind_days}d`) : null));
}

function table(entries) {
  return h('div', { class: 'table-wrap' }, h('table', { class: 'entries' },
    h('thead', null, h('tr', null,
      ['Name', 'Amount', 'Schedule', 'Account', 'Next', ''].map((t, i) => h('th', { class: i === 1 ? 'num' : '' }, t)))),
    h('tbody', null, entries.map(row))));
}

export async function renderEntries(root) {
  const all = await api.entries(state.today);
  const draw = () => {
    const q = search.trim().toLowerCase();
    const matches = all.filter((e) => (kindFilter === 'all' || e.kind === kindFilter)
      && (!q || e.name.toLowerCase().includes(q) || (e.category || '').toLowerCase().includes(q)));
    const byNext = (a, b) => (a.next_date || '9999').localeCompare(b.next_date || '9999') || a.name.localeCompare(b.name);
    const recurring = matches.filter((e) => e.frequency !== 'once').sort(byNext);
    const oneTime = matches.filter((e) => e.frequency === 'once');
    const upcoming = oneTime.filter((e) => e.start_date >= state.today).sort(byNext);
    const past = oneTime.filter((e) => e.start_date < state.today).sort((a, b) => b.start_date.localeCompare(a.start_date));

    const active = recurring.filter((e) => e.next_date);
    const income = active.filter((e) => e.kind === 'credit').reduce((s, e) => s + monthly(e), 0);
    const expenses = active.filter((e) => e.kind === 'debit').reduce((s, e) => s + monthly(e), 0);

    clear(content,
      recurring.length ? h('div', { class: 'month-summary' },
        h('div', { class: 'stat' }, h('span', { class: 'stat-label' }, 'Recurring income / month'), h('span', { class: 'stat-value pos' }, money(Math.round(income)))),
        h('div', { class: 'stat' }, h('span', { class: 'stat-label' }, 'Recurring expenses / month'), h('span', { class: 'stat-value' }, money(Math.round(expenses)))),
        h('div', { class: 'stat' }, h('span', { class: 'stat-label' }, 'Difference'), h('span', { class: `stat-value ${income - expenses < 0 ? 'neg' : 'pos'}` }, money(Math.round(income - expenses), { sign: true }))),
        h('div', { class: 'stat-note' }, 'Averaged per month; varying amounts use their estimate.')) : null,
      h('h2', { class: 'section-title' }, `Recurring (${recurring.length})`),
      recurring.length ? table(recurring) : h('p', { class: 'empty' }, 'No recurring items yet.'),
      h('h2', { class: 'section-title' }, `One-time, upcoming (${upcoming.length})`),
      upcoming.length ? table(upcoming) : h('p', { class: 'empty' }, 'No upcoming one-time items.'),
      past.length ? h('button', { class: 'btn subtle', type: 'button', onclick: () => { showPast = !showPast; draw(); } },
        showPast ? 'Hide past one-time items' : `Show past one-time items (${past.length})`) : null,
      showPast && past.length ? table(past) : null,
    );
  };

  const content = h('div');
  const kind = h('select', {
    value: kindFilter, 'aria-label': 'Type',
    onchange: (ev) => { kindFilter = ev.target.value; draw(); },
  }, h('option', { value: 'all' }, 'All types'), h('option', { value: 'debit' }, 'Expenses'),
  h('option', { value: 'credit' }, 'Income'), h('option', { value: 'transfer' }, 'Transfers'));
  const searchBox = h('input', {
    type: 'search', placeholder: 'Search…', value: search, 'aria-label': 'Search',
    oninput: (ev) => { search = ev.target.value; draw(); },
  });
  root.replaceChildren(h('div', { class: 'page' },
    h('div', { class: 'page-head' },
      h('div', null,
        h('h1', null, 'Bills & income'),
        h('p', { class: 'muted-text' }, 'Everything that moves money: paychecks, bills, credit card payments and transfers. Set the amount to "varies" for things like utilities and credit cards and you\'ll be asked for the real amount before each due date.')),
      h('button', { class: 'btn primary', type: 'button', onclick: () => openEntryForm() }, '+ Add')),
    h('div', { class: 'toolbar' }, kind, searchBox),
    content));
  draw();
}
