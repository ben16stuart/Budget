// "Needs attention", balances and "coming up" panels shown beside the calendar.
import { api } from '../api.js';
import { openEntryForm, openOccurrence } from '../forms.js';
import { toast } from '../modal.js';
import { accountName, run, state } from '../store.js';
import { DONE_LABEL, currencySymbol, fmtDate, h, money, occAmount, parseMoney, relativeDay, signedAmount } from '../util.js';

function dueLabel(item) {
  if (item.reasons.includes('overdue')) return [`Overdue · was due ${relativeDay(item.date, state.today)}`, 'danger'];
  if (item.reasons.includes('due_soon')) {
    const d = item.days_until;
    return [d === 0 ? 'Due today' : d === 1 ? 'Due tomorrow' : `Due in ${d} days`, item.severity];
  }
  return [`Amount needed · ${relativeDay(item.date, state.today)}`, item.severity];
}

function balanceAlertCard(a) {
  const s = a.suggestion;
  const triggers = a.triggers.length ? ` (${a.triggers.join(', ')})` : '';
  let advice;
  if (s && s.covers_shortfall) {
    advice = `Move ${money(s.amount)} from ${s.from_account_name} by ${fmtDate(s.by_date)}.`;
  } else if (s) {
    advice = `${s.from_account_name} can spare ${money(s.amount)}; you'd still be ${money(a.shortfall - s.amount)} short. Add money by ${fmtDate(a.by_date)}.`;
  } else {
    advice = `Add ${money(a.shortfall)} by ${fmtDate(a.by_date)} — no other account has money to spare.`;
  }
  return h('div', { class: `alert-card ${a.severity}` },
    h('div', { class: 'alert-top' },
      h('span', { class: `badge ${a.severity}` }, `Low balance · ${relativeDay(a.first_breach_date, state.today)}`)),
    h('div', { class: 'alert-title' }, `Move money into ${a.account_name}`),
    h('div', { class: 'alert-text' },
      `Projected to drop below ${money(a.min_balance)} on ${fmtDate(a.first_breach_date)}${triggers}, `,
      `reaching ${money(a.lowest_balance)} on ${fmtDate(a.lowest_date)}`,
      a.recovers_on ? ` until ${fmtDate(a.recovers_on)}.` : '.'),
    h('div', { class: 'alert-advice' }, advice),
    s ? h('div', { class: 'alert-actions' }, h('button', {
      class: 'btn small primary', type: 'button',
      onclick: () => openEntryForm({
        defaults: {
          kind: 'transfer', name: `Move to ${a.account_name}`, account_id: s.from_account_id,
          to_account_id: a.account_id, amount: s.amount, start_date: s.by_date, frequency: 'once', autopay: false,
        },
      }),
    }, 'Schedule this transfer…')) : null);
}

function actionCard(item) {
  const [label, severity] = dueLabel(item);
  const needsAmount = item.reasons.includes('needs_amount');
  const accounts = item.kind === 'transfer'
    ? `${accountName(item.account_id)} → ${accountName(item.to_account_id)}`
    : accountName(item.account_id);
  const input = needsAmount
    ? h('input', { type: 'text', inputmode: 'decimal', placeholder: item.amount ? `est. ${(item.amount / 100).toFixed(2)}` : '0.00', 'aria-label': 'Actual amount' })
    : null;

  async function save(extra) {
    const body = { ...extra };
    if (input) {
      const amt = parseMoney(input.value);
      if (amt === null && !extra.status) return toast('Enter the amount', 'error');
      if (amt !== null) body.amount = amt;
    }
    try {
      await run(() => api.patchOccurrence(item.entry_id, item.occ_date, body),
        extra.status ? `${item.name} marked ${DONE_LABEL[item.kind].toLowerCase()}` : 'Amount saved');
    } catch { /* toast already shown */ }
  }

  return h('div', { class: `alert-card ${severity}` },
    h('div', { class: 'alert-top' },
      h('span', { class: `badge ${severity}` }, label),
      needsAmount && item.reasons.length > 1 ? h('span', { class: 'badge warning' }, 'Amount needed') : null),
    h('button', { class: 'alert-title link', type: 'button', onclick: () => openOccurrence(item) }, item.name),
    h('div', { class: 'alert-text' },
      `${fmtDate(item.date)} · ${accounts} · `,
      h('strong', null, item.amount_known ? money(item.amount) : item.amount ? `~${money(item.amount)} est.` : 'amount not entered yet')),
    h('form', { class: 'alert-actions', onsubmit: (ev) => { ev.preventDefault(); save({}); } },
      input ? h('div', { class: 'money-input small' }, h('span', { class: 'cur' }, currencySymbol()), input) : null,
      input ? h('button', { class: 'btn small', type: 'submit' }, 'Save') : null,
      item.payable ? h('button', {
        class: 'btn small good', type: 'button', onclick: () => save({ status: 'paid' }),
      }, `Mark ${DONE_LABEL[item.kind].toLowerCase()}`) : null));
}

export function attentionPanel() {
  const { action_items: items, balance_alerts: lows } = state.alerts;
  const count = items.length + lows.length;
  return h('section', { class: 'panel attention' },
    h('h2', { class: 'panel-title' }, 'Needs attention', count ? h('span', { class: 'count' }, count) : null),
    count
      ? h('div', { class: 'alert-list' }, lows.map(balanceAlertCard), items.map(actionCard))
      : h('div', { class: 'all-clear' }, h('span', { class: 'check-big' }, '✓'),
        h('div', null, h('strong', null, 'All clear'),
          h('div', null, `No bills due soon, no amounts to fill in, and balances stay above your minimums for the next ${state.settings.horizon_days} days.`))));
}

export function balancesPanel() {
  if (!state.accounts.length) return null;
  let total = 0;
  const rows = state.accounts.map((a) => {
    const bal = a.balance_today;
    if (bal !== null) total += bal;
    const low = a.min_balance !== null && bal !== null && bal < a.min_balance;
    const dip = a.lowest_balance !== null && bal !== null && a.lowest_balance < bal;
    return h('a', { class: 'bal-row', href: '#/accounts' },
      h('span', { class: 'bal-name' }, h('span', { class: 'dot', style: { background: a.color || 'var(--muted)' } }), a.name),
      h('span', { class: 'bal-values' },
        h('span', { class: `${bal < 0 ? 'neg' : ''} ${low ? 'low' : ''}` }, bal === null ? 'not started' : money(bal)),
        dip ? h('span', { class: `bal-low ${a.min_balance !== null && a.lowest_balance < a.min_balance ? 'neg' : ''}` },
          `low ${money(a.lowest_balance)} ${fmtDate(a.lowest_date, { month: 'short', day: 'numeric' })}`) : null));
  });
  return h('section', { class: 'panel' },
    h('h2', { class: 'panel-title' }, 'Balances today'),
    h('div', { class: 'bal-list' }, rows,
      state.accounts.length > 1 ? h('div', { class: 'bal-row total' }, h('span', null, 'Total'),
        h('span', { class: total < 0 ? 'neg' : '' }, money(total))) : null));
}

export function upcomingPanel() {
  const items = state.alerts.upcoming;
  const days = state.settings.upcoming_days;
  let lastDate = null;
  const rows = [];
  for (const o of items) {
    if (o.date !== lastDate) {
      lastDate = o.date;
      const rel = relativeDay(o.date, state.today);
      rows.push(h('div', { class: 'up-date' }, `${fmtDate(o.date)}${rel === 'today' || rel === 'tomorrow' ? ` · ${rel}` : ''}`));
    }
    const amt = signedAmount(o, null);
    rows.push(h('button', { class: `up-row status-${o.status}`, type: 'button', onclick: () => openOccurrence(o) },
      h('span', { class: 'dot', style: { background: (state.accounts.find((a) => a.id === o.account_id) || {}).color || 'var(--muted)' } }),
      h('span', { class: 'up-name' }, o.status === 'paid' ? '✓ ' : '', o.name),
      h('span', { class: `up-amt ${amt > 0 ? 'pos' : ''}` },
        o.kind === 'transfer' ? `⇄ ${occAmount(o)}` : occAmount(o, amt, (v) => money(v, { sign: true })))));
  }
  return h('section', { class: 'panel' },
    h('h2', { class: 'panel-title' }, `Coming up · next ${days} days`),
    rows.length ? h('div', { class: 'up-list' }, rows) : h('p', { class: 'empty' }, 'Nothing scheduled.'));
}
