import { api, describeError, h, handleSubmit, requireUser, showStatus } from '/assets/js/auth.js';

const $ = (id) => document.getElementById(id);
let cursor = null;

async function load(append = false) {
  const query = new URLSearchParams({ page_size: '25' });
  if (append && cursor) query.set('cursor', cursor);
  const result = await api(`/crm/issuer-operators?${query}`);
  for (const operator of result.items) {
    if (![...$('issuer-user').options].some((option) => option.value === operator.user_id)) {
      $('issuer-user').append(h('option', { value: operator.user_id, text: `${operator.user_id} (existing assignment)` }));
    }
  }
  const rows = result.items.map((operator) => h('tr', {},
    h('td', { text: operator.user_id }),
    h('td', { text: operator.active ? 'Assigned' : 'Revoked' }),
    h('td', { text: operator.updated_at })));
  if (append) $('issuer-body').append(...rows);
  else $('issuer-body').replaceChildren(...(rows.length ? rows : [h('tr', {}, h('td', { colspan: 3, text: 'No issuer operators assigned.' }))]));
  cursor = result.next_cursor;
  $('issuer-more').hidden = !cursor;
}

handleSubmit($('issuer-form'), $('issuer-status'), async ({ user_id: userId, active, reason }) => {
  if (!window.confirm(`${active === 'true' ? 'Assign' : 'Revoke'} issuer authority for this SGS administrator? Actual customer workspace ownership is still required.`)) return;
  await api(`/crm/issuer-operators/${encodeURIComponent(userId.trim())}`, {
    method: 'PUT', body: { active: active === 'true', reason }
  });
  await load();
  showStatus($('issuer-status'), 'Issuer authority updated and audited.', 'success');
});

$('issuer-more').addEventListener('click', async () => {
  $('issuer-more').disabled = true;
  try { await load(true); }
  catch (error) { showStatus($('issuer-status'), describeError(error)); }
  finally { $('issuer-more').disabled = false; }
});

async function main() {
  await requireUser({ admin: true });
  let page = 1;
  let loaded = 0;
  let result;
  do {
    result = await api(`/users?role=admin&page_size=50&page=${page++}`);
    $('issuer-user').append(...result.items.map((user) => h('option', { value: user.id, text: `${user.full_name} (${user.email}) - ${user.status}` })));
    loaded += result.items.length;
  } while (result.items.length && loaded < result.total);
  await load();
}
main().catch((error) => showStatus($('issuer-status'), describeError(error)));
