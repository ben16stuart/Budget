import { h } from './util.js';

const root = () => document.getElementById('modal-root');
const stack = [];

document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape' && stack.length) stack[stack.length - 1].close();
});

// Opens a dialog. `body` and `footer` are nodes (or arrays of nodes).
export function openModal({ title, subtitle, body, footer, wide = false, onClose }) {
  const closeBtn = h('button', { class: 'icon-btn', 'aria-label': 'Close', type: 'button' }, '×');
  const dialog = h('div', { class: `modal${wide ? ' wide' : ''}`, role: 'dialog', 'aria-modal': 'true' },
    h('div', { class: 'modal-head' },
      h('div', null, h('h2', null, title), subtitle ? h('div', { class: 'modal-sub' }, subtitle) : null),
      closeBtn),
    h('div', { class: 'modal-body' }, body),
    footer ? h('div', { class: 'modal-foot' }, footer) : null,
  );
  const backdrop = h('div', { class: 'backdrop' }, dialog);
  let closed = false;
  const handle = {
    el: dialog,
    close() {
      if (closed) return;
      closed = true;
      backdrop.remove();
      stack.splice(stack.indexOf(handle), 1);
      document.body.classList.toggle('modal-open', stack.length > 0);
      if (onClose) onClose();
    },
  };
  closeBtn.addEventListener('click', () => handle.close());
  backdrop.addEventListener('mousedown', (ev) => {
    if (ev.target === backdrop) handle.close();
  });
  stack.push(handle);
  root().append(backdrop);
  document.body.classList.add('modal-open');
  const first = dialog.querySelector('[autofocus], .modal-body input:not([type=hidden]):not([type=radio]):not([type=checkbox]), .modal-body select');
  if (first) setTimeout(() => first.focus(), 30);
  return handle;
}

// Resolves with the chosen button's value, or null when dismissed.
export function choose({ title, message, buttons }) {
  return new Promise((resolve) => {
    let result = null;
    const modal = openModal({
      title,
      body: h('p', { class: 'confirm-text' }, message),
      footer: [
        h('span', { class: 'spacer' }),
        h('button', { class: 'btn', type: 'button', onclick: () => modal.close() }, 'Cancel'),
        ...buttons.map((b) => h('button', {
          class: `btn ${b.class || 'primary'}`,
          type: 'button',
          onclick: () => { result = b.value; modal.close(); },
        }, b.label)),
      ],
      onClose: () => resolve(result),
    });
  });
}

export function confirmDanger(title, message, label = 'Delete') {
  return choose({ title, message, buttons: [{ label, value: true, class: 'danger' }] }).then(Boolean);
}

export function toast(message, type = 'info') {
  const el = h('div', { class: `toast ${type}` }, message);
  document.getElementById('toasts').append(el);
  setTimeout(() => el.classList.add('hide'), 3200);
  setTimeout(() => el.remove(), 3700);
}
