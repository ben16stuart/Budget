async function request(method, path, body) {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(`/api${path}`, opts);
  if (res.status === 204) return null;
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(errorMessage(data) || `Request failed (${res.status})`);
  return data;
}

function errorMessage(data) {
  const detail = data && data.detail;
  if (!detail) return '';
  if (typeof detail === 'string') return detail;
  if (Array.isArray(detail)) {
    return detail
      .map((d) => String(d.msg || '').replace(/^Value error, /, ''))
      .filter(Boolean)
      .join('; ');
  }
  return JSON.stringify(detail);
}

const q = (params) => new URLSearchParams(params).toString();

export const api = {
  settings: () => request('GET', '/settings'),
  saveSettings: (body) => request('PUT', '/settings', body),

  accounts: (today) => request('GET', `/accounts?${q({ today })}`),
  createAccount: (body) => request('POST', '/accounts', body),
  updateAccount: (id, body) => request('PUT', `/accounts/${id}`, body),
  deleteAccount: (id) => request('DELETE', `/accounts/${id}`),

  entries: (today) => request('GET', `/entries?${q({ today })}`),
  entry: (id) => request('GET', `/entries/${id}`),
  createEntry: (body, today) => request('POST', `/entries?${q({ today })}`, body),
  updateEntry: (id, body) => request('PUT', `/entries/${id}`, body),
  deleteEntry: (id) => request('DELETE', `/entries/${id}`),

  patchOccurrence: (entryId, occDate, body) => request('PATCH', `/occurrences/${entryId}/${occDate}`, body),
  resetOccurrence: (entryId, occDate) => request('DELETE', `/occurrences/${entryId}/${occDate}`),

  calendar: (start, end) => request('GET', `/calendar?${q({ start, end })}`),
  alerts: (today) => request('GET', `/alerts?${q({ today })}`),

  notifyStatus: () => request('GET', '/notify'),
  notifyTest: (today) => request('POST', `/notify/test?${q({ today })}`),

  exportData: () => request('GET', '/export'),
  importData: (data) => request('POST', '/import', data),
};
