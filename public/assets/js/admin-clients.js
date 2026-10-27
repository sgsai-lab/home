import { api, ApiError, describeError, h, handleSubmit, requireUser, showStatus } from '/assets/js/auth.js';
import { closeDialog, openDialog } from '/assets/js/dialog.js';
import { badge, initials, SECTOR, statusTone } from '/assets/js/hub.js';

const $ = (id) => document.getElementById(id);
const filterForm = $('client-filter-form');
const filters = { q: '', sector: '', status: '' };
const STATUS = { prospect: 'Prospect', active: 'Active', paused: 'Paused', closed: 'Closed' };

async function load() {
  const params = new URLSearchParams({ page_size: 50, sort: 'name' });
  for (const [key, value] of Object.entries(filters)) if (value) params.set(key, value);
  const { items, total } = await api(`/clients?${params}`);
  const filtered = Boolean(filters.q || filters.sector || filters.status);
  if (!filtered) {
    $('clients-count').textContent = String(total ?? items.length);
    $('clients-count').hidden = false;
  }
  $('clients-body').replaceChildren(...(items.length ? items.map((client) => h('tr', {},
    h('td', {}, h('span', { className: 'cell-person' },
      h('span', { className: 'avatar', 'aria-hidden': 'true', text: initials(client.name) }),
      h('span', { className: 'cell-primary' },
        h('a', { href: `/workspace/?client=${encodeURIComponent(client.id)}` }, h('strong', { text: client.name })),
        client.contact?.email && h('span', { className: 'hint', text: client.contact.email })))),
    h('td', { text: SECTOR[client.primary_sector] }),
    h('td', {}, badge(STATUS[client.status], client.status === 'active' ? 'success' : statusTone(client.status))),
    h('td', { text: String(client.member_count) }),
    h('td', {}, h('div', { className: 'row-actions' },
      h('a', { className: 'button button-secondary button-small', href: `/workspace/?client=${encodeURIComponent(client.id)}`, text: 'Open' }),
      h('a', { className: 'button button-primary button-small', href: `/admin/clients/?id=${encodeURIComponent(client.id)}`, text: 'Manage' }))))) : [h('tr', {}, h('td', { colspan: 5, className: 'empty', text: filtered ? 'No workspaces match these filters.' : 'No client workspaces yet. Create the first one with “New workspace”.' }))]));
}

$('client-open').addEventListener('click', () => {
  $('client-create-form').reset();
  showStatus($('client-create-status'), '');
  openDialog($('client-dialog'));
});

handleSubmit($('client-create-form'), $('client-create-status'), async ({ name, primary_sector: sector, contact_email: email }) => {
  if (!name.trim()) throw new ApiError(0, 'CLIENT', 'Enter the organisation name.');
  const client = await api('/clients', { method: 'POST', body: { name: name.trim(), primary_sector: sector, ...(email.trim() ? { contact: { email: email.trim() } } : {}) } });
  closeDialog($('client-dialog'), 'saved');
  await load();
  showStatus($('clients-status'), `${client.name} created. `, 'success');
  $('clients-status').append(h('a', { href: `/admin/clients/?id=${encodeURIComponent(client.id)}`, text: 'Open Manage' }), ' to invite people and add apps.');
});

let searchTimer;
async function applyFilters() {
  const { q, sector, status } = Object.fromEntries(new FormData(filterForm));
  Object.assign(filters, { q: q.trim(), sector, status });
  showStatus($('clients-status'), '');
  try {
    await load();
  } catch (error) {
    showStatus($('clients-status'), describeError(error));
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

async function main() {
  await requireUser({ admin: true });
  await load();
}

main().catch((error) => showStatus($('clients-status'), describeError(error)));
