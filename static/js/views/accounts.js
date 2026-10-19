import { openAccountForm, openBalanceUpdate } from '../forms.js';
import { state } from '../store.js';
import { ACCOUNT_TYPES, fmtDate, h, money } from '../util.js';

function card(a) {
  const bal = a.balance_today;
  const low = a.min_balance !== null && a.lowest_balance !== null && a.lowest_balance < a.min_balance;
  return h('article', { class: 'acct-card', style: { '--acct': a.color || 'var(--muted)' } },
    h('div', { class: 'acct-head' },
      h('div', null, h('h2', null, a.name), h('span', { class: 'muted-text' }, ACCOUNT_TYPES[a.type] || a.type)),
      h('button', { class: 'btn small', type: 'button', onclick: () => openAccountForm(a) }, 'Edit')),
    h('div', { class: `acct-balance ${bal !== null && bal < 0 ? 'neg' : ''}` },
      bal === null ? '—' : money(bal)),
    h('div', { class: 'muted-text' }, bal === null
      ? `Tracking starts ${fmtDate(a.opening_date)}`
      : 'Projected balance today'),
    h('dl', { class: 'acct-facts' },
      a.lowest_balance !== null ? [
        h('dt', null, `Lowest in next ${state.settings.horizon_days} days`),
        h('dd', { class: low ? 'neg' : '' }, `${money(a.lowest_balance)} on ${fmtDate(a.lowest_date)}`, low ? ' ⚠' : ''),
      ] : null,
      h('dt', null, 'Low balance warning'),
      h('dd', null, a.min_balance === null ? 'Off' : `Below ${money(a.min_balance)}`),
      h('dt', null, 'Balance set'),
      h('dd', null, `${money(a.opening_balance)} at start of ${fmtDate(a.opening_date, { month: 'short', day: 'numeric', year: 'numeric' })}`),
      a.notes ? [h('dt', null, 'Notes'), h('dd', null, a.notes)] : null),
    h('div', { class: 'acct-actions' },
      h('button', { class: 'btn small', type: 'button', onclick: () => openBalanceUpdate(a) }, 'Update balance'),
      h('a', {
        class: 'btn small subtle', href: '#/calendar',
        onclick: () => { state.filter = String(a.id); },
      }, 'View on calendar')));
}

export async function renderAccounts(root) {
  root.replaceChildren(h('div', { class: 'page' },
    h('div', { class: 'page-head' },
      h('div', null,
        h('h1', null, 'Accounts'),
        h('p', { class: 'muted-text' }, 'Track as many accounts as you like. Nothing connects to your bank: set a balance, and the app projects it forward from your bills, income and transfers. Update the balance whenever you check your bank.')),
      h('button', { class: 'btn primary', type: 'button', onclick: () => openAccountForm() }, '+ Add account')),
    state.accounts.length
      ? h('div', { class: 'acct-grid' }, state.accounts.map(card))
      : h('div', { class: 'panel empty-state' },
        h('h2', null, 'No accounts yet'),
        h('p', null, 'Add your checking, savings and credit card accounts to get started.'),
        h('button', { class: 'btn primary', type: 'button', onclick: () => openAccountForm() }, 'Add your first account'))));
}
