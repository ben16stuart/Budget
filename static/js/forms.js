import { api } from './api.js';
import { choose, confirmDanger, openModal, toast } from './modal.js';
import { account, accountName, run, state } from './store.js';
import {
  ACCOUNT_COLORS, ACCOUNT_TYPES, DONE_LABEL, KIND_LABEL, addDays, centsToInput, currencySymbol, describeSchedule, fmtDate,
  h, money, occAmount, parseMoney, relativeDay, signedAmount,
} from './util.js';

// ----------------------------------------------------------------- building blocks

function field(label, control, hint) {
  return h('label', { class: 'field' },
    h('span', { class: 'field-label' }, label),
    control,
    hint ? h('span', { class: 'hint' }, hint) : null);
}

function moneyInput(attrs = {}) {
  const input = h('input', { type: 'text', inputmode: 'decimal', autocomplete: 'off', ...attrs });
  const wrap = h('div', { class: 'money-input' }, h('span', { class: 'cur' }, currencySymbol()), input);
  return { input, wrap };
}

function accountSelect(value, exclude) {
  return h('select', { value: String(value ?? '') },
    state.accounts
      .filter((a) => a.id !== exclude)
      .map((a) => h('option', { value: String(a.id) }, a.name)));
}

function segmented(name, options, value, onchange) {
  return h('div', { class: 'segmented', role: 'radiogroup' },
    options.map(([val, label]) => h('label', null,
      h('input', { type: 'radio', name, value: val, checked: val === value, onchange }),
      h('span', null, label))));
}

function radioValue(root, name) {
  const el = root.querySelector(`input[name="${name}"]:checked`);
  return el ? el.value : null;
}

const show = (el, visible) => { el.hidden = !visible; };

function occAccounts(o) {
  return o.kind === 'transfer'
    ? `${accountName(o.account_id)} → ${accountName(o.to_account_id)}`
    : accountName(o.account_id);
}

// ------------------------------------------------------------------- entry form

const REPEATS = [
  ['once', 'Does not repeat', 'once', 1],
  ['week-1', 'Every week', 'week', 1],
  ['week-2', 'Every 2 weeks', 'week', 2],
  ['month-1', 'Every month', 'month', 1],
  ['month-3', 'Every 3 months', 'month', 3],
  ['month-6', 'Every 6 months', 'month', 6],
  ['year-1', 'Every year', 'year', 1],
  ['custom', 'Custom…'],
];

const ENTRY_FIELDS = [
  'name', 'kind', 'account_id', 'to_account_id', 'amount', 'variable', 'estimate', 'frequency', 'interval',
  'start_date', 'end_date', 'autopay', 'remind_days', 'category', 'notes',
];

function entryBody(e) {
  const body = {};
  for (const k of ENTRY_FIELDS) body[k] = e[k];
  body.variable = Boolean(e.variable);
  body.autopay = Boolean(e.autopay);
  return body;
}

let categoryCache = null;

async function categories() {
  if (!categoryCache) {
    const entries = await api.entries(state.today).catch(() => []);
    categoryCache = [...new Set(entries.map((e) => e.category).filter(Boolean))].sort();
  }
  return categoryCache;
}

// Opens the add/edit form. `occurrence` is set when editing from a calendar
// occurrence, which enables "this and future occurrences" edits.
export function openEntryForm({ entry = null, occurrence = null, defaults = {}, onDone } = {}) {
  if (!state.accounts.length) {
    toast('Add a bank account first', 'error');
    location.hash = '#/accounts';
    return;
  }
  const editing = Boolean(entry);
  const filterAccount = state.filter !== 'all' ? Number(state.filter) : null;
  const e = entry ? entryBody(entry) : {
    kind: 'debit', name: '', account_id: filterAccount || state.accounts[0].id, to_account_id: null,
    amount: null, variable: false, estimate: null, frequency: 'month', interval: 1, start_date: state.today,
    end_date: null, autopay: false, remind_days: 5, category: '', notes: '', ...defaults,
  };
  categoryCache = null;

  const name = h('input', { type: 'text', value: e.name || '', maxlength: 100, required: true, autofocus: true });
  const acct = accountSelect(e.account_id);
  const firstOther = state.accounts.find((a) => a.id !== e.account_id);
  const toAcct = accountSelect(e.to_account_id || (firstOther && firstOther.id));
  const acctLabel = h('span', { class: 'field-label' });
  const amount = moneyInput({ value: centsToInput(e.amount), placeholder: '0.00' });
  const estimate = moneyInput({ value: centsToInput(e.estimate), placeholder: 'Optional' });
  const start = h('input', { type: 'date', value: e.start_date, required: true });
  const startLabel = h('span', { class: 'field-label' });

  const presetKey = e.frequency === 'once' ? 'once'
    : (REPEATS.find((r) => r[2] === e.frequency && r[3] === e.interval) || ['custom'])[0];
  const repeat = h('select', { value: presetKey }, REPEATS.map(([v, label]) => h('option', { value: v }, label)));
  const interval = h('input', { type: 'number', min: 1, max: 366, value: e.interval || 1, class: 'narrow' });
  const unit = h('select', { value: e.frequency === 'once' ? 'month' : e.frequency },
    h('option', { value: 'day' }, 'day(s)'), h('option', { value: 'week' }, 'week(s)'),
    h('option', { value: 'month' }, 'month(s)'), h('option', { value: 'year' }, 'year(s)'));
  const customRow = h('div', { class: 'inline-fields' }, h('span', null, 'Every'), interval, unit);
  const ends = h('select', { value: e.end_date ? 'on' : 'never' },
    h('option', { value: 'never' }, 'Never'), h('option', { value: 'on' }, 'On date'));
  const endDate = h('input', { type: 'date', value: e.end_date || '' });
  const autopay = h('input', { type: 'checkbox', checked: Boolean(e.autopay) });
  const remind = h('input', { type: 'number', min: 0, max: 60, value: e.remind_days ?? 5, class: 'narrow' });
  const categoryList = h('datalist', { id: 'category-list' });
  const category = h('input', { type: 'text', value: e.category || '', list: 'category-list', maxlength: 50 });
  const notes = h('textarea', { rows: 2, maxlength: 2000 }, e.notes || '');
  categories().then((cats) => cats.forEach((c) => categoryList.append(h('option', { value: c }))));

  const kindControl = segmented('kind', [['debit', 'Expense'], ['credit', 'Income'], ['transfer', 'Transfer']], e.kind, sync);
  const amountType = segmented('amount-type', [['fixed', 'Fixed amount'], ['variable', 'Varies each time']],
    e.variable ? 'variable' : 'fixed', sync);

  const canSplit = editing && occurrence && e.frequency !== 'once' && occurrence.occ_date > e.start_date;
  const scope = canSplit ? segmented('scope', [['future', 'This & future'], ['all', 'All occurrences']], 'future', () => {
    start.value = scopeValue() === 'future' ? occurrence.occ_date : e.start_date;
  }) : null;
  const scopeValue = () => (scope ? radioValue(scope, 'scope') : 'all');
  if (canSplit) start.value = occurrence.occ_date;

  const toField = field('To account', toAcct);
  const amountField = field('Amount', amount.wrap);
  const estimateField = field('Estimate', estimate.wrap,
    "Used for projections until you enter the real amount. You'll be reminded to fill it in before it's due.");
  const customField = h('div', { class: 'field' }, customRow);
  const endsField = h('div', { class: 'field' },
    h('span', { class: 'field-label' }, 'Ends'), h('div', { class: 'inline-fields' }, ends, endDate));
  const autopayField = h('label', { class: 'check' }, autopay,
    h('span', null, h('strong', null, 'Autopay'), ' — paid automatically, so no reminders to pay it'));
  const remindField = h('div', { class: 'field' },
    h('span', { class: 'field-label' }, 'Remind me'),
    h('div', { class: 'inline-fields' }, remind, h('span', { class: 'remind-text' }, 'days before it’s due')));

  function sync() {
    const kind = radioValue(form, 'kind');
    const variable = radioValue(form, 'amount-type') === 'variable';
    const repeating = repeat.value !== 'once';
    acctLabel.textContent = { debit: 'Paid from', credit: 'Deposited to', transfer: 'From account' }[kind];
    name.placeholder = { debit: 'e.g. Electric bill', credit: 'e.g. Paycheck', transfer: 'e.g. Credit card payment' }[kind];
    startLabel.textContent = repeating ? (canSplit && scopeValue() === 'future' ? 'Starting' : 'First date') : 'Date';
    show(toField, kind === 'transfer');
    show(amountField, !variable);
    show(estimateField, variable);
    show(customField, repeat.value === 'custom');
    show(endsField, repeating);
    endDate.hidden = ends.value !== 'on';
    show(autopayField, kind !== 'credit');
    const remindRelevant = variable || (kind !== 'credit' && !autopay.checked);
    show(remindField, remindRelevant);
  }

  const form = h('form', { class: 'form', novalidate: true, onsubmit: (ev) => { ev.preventDefault(); save(); } },
    scope ? h('div', { class: 'field scope-field' }, h('span', { class: 'field-label' }, 'Apply changes to'), scope) : null,
    kindControl,
    field('Name', name),
    h('div', { class: 'row' }, h('label', { class: 'field' }, acctLabel, acct), toField),
    h('div', { class: 'field' }, amountType),
    h('div', { class: 'row' }, amountField, estimateField),
    h('div', { class: 'row' }, h('label', { class: 'field' }, startLabel, start), field('Repeats', repeat)),
    customField,
    endsField,
    autopayField,
    remindField,
    h('div', { class: 'row' }, field('Category', category), h('span')),
    categoryList,
    field('Notes', notes),
    h('button', { type: 'submit', hidden: true }),
  );
  [repeat, ends, autopay].forEach((el) => el.addEventListener('change', sync));
  acct.addEventListener('change', () => {
    if (toAcct.value === acct.value) {
      const other = state.accounts.find((a) => String(a.id) !== acct.value);
      if (other) toAcct.value = String(other.id);
    }
  });

  async function save() {
    const kind = radioValue(form, 'kind');
    const variable = radioValue(form, 'amount-type') === 'variable';
    let frequency = 'once';
    let every = 1;
    if (repeat.value === 'custom') {
      frequency = unit.value;
      every = Math.max(1, Number(interval.value) || 1);
    } else if (repeat.value !== 'once') {
      const preset = REPEATS.find((r) => r[0] === repeat.value);
      frequency = preset[2];
      every = preset[3];
    }
    const body = {
      name: name.value.trim(),
      kind,
      account_id: Number(acct.value),
      to_account_id: kind === 'transfer' ? Number(toAcct.value) : null,
      variable,
      amount: variable ? null : parseMoney(amount.input.value),
      estimate: variable ? parseMoney(estimate.input.value) : null,
      frequency,
      interval: every,
      start_date: start.value,
      end_date: frequency !== 'once' && ends.value === 'on' ? endDate.value || null : null,
      autopay: kind !== 'credit' && autopay.checked,
      remind_days: Math.max(0, Math.min(60, Number(remind.value) || 0)),
      category: category.value.trim() || null,
      notes: notes.value.trim() || null,
    };
    if (!body.name) return toast('Give it a name', 'error');
    if (!body.start_date) return toast('Pick a date', 'error');
    if (!variable && body.amount === null) return toast('Enter an amount, or choose "Varies each time"', 'error');
    if (body.amount !== null && body.amount < 0) return toast('Enter the amount as a positive number', 'error');
    if (kind === 'transfer' && body.account_id === body.to_account_id) return toast('Pick two different accounts', 'error');
    if (editing && scopeValue() === 'future') body.effective_from = occurrence.occ_date;
    try {
      if (editing) await run(() => api.updateEntry(entry.id, body), 'Saved');
      else await run(() => api.createEntry(body, state.today), `Added “${body.name}”`);
      modal.close();
      if (onDone) onDone();
    } catch { /* toast already shown */ }
  }

  async function remove() {
    const recurring = e.frequency !== 'once';
    const canStop = recurring && occurrence && occurrence.occ_date > e.start_date;
    const choice = await choose({
      title: `Delete “${e.name}”?`,
      message: canStop
        ? `Stop it from ${fmtDate(occurrence.occ_date)} on (earlier ones stay in your history), or delete every occurrence?`
        : recurring ? 'This deletes every occurrence, past and future.' : 'This removes it from your calendar.',
      buttons: [
        ...(canStop ? [{ label: `Stop from ${fmtDate(occurrence.occ_date)}`, value: 'stop', class: 'danger' }] : []),
        { label: recurring ? 'Delete all' : 'Delete', value: 'all', class: 'danger' },
      ],
    });
    if (!choice) return;
    try {
      if (choice === 'all') await run(() => api.deleteEntry(entry.id), 'Deleted');
      else await run(() => api.updateEntry(entry.id, { ...e, end_date: addDays(occurrence.occ_date, -1) }), 'Stopped');
      modal.close();
      if (onDone) onDone();
    } catch { /* toast already shown */ }
  }

  const modal = openModal({
    title: editing ? `Edit ${e.frequency === 'once' ? '' : 'recurring '}${KIND_LABEL[e.kind].toLowerCase()}` : 'Add bill, income or transfer',
    subtitle: editing ? describeSchedule(e) : null,
    body: form,
    footer: [
      editing ? h('button', { class: 'btn danger-text', type: 'button', onclick: remove }, 'Delete…') : null,
      h('span', { class: 'spacer' }),
      h('button', { class: 'btn', type: 'button', onclick: () => modal.close() }, 'Cancel'),
      h('button', { class: 'btn primary', type: 'button', onclick: save }, editing ? 'Save' : 'Add'),
    ],
  });
  sync();
}

// ------------------------------------------------------------- one occurrence

export function openOccurrence(o) {
  const amount = moneyInput({
    value: centsToInput(o.actual_amount ?? (o.variable ? null : o.amount)),
    placeholder: o.variable && o.amount ? `Estimate ${centsToInput(o.amount)}` : '0.00',
  });
  const date = h('input', { type: 'date', value: o.date });
  const note = h('input', { type: 'text', value: o.note || '', maxlength: 2000, placeholder: 'Optional' });
  const done = DONE_LABEL[o.kind];
  const overridden = o.actual_amount !== null || o.moved || o.status !== 'scheduled' || o.note;

  const tags = [
    o.status === 'paid' ? h('span', { class: 'tag good' }, `✓ ${done}`) : null,
    o.status === 'skipped' ? h('span', { class: 'tag muted' }, 'Skipped') : null,
    o.variable && !o.amount_known ? h('span', { class: 'tag warn' }, 'Amount needed') : null,
    o.autopay ? h('span', { class: 'tag' }, 'Autopay') : null,
    o.moved ? h('span', { class: 'tag' }, `Moved from ${fmtDate(o.occ_date)}`) : null,
    o.recurring ? null : h('span', { class: 'tag' }, 'One-time'),
  ];

  const form = h('form', { class: 'form', onsubmit: (ev) => { ev.preventDefault(); save(); } },
    h('div', { class: 'tags' }, tags),
    h('div', { class: 'row' },
      field(o.variable ? 'Actual amount' : 'Amount', amount.wrap,
        o.variable ? 'This one varies. Enter the real amount once you know it (e.g. from the statement).'
          : 'Change it for just this occurrence.'),
      field('Date', date, o.recurring ? 'Move just this occurrence.' : null)),
    field('Note', note),
    h('button', { type: 'submit', hidden: true }),
  );

  function patchBody() {
    const amt = parseMoney(amount.input.value);
    // A fixed amount left unchanged is not stored as an override.
    const unchanged = !o.variable && o.actual_amount === null && amt === o.amount;
    return { amount: amt === null || unchanged ? null : amt, date: date.value || o.occ_date, note: note.value };
  }

  async function patch(extra, message) {
    try {
      await run(() => api.patchOccurrence(o.entry_id, o.occ_date, { ...patchBody(), ...extra }), message);
      modal.close();
    } catch { /* toast already shown */ }
  }

  const save = () => {
    const amt = parseMoney(amount.input.value);
    if (amt !== null && amt < 0) return toast('Enter the amount as a positive number', 'error');
    return patch({}, 'Saved');
  };

  async function editSeries() {
    try {
      const entry = await api.entry(o.entry_id);
      modal.close();
      openEntryForm({ entry, occurrence: o });
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  const modal = openModal({
    title: o.name,
    subtitle: `${KIND_LABEL[o.kind]} · ${occAccounts(o)} · ${fmtDate(o.date, { weekday: 'long', month: 'long', day: 'numeric' })} (${relativeDay(o.date, state.today)})`,
    body: form,
    footer: [
      o.status === 'skipped'
        ? h('button', { class: 'btn', type: 'button', onclick: () => patch({ status: 'scheduled' }, 'Restored') }, 'Un-skip')
        : h('button', { class: 'btn', type: 'button', onclick: () => patch({ status: 'skipped' }, 'Skipped') },
          o.recurring ? 'Skip this one' : 'Skip'),
      h('button', { class: 'btn', type: 'button', onclick: editSeries }, o.recurring ? 'Edit series…' : 'Edit…'),
      overridden ? h('button', {
        class: 'btn subtle', type: 'button', title: 'Undo changes made to just this occurrence',
        onclick: async () => {
          try {
            await run(() => api.resetOccurrence(o.entry_id, o.occ_date), 'Reset to schedule');
            modal.close();
          } catch { /* toast already shown */ }
        },
      }, 'Reset') : null,
      h('span', { class: 'spacer' }),
      o.status === 'paid'
        ? h('button', { class: 'btn', type: 'button', onclick: () => patch({ status: 'scheduled' }, `Marked not ${done.toLowerCase()}`) }, `Not ${done.toLowerCase()}`)
        : h('button', { class: 'btn good', type: 'button', onclick: () => patch({ status: 'paid' }, `Marked ${done.toLowerCase()}`) }, `Mark ${done.toLowerCase()}`),
      h('button', { class: 'btn primary', type: 'button', onclick: save }, 'Save'),
    ],
  });
}

// ------------------------------------------------------------------- one day

export function openDay(date, occurrences, balances, accountId = null) {
  const rows = occurrences.length
    ? occurrences.map((o) => {
      const amt = signedAmount(o, accountId);
      return h('button', {
        class: `occ-row kind-${o.kind} status-${o.status}`,
        type: 'button',
        onclick: () => { modal.close(); openOccurrence(o); },
      },
      h('span', { class: 'dot', style: { background: (account(o.account_id) || {}).color || 'var(--muted)' } }),
      h('span', { class: 'occ-main' },
        h('span', { class: 'occ-name' }, o.name),
        h('span', { class: 'occ-meta' }, [
          occAccounts(o),
          o.status === 'paid' ? ` · ✓ ${DONE_LABEL[o.kind]}` : '',
          o.status === 'skipped' ? ' · Skipped' : '',
          o.variable && !o.amount_known ? ' · amount needed' : '',
        ].join(''))),
      h('span', { class: `occ-amt ${amt > 0 ? 'pos' : amt < 0 ? 'neg' : ''}` },
        o.kind === 'transfer' && accountId === null ? occAmount(o) : occAmount(o, amt, (v) => money(v, { sign: true }))));
    })
    : [h('p', { class: 'empty' }, 'Nothing scheduled.')];

  const balanceRows = state.accounts
    .filter((a) => balances && balances[a.id] !== null && balances[a.id] !== undefined)
    .map((a) => {
      const bal = balances[a.id];
      const low = a.min_balance !== null && bal < a.min_balance;
      return h('div', { class: 'bal-row' },
        h('span', null, h('span', { class: 'dot', style: { background: a.color || 'var(--muted)' } }), a.name),
        h('span', { class: `${bal < 0 ? 'neg' : ''} ${low ? 'low' : ''}` }, money(bal), low ? ' ⚠' : ''));
    });

  const modal = openModal({
    title: fmtDate(date, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }),
    subtitle: relativeDay(date, state.today),
    body: [
      h('div', { class: 'occ-list' }, rows),
      balanceRows.length ? h('h3', { class: 'section-title' }, 'Projected end-of-day balances') : null,
      h('div', { class: 'bal-list' }, balanceRows),
    ],
    footer: [
      h('span', { class: 'spacer' }),
      h('button', {
        class: 'btn primary', type: 'button',
        onclick: () => { modal.close(); openEntryForm({ defaults: { start_date: date, frequency: 'once' } }); },
      }, '+ Add on this day'),
    ],
  });
}

// ------------------------------------------------------------------ accounts

const ACCOUNT_FIELDS = ['name', 'type', 'opening_balance', 'opening_date', 'min_balance', 'color', 'notes'];

function accountBody(a) {
  const body = {};
  for (const k of ACCOUNT_FIELDS) body[k] = a[k];
  return body;
}

export function openAccountForm(existing = null) {
  const a = existing ? accountBody(existing) : {
    name: '', type: 'checking', opening_balance: 0, opening_date: state.today, min_balance: 0,
    color: ACCOUNT_COLORS[state.accounts.length % ACCOUNT_COLORS.length], notes: '',
  };
  const name = h('input', { type: 'text', value: a.name, maxlength: 100, placeholder: 'e.g. Chase Checking', autofocus: true });
  const type = h('select', { value: a.type }, Object.entries(ACCOUNT_TYPES).map(([v, l]) => h('option', { value: v }, l)));
  const balance = moneyInput({ value: centsToInput(a.opening_balance), placeholder: '0.00' });
  const asOf = h('input', { type: 'date', value: a.opening_date });
  const warn = h('input', { type: 'checkbox', checked: a.min_balance !== null });
  const minimum = moneyInput({ value: centsToInput(a.min_balance ?? 0) });
  const notes = h('textarea', { rows: 2, maxlength: 2000 }, a.notes || '');
  const balanceHint = h('span', { class: 'hint' });
  let color = a.color || ACCOUNT_COLORS[0];
  const swatches = h('div', { class: 'swatches' }, ACCOUNT_COLORS.map((c) => h('button', {
    type: 'button', class: `swatch${c === color ? ' on' : ''}`, style: { background: c }, 'aria-label': c,
    onclick: (ev) => {
      color = c;
      swatches.querySelectorAll('.swatch').forEach((s) => s.classList.remove('on'));
      ev.currentTarget.classList.add('on');
    },
  })));

  function sync() {
    minimum.wrap.classList.toggle('disabled', !warn.checked);
    minimum.input.disabled = !warn.checked;
    balanceHint.textContent = type.value === 'credit_card'
      ? 'Enter what you owe as a negative number (e.g. -1250.00).'
      : 'Your balance at the start of this date. Items on or after it are added to it.';
  }
  type.addEventListener('change', () => {
    if (!existing && type.value === 'credit_card') warn.checked = false;
    sync();
  });
  warn.addEventListener('change', sync);

  const form = h('form', { class: 'form', onsubmit: (ev) => { ev.preventDefault(); save(); } },
    h('div', { class: 'row' }, field('Name', name), field('Type', type)),
    h('div', { class: 'row' },
      h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Balance'), balance.wrap, balanceHint),
      field('As of', asOf)),
    h('div', { class: 'field' },
      h('label', { class: 'check' }, warn, h('span', null, 'Warn me when this account is projected to drop below')),
      minimum.wrap),
    h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Color'), swatches),
    field('Notes', notes),
    h('button', { type: 'submit', hidden: true }),
  );

  async function save() {
    const body = {
      name: name.value.trim(),
      type: type.value,
      opening_balance: parseMoney(balance.input.value) ?? 0,
      opening_date: asOf.value,
      min_balance: warn.checked ? (parseMoney(minimum.input.value) ?? 0) : null,
      color,
      notes: notes.value.trim() || null,
    };
    if (!body.name) return toast('Give the account a name', 'error');
    if (!body.opening_date) return toast('Pick the date this balance is from', 'error');
    try {
      if (existing) await run(() => api.updateAccount(existing.id, body), 'Account saved');
      else await run(() => api.createAccount(body), `Added ${body.name}`);
      modal.close();
    } catch { /* toast already shown */ }
  }

  async function remove() {
    const ok = await confirmDanger(`Delete ${existing.name}?`,
      'This also deletes every bill, income and transfer tied to this account. This cannot be undone.');
    if (!ok) return;
    try {
      await run(() => api.deleteAccount(existing.id), 'Account deleted');
      modal.close();
    } catch { /* toast already shown */ }
  }

  const modal = openModal({
    title: existing ? `Edit ${existing.name}` : 'Add account',
    body: form,
    footer: [
      existing ? h('button', { class: 'btn danger-text', type: 'button', onclick: remove }, 'Delete…') : null,
      h('span', { class: 'spacer' }),
      h('button', { class: 'btn', type: 'button', onclick: () => modal.close() }, 'Cancel'),
      h('button', { class: 'btn primary', type: 'button', onclick: save }, existing ? 'Save' : 'Add account'),
    ],
  });
  sync();
}

// Re-anchors an account to what the bank shows today.
export async function openBalanceUpdate(acct) {
  const today = state.today;
  let todays = [];
  try {
    const cal = await api.calendar(today, today);
    todays = cal.occurrences.filter((o) => o.status !== 'skipped'
      && (o.account_id === acct.id || o.to_account_id === acct.id));
  } catch (err) {
    toast(err.message, 'error');
    return;
  }
  const todayDelta = todays.reduce((sum, o) => sum + signedAmount(o, acct.id), 0);
  const balance = moneyInput({ placeholder: centsToInput(acct.balance_today), autofocus: true });
  const posted = h('input', { type: 'checkbox' });

  const body = [
    h('p', { class: 'muted-text' }, `Projected balance today: ${money(acct.balance_today)}. Enter the real balance and projections will continue from it.`),
    field('Current balance', balance.wrap),
  ];
  if (todays.length) {
    body.push(h('label', { class: 'check' }, posted, h('span', null, 'These items for today already show in that balance:')));
    body.push(h('ul', { class: 'plain-list' }, todays.map((o) => h('li', null,
      `${o.name} (${money(signedAmount(o, acct.id), { sign: true })})`))));
  }

  async function save() {
    const value = parseMoney(balance.input.value);
    if (value === null) return toast('Enter the balance', 'error');
    const opening = posted.checked ? value - todayDelta : value;
    try {
      await run(() => api.updateAccount(acct.id, { ...accountBody(acct), opening_balance: opening, opening_date: today }),
        `${acct.name} updated`);
      modal.close();
    } catch { /* toast already shown */ }
  }

  const modal = openModal({
    title: `Update ${acct.name} balance`,
    body: h('form', { class: 'form', onsubmit: (ev) => { ev.preventDefault(); save(); } }, body,
      h('button', { type: 'submit', hidden: true })),
    footer: [
      h('span', { class: 'spacer' }),
      h('button', { class: 'btn', type: 'button', onclick: () => modal.close() }, 'Cancel'),
      h('button', { class: 'btn primary', type: 'button', onclick: save }, 'Update balance'),
    ],
  });
}
