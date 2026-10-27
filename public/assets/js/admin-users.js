import { api, ApiError, bindAction, describeError, formatDate, h, handleSubmit, requireUser, showStatus } from '/assets/js/auth.js';
import { closeDialog, confirmDialog, openDialog } from '/assets/js/dialog.js';
import { initials } from '/assets/js/hub.js';

const $ = (id) => document.getElementById(id);
const usersStatus = $('users-status');
const filterForm = $('filter-form');
const editForm = $('user-edit-form');
const state = { page: 1, pageSize: 20, q: '', role: '', status: '', sort: '-created_at' };
let me = null;
let editingUser = null;

function badge(ok, yes, no) {
  return h('span', { className: `badge ${ok ? 'badge-success' : 'badge-warning'}`, text: ok ? yes : no });
}

function openEditor(user) {
  editingUser = user;
  const isSelf = user.id === me.id;
  editForm.reset();
  showStatus($('user-edit-status'), '');
  $('user-edit-heading').textContent = isSelf ? 'Edit your account' : `Edit ${user.full_name}`;
  $('user-edit-email').textContent = user.email;
  $('user-edit-self').hidden = !isSelf;
  editForm.elements.full_name.value = user.full_name;
  editForm.elements.role.value = user.role;
  editForm.elements.status.value = user.status;
  // The API rejects role/status changes on your own account.
  editForm.elements.role.disabled = isSelf;
  editForm.elements.status.disabled = isSelf;
  openDialog($('user-dialog'), { initialFocus: editForm.elements.full_name });
}

handleSubmit(editForm, $('user-edit-status'), async (values) => {
  const changes = {};
  if (values.full_name.trim() !== editingUser.full_name) changes.full_name = values.full_name.trim();
  if (values.role && values.role !== editingUser.role) changes.role = values.role;
  if (values.status && values.status !== editingUser.status) changes.status = values.status;
  if ('full_name' in changes && !changes.full_name) throw new ApiError(0, 'CLIENT', 'Enter a name.');
  if (!Object.keys(changes).length) {
    closeDialog($('user-dialog'));
    return showStatus(usersStatus, 'No changes to save.', 'info');
  }
  await api(`/users/${encodeURIComponent(editingUser.id)}`, { method: 'PATCH', body: changes });
  closeDialog($('user-dialog'), 'saved');
  await load();
  showStatus(usersStatus, `Saved ${editingUser.email}.`, 'success');
});

function renderRow(user) {
  const isSelf = user.id === me.id;
  const edit = h('button', { type: 'button', className: 'button button-secondary button-small', text: 'Edit' });
  const remove = h('button', { type: 'button', className: 'button button-danger button-small', text: 'Delete', disabled: isSelf });
  edit.addEventListener('click', () => openEditor(user));
  bindAction(remove, usersStatus, async () => {
    const confirmed = await confirmDialog({
      title: `Delete ${user.full_name}?`,
      message: `${user.email} loses access immediately. This cannot be undone.`,
      confirmLabel: 'Delete user',
      danger: true
    });
    if (!confirmed) return;
    await api(`/users/${encodeURIComponent(user.id)}`, { method: 'DELETE' });
    showStatus(usersStatus, `Deleted ${user.email}.`, 'success');
    await load();
  });

  return h('tr', {},
    h('td', {}, h('span', { className: 'cell-person' },
      h('span', { className: 'avatar', 'aria-hidden': 'true', text: initials(user.full_name) }),
      h('span', { className: 'cell-primary' },
        h('strong', { text: isSelf ? `${user.full_name} (you)` : user.full_name }),
        h('span', { className: 'hint', text: user.email })))),
    h('td', {}, h('span', { className: `badge${user.role === 'admin' ? ' badge-purple' : ''}`, text: user.role === 'admin' ? 'Admin' : 'User' })),
    h('td', {}, badge(user.status === 'active', 'Active', 'Disabled')),
    h('td', {}, badge(user.email_verified, 'Yes', 'No')),
    h('td', {}, badge(user.mfa_enabled, 'On', 'Off')),
    h('td', { text: formatDate(user.last_login_at) }),
    h('td', {}, h('div', { className: 'row-actions' }, edit, remove)));
}

async function load() {
  const params = new URLSearchParams({ page: state.page, page_size: state.pageSize, sort: state.sort });
  for (const key of ['q', 'role', 'status']) if (state[key]) params.set(key, state[key]);
  const result = await api(`/users?${params}`);
  const pages = Math.max(1, Math.ceil(result.total / result.page_size));
  if (!state.q && !state.role && !state.status) {
    $('users-count').textContent = String(result.total);
    $('users-count').hidden = false;
  }
  $('users-body').replaceChildren(...(result.items.length
    ? result.items.map(renderRow)
    : [h('tr', {}, h('td', { colspan: 7, className: 'empty', text: 'No users match these filters.' }))]));
  $('page-info').textContent = `Page ${result.page} of ${pages} · ${result.total} users`;
  $('prev-page').disabled = result.page <= 1;
  $('next-page').disabled = result.page >= pages;
}

let searchTimer;
async function applyFilters() {
  const { q, role, status, sort } = Object.fromEntries(new FormData(filterForm));
  Object.assign(state, { page: 1, q: q.trim(), role, status, sort });
  showStatus(usersStatus, '');
  try {
    await load();
  } catch (error) {
    showStatus(usersStatus, describeError(error));
  }
}
filterForm.addEventListener('submit', (event) => {
  event.preventDefault();
  clearTimeout(searchTimer);
  applyFilters();
});
filterForm.addEventListener('change', (event) => {
  if (event.target.name !== 'q') applyFilters();
});
filterForm.elements.q.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(applyFilters, 300);
});

$('invite-open').addEventListener('click', () => {
  $('create-form').reset();
  showStatus($('create-status'), '');
  openDialog($('invite-dialog'));
});

handleSubmit($('create-form'), $('create-status'), async ({ full_name: fullName, email, role }) => {
  if (!fullName.trim() || !email.trim()) throw new ApiError(0, 'CLIENT', 'Enter a name and email.');
  const user = await api('/users', { method: 'POST', body: { full_name: fullName.trim(), email: email.trim(), role } });
  closeDialog($('invite-dialog'), 'saved');
  await load();
  showStatus(usersStatus, `Invitation sent to ${user.email}.`, 'success');
});

bindAction($('prev-page'), usersStatus, async () => { state.page -= 1; await load(); });
bindAction($('next-page'), usersStatus, async () => { state.page += 1; await load(); });

async function main() {
  me = await requireUser({ admin: true });
  await load();
}

main().catch((error) => showStatus($('page-status'), describeError(error)));
