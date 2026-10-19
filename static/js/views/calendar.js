import { api } from '../api.js';
import { openDay, openOccurrence } from '../forms.js';
import { account, state } from '../store.js';
import {
  addDays, addMonths, daysBetween, fmtMonth, h, money, moneyCompact, moneyShort, monthEnd, monthStart, occAmount, occKey,
  signedAmount, weekday, weekdayNames,
} from '../util.js';
import { attentionPanel, balancesPanel, upcomingPanel } from './sidebar.js';

const MAX_CHIPS = 4;

function chip(o, accountId, alert) {
  const amt = signedAmount(o, accountId);
  const transferAll = o.kind === 'transfer' && accountId === null;
  const value = transferAll ? o.amount : amt;
  const acct = account(o.account_id);
  const icon = o.status === 'paid' ? '✓'
    : alert && alert.reasons.includes('overdue') ? '!'
      : o.variable && !o.amount_known ? '?'
        : transferAll ? '⇄' : '';
  const classes = [
    'chip', `kind-${o.kind}`, `status-${o.status}`,
    transferAll ? '' : value > 0 ? 'in' : 'out',
    o.amount_known ? '' : 'est',
    alert ? `alert-${alert.severity}` : '',
  ].filter(Boolean).join(' ');
  const amountText = occAmount(o, Math.abs(value), moneyShort);
  const compactText = occAmount(o, Math.abs(value), moneyCompact);
  const plus = value > 0 && !transferAll && amountText !== '?' ? '+' : '';
  return h('button', {
    class: classes,
    type: 'button',
    style: { '--acct': (acct && acct.color) || 'var(--muted)' },
    title: `${o.name}: ${o.amount_known ? money(o.amount) : o.amount ? `about ${money(o.amount)}` : 'amount needed'}${o.status !== 'scheduled' ? ` (${o.status})` : ''}`,
    onclick: (ev) => { ev.stopPropagation(); openOccurrence(o); },
  },
  icon ? h('span', { class: 'chip-icon' }, icon) : null,
  h('span', { class: 'chip-name' }, o.name),
  h('span', { class: 'chip-amt' }, h('span', { class: 'full' }, plus + amountText), h('span', { class: 'compact' }, plus + compactText)));
}

function monthSummary(occs, balances, endDate, accountId) {
  let income = 0;
  let spending = 0;
  let estimated = 0;
  for (const o of occs) {
    if (o.status === 'skipped') continue;
    const amt = signedAmount(o, accountId);
    if (amt > 0) income += amt;
    else spending -= amt;
    if (!o.amount_known) estimated += o.amount;
  }
  const end = balances[endDate] || {};
  const ids = accountId === null ? state.accounts.map((a) => a.id) : [accountId];
  const known = ids.map((id) => end[id]).filter((b) => b !== null && b !== undefined);
  const endBalance = known.length ? known.reduce((s, b) => s + b, 0) : null;
  const stat = (label, value, cls = '') => h('div', { class: 'stat' },
    h('span', { class: 'stat-label' }, label), h('span', { class: `stat-value ${cls}` }, value));
  return h('div', { class: 'month-summary' },
    stat(accountId === null ? 'Income' : 'Money in', money(income), 'pos'),
    stat(accountId === null ? 'Expenses' : 'Money out', money(spending)),
    stat('Net', money(income - spending, { sign: true }), income - spending < 0 ? 'neg' : 'pos'),
    stat('Projected end of month', money(endBalance), endBalance !== null && endBalance < 0 ? 'neg' : ''),
    estimated ? h('div', { class: 'stat-note' }, `Includes ~${money(estimated)} of estimated amounts`) : null);
}

export async function renderCalendar(root, param) {
  if (param && /^\d{4}-\d{2}$/.test(param)) state.month = param;
  const ym = state.month;
  const weekStart = Number(state.settings.week_start) || 0;
  const first = monthStart(ym);
  const last = monthEnd(ym);
  const gridStart = addDays(first, -((weekday(first) - weekStart + 7) % 7));
  const weeks = Math.ceil((daysBetween(gridStart, last) + 1) / 7);
  const gridEnd = addDays(gridStart, weeks * 7 - 1);
  const data = await api.calendar(gridStart, gridEnd);

  if (state.filter !== 'all' && !account(Number(state.filter))) state.filter = 'all';
  const accountId = state.filter === 'all' ? null : Number(state.filter);
  const visible = data.occurrences.filter((o) => accountId === null
    || o.account_id === accountId || o.to_account_id === accountId);
  const byDate = {};
  for (const o of visible) (byDate[o.date] ||= []).push(o);
  const alerts = new Map(state.alerts.action_items.map((i) => [occKey(i), i]));

  const go = (ym2) => { location.hash = `#/calendar/${ym2}`; };
  const filter = h('select', {
    class: 'filter', value: String(state.filter), 'aria-label': 'Account',
    onchange: (ev) => { state.filter = ev.target.value; renderCalendar(root); },
  }, h('option', { value: 'all' }, 'All accounts'),
  state.accounts.map((a) => h('option', { value: String(a.id) }, a.name)));

  const cells = [];
  for (let i = 0; i < weeks * 7; i++) {
    const date = addDays(gridStart, i);
    const occs = byDate[date] || [];
    const bals = data.balances[date] || {};
    let balance = null;
    let low = false;
    for (const a of state.accounts) {
      if (accountId !== null && a.id !== accountId) continue;
      const b = bals[a.id];
      if (b === null || b === undefined) continue;
      balance = (balance ?? 0) + b;
      if (a.min_balance !== null && b < a.min_balance) low = true;
    }
    const classes = ['day'];
    if (date.slice(0, 7) !== ym) classes.push('other-month');
    if (date === state.today) classes.push('today');
    if (date < state.today) classes.push('past');
    const lowAhead = low && date >= state.today;
    if (lowAhead) classes.push('low');
    const shown = occs.length > MAX_CHIPS ? occs.slice(0, MAX_CHIPS - 1) : occs;
    cells.push(h('div', {
      class: classes.join(' '),
      role: 'button',
      tabindex: 0,
      'aria-label': date,
      onclick: () => openDay(date, occs, bals, accountId),
      onkeydown: (ev) => { if (ev.key === 'Enter') openDay(date, occs, bals, accountId); },
    },
    h('div', { class: 'day-head' },
      h('span', { class: 'day-num' }, Number(date.slice(8))),
      occs.length ? h('span', { class: 'day-count' }, occs.length) : null),
    h('div', { class: 'day-items' }, shown.map((o) => chip(o, accountId, alerts.get(occKey(o)))),
      occs.length > shown.length ? h('div', { class: 'more' }, `+${occs.length - shown.length} more`) : null),
    h('div', { class: `day-bal${balance !== null && balance < 0 ? ' neg' : ''}`, title: accountId === null ? 'Projected total across accounts at end of day' : 'Projected balance at end of day' },
      lowAhead ? '⚠ ' : '',
      balance === null ? '' : [h('span', { class: 'full' }, moneyShort(balance)), h('span', { class: 'compact' }, moneyCompact(balance))])));
  }

  const monthOccs = visible.filter((o) => o.date >= first && o.date <= last);
  const main = h('section', { class: 'cal' },
    h('div', { class: 'cal-toolbar' },
      h('div', { class: 'cal-nav' },
        h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Previous month', onclick: () => go(addMonths(ym, -1)) }, '‹'),
        h('h1', { class: 'cal-title' }, fmtMonth(ym)),
        h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Next month', onclick: () => go(addMonths(ym, 1)) }, '›')),
      h('div', { class: 'cal-tools' },
        ym !== state.today.slice(0, 7) ? h('button', { class: 'btn small', type: 'button', onclick: () => go(state.today.slice(0, 7)) }, 'This month') : null,
        filter)),
    monthSummary(monthOccs, data.balances, last, accountId),
    h('div', { class: 'cal-grid', role: 'grid' },
      weekdayNames(weekStart).map((n) => h('div', { class: 'dow' }, n)),
      cells),
    h('p', { class: 'legend' },
      h('span', null, h('b', { class: 'pos' }, '+'), ' income'),
      h('span', null, '? amount needed'),
      h('span', null, '~ estimated'),
      h('span', null, '✓ paid'),
      h('span', null, '⇄ transfer'),
      h('span', null, '⚠ below minimum')));

  const empty = !state.accounts.length
    ? h('section', { class: 'panel onboarding' },
      h('h2', { class: 'panel-title' }, 'Welcome!'),
      h('p', null, 'Start by adding your bank accounts and their current balances. Then add your paychecks, bills and credit card payments, one-time or recurring.'),
      h('a', { class: 'btn primary', href: '#/accounts' }, 'Add your first account'))
    : null;

  // Separate grid areas so "Needs attention" sits above the calendar on phones.
  root.replaceChildren(h('div', { class: 'layout' },
    h('div', { class: 'area-main' }, main),
    h('div', { class: 'area-attn' }, empty || attentionPanel()),
    h('aside', { class: 'area-side' }, balancesPanel(), upcomingPanel())));
}
