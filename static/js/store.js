// Shared app state. Views read it; any change to data goes through refresh().
import { toast } from './modal.js';
import { todayISO } from './util.js';

export const state = {
  today: todayISO(),
  settings: { currency: 'USD', week_start: '0', horizon_days: '45', upcoming_days: '14' },
  accounts: [],
  alerts: { action_items: [], balance_alerts: [], upcoming: [] },
  month: todayISO().slice(0, 7),
  filter: 'all', // calendar account filter: 'all' or an account id
};

let refresher = async () => {};

export function onRefresh(fn) {
  refresher = fn;
}

export function refresh() {
  return refresher();
}

export function account(id) {
  return state.accounts.find((a) => a.id === id);
}

export function accountName(id) {
  const a = account(id);
  return a ? a.name : 'Unknown account';
}

// Runs an async action, refreshes data on success, and reports errors as toasts.
export async function run(action, successMessage) {
  try {
    const result = await action();
    await refresh();
    if (successMessage) toast(successMessage, 'success');
    return result;
  } catch (err) {
    toast(err.message || String(err), 'error');
    throw err;
  }
}
