import { api, ApiError, h, handleSubmit, requireUser, showStatus } from '/assets/js/auth.js';
import { badge, SECTOR, statusTone } from '/assets/js/hub.js';

const $ = (id) => document.getElementById(id);
const filters = { q: '', sector: '', status: '' };
const STATUS = { prospect: 'Prospect', active: 'Active', paused: 'Paused', closed: 'Closed' };

async function load() {
  const params = new URLSearchParams({ page_size: 50, sort: 'name' });
  for (const [key, value] of Object.entries(filters)) if (value) params.set(key, value);
  const { items } = await api(`/clients?${params}`);
  $('clients-body').replaceChildren(...(items.length ? items.map((client) => h('tr', {},
    h('td', {}, h('a', { href: `/workspace/?client=${encodeURIComponent(client.id)}`, text: client.name })),
    h('td', { text: SECTOR[client.primary_sector] }),
    h('td', {}, badge(STATUS[client.status], client.status === 'active' ? 'success' : statusTone(client.status))),
    h('td', { text: String(client.member_count) }),
    h('td', {}, h('a', { className: 'button button-secondary button-small', href: `/admin/clients/?id=${encodeURIComponent(client.id)}`, text: 'Manage' })))) : [h('tr', {}, h('td', { colspan: 5, className: 'empty', text: filters.q || filters.sector || filters.status ? 'No workspaces match these filters.' : 'No client workspaces yet. Create the first one above.' }))]));
}

handleSubmit($('client-create-form'), $('client-create-status'), async ({ name, primary_sector: sector, contact_email: email }) => {
  if (!name.trim()) throw new ApiError(0, 'CLIENT', 'Enter the organisation name.');
  const client = await api('/clients', { method: 'POST', body: { name: name.trim(), primary_sector: sector, ...(email.trim() ? { contact: { email: email.trim() } } : {}) } });
  $('client-create-form').reset();
  showStatus($('client-create-status'), `${client.name} created. Open Manage to invite people and add apps.`, 'success');
  await load();
});

handleSubmit($('client-filter-form'), $('clients-status'), async ({ q, sector, status }) => {
  Object.assign(filters, { q: q.trim(), sector, status });
  await load();
});

async function main() {
  await requireUser({ admin: true });
  await load();
}

main().catch((error) => showStatus($('clients-status'), error.message));
