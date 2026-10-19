// DOM, money and date helpers. Dates are ISO strings ("2026-10-19") throughout;
// arithmetic is done in UTC so DST never shifts a day.

export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  let value_;
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'value') value_ = value; // set after children so <select> options exist
    else if (key === 'class') el.className = value;
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else if (key === 'style' && typeof value === 'object') Object.assign(el.style, value);
    else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2), value);
    else if (key in el && typeof value !== 'string') el[key] = value;
    else el.setAttribute(key, value === true ? '' : value);
  }
  append(el, children);
  if (value_ !== undefined) el.value = value_;
  return el;
}

function append(el, children) {
  for (const child of children.flat(Infinity)) {
    if (child === undefined || child === null || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

export function clear(el, ...children) {
  el.replaceChildren();
  append(el, children);
  return el;
}

// ---------------------------------------------------------------- money

let currency = 'USD';
let formatter = new Intl.NumberFormat(undefined, { style: 'currency', currency });

export function setCurrency(code) {
  currency = code || 'USD';
  formatter = new Intl.NumberFormat(undefined, { style: 'currency', currency });
}

export function currencySymbol() {
  const part = formatter.formatToParts(0).find((p) => p.type === 'currency');
  return part ? part.value : '$';
}

export function money(cents, { sign = false } = {}) {
  if (cents === null || cents === undefined) return '—';
  const text = formatter.format(Math.abs(cents) / 100);
  if (cents < 0) return '−' + text;
  return sign && cents > 0 ? '+' + text : text;
}

// Compact form for calendar cells: no cents for whole amounts.
export function moneyShort(cents) {
  const whole = cents % 100 === 0;
  const f = new Intl.NumberFormat(undefined, {
    style: 'currency', currency,
    minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: whole ? 0 : 2,
  });
  return (cents < 0 ? '−' : '') + f.format(Math.abs(cents) / 100);
}

// Amount text for an occurrence, marking estimates; unknown with no estimate shows "?".
export function occAmount(o, value = o.amount, fmt = money) {
  if (o.amount_known) return fmt(value);
  return o.amount ? `~${fmt(value)}` : '?';
}

// Very short form for phone-sized calendar cells, e.g. "$10.1K".
export function moneyCompact(cents) {
  const f = new Intl.NumberFormat(undefined, {
    style: 'currency', currency, notation: 'compact', maximumFractionDigits: Math.abs(cents) < 100000 ? 0 : 1,
  });
  return (cents < 0 ? '−' : '') + f.format(Math.abs(cents) / 100);
}

export function parseMoney(text) {
  const cleaned = String(text ?? '').replace(/[^0-9.\-]/g, '');
  if (cleaned === '' || cleaned === '-' || cleaned === '.') return null;
  const value = Number(cleaned);
  return Number.isFinite(value) ? Math.round(value * 100) : null;
}

export function centsToInput(cents) {
  return cents === null || cents === undefined ? '' : (cents / 100).toFixed(2);
}

// ---------------------------------------------------------------- dates

const pad = (n) => String(n).padStart(2, '0');

export function iso(y, m, d) {
  return `${y}-${pad(m)}-${pad(d)}`;
}

export function todayISO() {
  const d = new Date();
  return iso(d.getFullYear(), d.getMonth() + 1, d.getDate());
}

function toUTC(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function fromUTC(date) {
  return iso(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
}

export function addDays(s, n) {
  const d = toUTC(s);
  d.setUTCDate(d.getUTCDate() + n);
  return fromUTC(d);
}

export function daysBetween(a, b) {
  return Math.round((toUTC(b) - toUTC(a)) / 86400000);
}

export function weekday(s) {
  return toUTC(s).getUTCDay();
}

export function monthStart(ym) {
  return `${ym}-01`;
}

export function monthEnd(ym) {
  const [y, m] = ym.split('-').map(Number);
  return fromUTC(new Date(Date.UTC(y, m, 0)));
}

export function addMonths(ym, n) {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}`;
}

export function fmtDate(s, opts = { weekday: 'short', month: 'short', day: 'numeric' }) {
  if (!s) return '';
  return toUTC(s).toLocaleDateString(undefined, { ...opts, timeZone: 'UTC' });
}

export function fmtMonth(ym) {
  return toUTC(`${ym}-01`).toLocaleDateString(undefined, { month: 'long', year: 'numeric', timeZone: 'UTC' });
}

export function weekdayNames(weekStart) {
  const names = [];
  for (let i = 0; i < 7; i++) {
    // 2023-01-01 was a Sunday.
    names.push(toUTC(iso(2023, 1, 1 + ((i + weekStart) % 7)))
      .toLocaleDateString(undefined, { weekday: 'short', timeZone: 'UTC' }));
  }
  return names;
}

export function relativeDay(s, today) {
  const n = daysBetween(today, s);
  if (n === 0) return 'today';
  if (n === 1) return 'tomorrow';
  if (n === -1) return 'yesterday';
  if (n < 0) return `${-n} days ago`;
  return `in ${n} days`;
}

function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

export function describeSchedule(e) {
  const day = Number(e.start_date.slice(8));
  const n = e.interval || 1;
  let text;
  switch (e.frequency) {
    case 'once': return `Once, ${fmtDate(e.start_date, { month: 'short', day: 'numeric', year: 'numeric' })}`;
    case 'day': text = n === 1 ? 'Daily' : `Every ${n} days`; break;
    case 'week': {
      const wd = fmtDate(e.start_date, { weekday: 'long' });
      text = n === 1 ? `Weekly on ${wd}` : n === 2 ? `Every 2 weeks on ${wd}` : `Every ${n} weeks on ${wd}`;
      break;
    }
    case 'month':
      text = n === 1 ? `Monthly on the ${ordinal(day)}` : `Every ${n} months on the ${ordinal(day)}`;
      break;
    case 'year': {
      const md = fmtDate(e.start_date, { month: 'short', day: 'numeric' });
      text = n === 1 ? `Yearly on ${md}` : `Every ${n} years on ${md}`;
      break;
    }
    default: text = e.frequency;
  }
  if (e.end_date) text += `, until ${fmtDate(e.end_date, { month: 'short', day: 'numeric', year: 'numeric' })}`;
  return text;
}

export const KIND_LABEL = { credit: 'Income', debit: 'Expense', transfer: 'Transfer' };
export const DONE_LABEL = { credit: 'Received', debit: 'Paid', transfer: 'Done' };
export const ACCOUNT_TYPES = {
  checking: 'Checking', savings: 'Savings', credit_card: 'Credit card',
  cash: 'Cash', investment: 'Investment', other: 'Other',
};
export const ACCOUNT_COLORS = ['#2563eb', '#16a34a', '#9333ea', '#ea580c', '#0891b2', '#db2777', '#ca8a04', '#64748b'];

export function occKey(o) {
  return `${o.entry_id}|${o.occ_date}`;
}

// Signed effect of an occurrence on one account (or on the total when accountId is null).
export function signedAmount(o, accountId) {
  if (o.kind === 'credit') return o.amount;
  if (o.kind === 'debit') return -o.amount;
  if (accountId === null) return 0;
  return o.to_account_id === accountId ? o.amount : -o.amount;
}
