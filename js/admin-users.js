import { api, ApiError, bindAction, formatDate, h, handleSubmit, requireUser, showStatus } from '/js/auth.js';

const $ = (id) => document.getElementById(id);
const usersStatus = $('users-status');
const ROLES = ['user', 'admin'];
const STATUSES = ['active', 'disabled'];
const state = { page: 1, pageSize: 20, q: '', role: '', status: '', sort: '-created_at' };
let me = null;

function select(name, options, value, disabled) {
  return h('select', { name, 'aria-label': name, disabled },
    options.map((option) => h('option', { value: option, selected: option === value, text: option })));
}

function badge(ok, yes, no) {
  return h('span', { className: `badge ${ok ? 'badge-success' : 'badge-warning'}`, text: ok ? yes : no });
}

function renderRow(user) {
  const isSelf = user.id === me.id;
  const name = h('input', { type: 'text', value: user.full_name, maxlength: 120, 'aria-label': 'Full name' });
  const role = select('role', ROLES, user.role, isSelf);
  const status = select('status', STATUSES, user.status, isSelf);
  const save = h('button', { type: 'button', className: 'button button-primary button-small', text: 'Save' });
  const remove = h('button', { type: 'button', className: 'button button-danger button-small', text: 'Delete', disabled: isSelf });

  bindAction(save, usersStatus, async () => {
    // Only send what changed: the API rejects role/status changes on your own account.
    const changes = {};
    if (name.value.trim() !== user.full_name) changes.full_name = name.value.trim();
    if (role.value !== user.role) changes.role = role.value;
    if (status.value !== user.status) changes.status = status.value;
    if (!Object.keys(changes).length) return showStatus(usersStatus, 'No changes to save.', 'info');
    await api(`/users/${encodeURIComponent(user.id)}`, { method: 'PATCH', body: changes });
    showStatus(usersStatus, `Saved ${user.email}.`, 'success');
    await load();
  });

  bindAction(remove, usersStatus, async () => {
    if (!window.confirm(`Delete ${user.email}? This cannot be undone.`)) return;
    await api(`/users/${encodeURIComponent(user.id)}`, { method: 'DELETE' });
    showStatus(usersStatus, `Deleted ${user.email}.`, 'success');
    await load();
  });

  return h('tr', {},
    h('td', {}, name),
    h('td', { text: isSelf ? `${user.email} (you)` : user.email }),
    h('td', {}, role),
    h('td', {}, status),
    h('td', {}, badge(user.email_verified, 'Yes', 'No')),
    h('td', {}, badge(user.mfa_enabled, 'On', 'Off')),
    h('td', { text: formatDate(user.last_login_at) }),
    h('td', {}, h('div', { className: 'row-actions' }, save, remove)));
}

async function load() {
  const params = new URLSearchParams({ page: state.page, page_size: state.pageSize, sort: state.sort });
  for (const key of ['q', 'role', 'status']) if (state[key]) params.set(key, state[key]);
  const result = await api(`/users?${params}`);
  const pages = Math.max(1, Math.ceil(result.total / result.page_size));
  $('users-body').replaceChildren(...(result.items.length
    ? result.items.map(renderRow)
    : [h('tr', {}, h('td', { colspan: 8, className: 'empty', text: 'No users match these filters.' }))]));
  $('page-info').textContent = `Page ${result.page} of ${pages} · ${result.total} users`;
  $('prev-page').disabled = result.page <= 1;
  $('next-page').disabled = result.page >= pages;
}

handleSubmit($('filter-form'), usersStatus, async ({ q, role, status, sort }) => {
  Object.assign(state, { page: 1, q: q.trim(), role, status, sort });
  await load();
});

handleSubmit($('create-form'), $('create-status'), async ({ full_name: fullName, email, role }) => {
  if (!fullName.trim() || !email.trim()) throw new ApiError(0, 'CLIENT', 'Enter a name and email.');
  const user = await api('/users', { method: 'POST', body: { full_name: fullName.trim(), email: email.trim(), role } });
  $('create-form').reset();
  showStatus($('create-status'), `Invitation sent to ${user.email}.`, 'success');
  await load();
});

bindAction($('prev-page'), usersStatus, async () => { state.page -= 1; await load(); });
bindAction($('next-page'), usersStatus, async () => { state.page += 1; await load(); });

async function main() {
  me = await requireUser({ admin: true });
  await load();
}

main().catch((error) => showStatus($('page-status'), error.message));
