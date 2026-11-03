import { api, ApiError, bindAction, describeError, h, handleSubmit, requireUser, showStatus } from '/assets/js/auth.js';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const clientId = params.get('client');
const labels = { qualified: 'Qualified', discovery: 'Discovery', proposal: 'Proposal', negotiation: 'Negotiation', closed_won: 'Closed won', closed_lost: 'Closed lost' };
const state = { capabilities: null, project: params.get('project') ?? '', stage: '', cursor: null, next: null, selected: null, etag: null, editing: false, editorProject: null, revisionCursor: null };
const operationKeys = new Map();
const money = (minor) => new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' }).format(minor / 100);

function clearPrivateView() {
  $('crm-content').hidden = true;
  $('deals-body').replaceChildren();
  $('detail-fields').replaceChildren();
  $('revision-list').replaceChildren();
  $('billing-plan').textContent = '';
  $('detail-heading').textContent = 'Deal details';
  $('editor-heading').textContent = 'Create deal';
  $('editor-project').textContent = '';
  $('deal-actions').replaceChildren();
  $('deal-detail').hidden = true;
  $('deal-editor').hidden = true;
  $('deal-form').reset();
  state.selected = null;
  state.capabilities = null;
}

async function request(path, options) {
  try {
    return await api(path, options);
  } catch (error) {
    if ([401, 403, 404].includes(error.status)) clearPrivateView();
    throw error;
  }
}

function toMinor(value, limit = 1_000_000_000_000) {
  if (!/^\d{1,13}(?:\.\d{1,2})?$/.test(value)) throw new ApiError(400, 'VALIDATION', 'Enter a positive INR amount with at most two decimal places.');
  const [whole, fraction = ''] = value.split('.');
  const minor = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  if (minor < 1n || minor > BigInt(limit)) throw new ApiError(400, 'VALIDATION', 'The amount is outside the supported range.');
  return Number(minor);
}

function decimal(minor) {
  return minor === null || minor === undefined ? '' : `${Math.floor(minor / 100)}.${String(minor % 100).padStart(2, '0')}`;
}

function field(name, value) {
  return [h('dt', { text: name }), h('dd', { text: value ?? 'Not set' })];
}

async function loadDeals() {
  const query = new URLSearchParams({ page_size: '25' });
  if (state.cursor) query.set('cursor', state.cursor);
  if (state.stage) query.set('stage', state.stage);
  if (state.project) query.set('project_id', state.project);
  const result = await request(`/clients/${encodeURIComponent(clientId)}/crm/deals?${query}`);
  state.next = result.next_cursor;
  $('deals-body').replaceChildren(...(result.items.length ? result.items.map((deal) => {
    const view = h('button', { type: 'button', className: 'button button-secondary button-small', text: 'View', 'aria-label': `View ${deal.name}` });
    bindAction(view, $('page-status'), () => selectDeal(deal.id));
    return h('tr', {},
      h('td', { text: deal.name }), h('td', { text: deal.project_name }),
      h('td', { text: labels[deal.stage] }), h('td', { text: money(deal.amount_minor) }),
      h('td', { text: deal.expected_close_date ?? 'Not set' }), h('td', {}, view));
  }) : [h('tr', {}, h('td', { colspan: 6, text: 'No deals match these filters.' }))]));
  $('next-page').disabled = !state.next;
  $('first-page').disabled = !state.cursor;
  $('new-deal').hidden = !state.capabilities.can_prepare;
  $('new-deal').disabled = !state.project;
}

async function loadRevisions(append = false) {
  const query = new URLSearchParams({ page_size: '25' });
  if (append && state.revisionCursor) query.set('cursor', state.revisionCursor);
  const result = await request(`/crm/deals/${encodeURIComponent(state.selected.id)}/revisions?${query}`);
  const rows = result.items.map((revision) => h('li', {},
    h('details', {},
      h('summary', { text: `Revision ${revision.revision_number} - ${money(revision.amount_minor)} - ${revision.published_at.slice(0, 10)}` }),
      h('p', { className: 'crm-scope', text: revision.scope }),
      h('p', { text: `${revision.billing_method === 'fixed' ? 'Fixed price' : 'Hourly'}; ${revision.start_date ?? 'No start'} to ${revision.end_date ?? 'No deadline'}; month-end billing, net 30.` }),
      revision.hourly_rate_minor && h('p', { text: `${money(revision.hourly_rate_minor)}/hour; ${revision.planned_minutes} planned minutes.` }))));
  if (append) $('revision-list').append(...rows);
  else $('revision-list').replaceChildren(...(rows.length ? rows : [h('li', { text: 'No proposal published yet.' })]));
  state.revisionCursor = result.next_cursor;
  $('more-revisions').hidden = !state.revisionCursor;
}

function addAction(label, action, body = {}) {
  const button = h('button', { type: 'button', className: 'button button-primary', text: label });
  bindAction(button, $('deal-status'), async () => {
    if (!window.confirm(`${label} for ${state.selected.name}? This records the current proposal and your identity.`)) return;
    await performAction(action, body);
  });
  $('deal-actions').append(button);
}

async function performAction(action, body = {}) {
  const id = state.selected.id;
  const operation = `${id}:${state.selected.version}:${action}`;
  if (!operationKeys.has(operation)) operationKeys.set(operation, crypto.randomUUID());
  await request(`/crm/deals/${encodeURIComponent(id)}/${action}`, {
    method: 'POST', body, headers: { 'If-Match': state.etag, 'Idempotency-Key': operationKeys.get(operation) }
  });
  operationKeys.delete(operation);
  await selectDeal(id, false);
  await loadDeals();
  showStatus($('deal-status'), 'Saved successfully.', 'success');
}

async function selectDeal(id, focus = true) {
  $('deal-detail').hidden = true;
  $('deal-editor').hidden = true;
  showStatus($('deal-status'), '');
  const { data: deal, headers } = await request(`/crm/deals/${encodeURIComponent(id)}`, { withHeaders: true });
  state.selected = deal;
  state.etag = headers.get('ETag');
  $('detail-heading').textContent = deal.name;
  $('detail-fields').replaceChildren(...[
    field('Project', deal.project_name), field('Stage', labels[deal.stage]),
    field('Price / cap', money(deal.amount_minor)), field('Billing', deal.billing_method === 'fixed' ? 'Fixed price' : 'Time and materials'),
    field('Scope', deal.scope), field('Start', deal.start_date), field('Delivery deadline', deal.end_date),
    field('Target close', deal.expected_close_date),
    field('Proposal', deal.current_revision_id ? `Revision ${deal.revision_number}` : 'No current proposal'),
    field('Customer acceptance', deal.accepted_at ? `Accepted ${deal.accepted_at}` : 'Awaiting acceptance'),
    ...(deal.loss_reason ? [field('Loss reason', deal.loss_reason)] : []),
    ...(deal.hourly_rate_minor ? [field('Hourly rate', money(deal.hourly_rate_minor)), field('Planned minutes', deal.planned_minutes)] : [])
  ].flat());
  const open = !deal.stage.startsWith('closed_');
  $('edit-deal').hidden = !state.capabilities.can_prepare || !open;
  $('deal-actions').replaceChildren();
  if (open && state.capabilities.can_prepare && !deal.accepted_revision_id) addAction('Publish proposal', 'publish');
  if (open && state.capabilities.can_accept && deal.current_revision_id && !deal.accepted_revision_id) addAction('Accept proposal', 'accept', { revision_id: deal.current_revision_id });
  if (open && state.capabilities.can_prepare && deal.accepted_revision_id) addAction('Activate billing plan', 'activate');
  $('loss-panel').hidden = !state.capabilities.can_prepare || !open || Boolean(deal.accepted_revision_id);
  $('loss-panel').open = false;
  await loadRevisions();
  const { plan } = await request(`/projects/${encodeURIComponent(deal.project_id)}/billing-plan`);
  $('billing-plan').textContent = plan
    ? `${plan.deal_id === deal.id ? 'This deal' : 'Another deal'} supplies the active ${plan.billing_method === 'fixed' ? 'fixed-price' : 'hourly'} plan: ${money(plan.amount_minor)} price/cap. Monthly at month end; due 30 days after invoice issue. GST unconfigured; invoice issuance disabled.`
    : 'No billing plan activated. A customer must accept a published proposal before SGS activates it.';
  $('deal-detail').hidden = false;
  if (focus) $('detail-heading').focus();
}

function toggleHourly() {
  const hourly = $('billing-method').value === 'hourly';
  $('hourly-field').hidden = !hourly;
  $('deal-form').elements.hourly_rate.required = hourly;
  $('deal-form').elements.planned_minutes.required = hourly;
}

function editDeal(creating) {
  state.editing = !creating;
  state.editorProject = creating ? $('project-filter').value : state.selected.project_id;
  if (!state.editorProject) return;
  $('deal-form').reset();
  const form = $('deal-form');
  const deal = creating ? null : state.selected;
  $('editor-heading').textContent = creating ? 'Create deal' : `Edit ${deal.name}`;
  const option = [...$('project-filter').options].find((item) => item.value === state.editorProject);
  $('editor-project').textContent = `Project: ${deal?.project_name ?? option?.textContent ?? state.editorProject}`;
  if (deal) {
    for (const name of ['name', 'scope', 'billing_method', 'planned_minutes', 'start_date', 'end_date', 'expected_close_date']) form.elements[name].value = deal[name] ?? '';
    form.elements.amount.value = decimal(deal.amount_minor);
    form.elements.hourly_rate.value = decimal(deal.hourly_rate_minor);
    form.elements.stage.value = ['qualified', 'discovery', 'negotiation'].includes(deal.stage) ? deal.stage : 'discovery';
  }
  toggleHourly();
  showStatus($('editor-status'), '');
  $('deal-detail').hidden = true;
  $('deal-editor').hidden = false;
  $('editor-heading').focus();
}

handleSubmit($('filters'), $('page-status'), async ({ project, stage }) => {
  Object.assign(state, { project, stage, cursor: null });
  await loadDeals();
});
handleSubmit($('deal-form'), $('editor-status'), async (values) => {
  const body = {
    name: values.name, scope: values.scope, currency: 'INR', billing_method: values.billing_method,
    amount_minor: toMinor(values.amount), stage: values.stage,
    start_date: values.start_date || null, end_date: values.end_date || null, expected_close_date: values.expected_close_date || null
  };
  if (values.planned_minutes) body.planned_minutes = Number(values.planned_minutes);
  if (values.billing_method === 'hourly') body.hourly_rate_minor = toMinor(values.hourly_rate, 100_000_000);
  const path = state.editing ? `/crm/deals/${encodeURIComponent(state.selected.id)}` : `/projects/${encodeURIComponent(state.editorProject)}/deals`;
  const deal = await request(path, { method: state.editing ? 'PATCH' : 'POST', body, headers: state.editing ? { 'If-Match': state.etag } : {} });
  state.cursor = null;
  await selectDeal(deal.id);
  await loadDeals();
});
handleSubmit($('loss-form'), $('deal-status'), async ({ reason }) => {
  if (window.confirm('Close this deal as lost? Closed deals cannot be edited.')) await performAction('lose', { reason });
});
bindAction($('first-page'), $('page-status'), async () => { state.cursor = null; await loadDeals(); });
bindAction($('next-page'), $('page-status'), async () => { state.cursor = state.next; await loadDeals(); });
bindAction($('more-revisions'), $('deal-status'), () => loadRevisions(true));
$('new-deal').addEventListener('click', () => editDeal(true));
$('edit-deal').addEventListener('click', () => editDeal(false));
$('cancel-edit').addEventListener('click', () => {
  $('deal-editor').hidden = true;
  $('deal-detail').hidden = !state.selected;
});
$('billing-method').addEventListener('change', toggleHourly);
window.addEventListener('pagehide', clearPrivateView);
window.addEventListener('pageshow', (event) => {
  if (event.persisted) location.reload();
});

async function main() {
  await requireUser();
  if (!clientId) throw new ApiError(400, 'WORKSPACE_REQUIRED', 'Open CRM from a customer workspace.');
  state.capabilities = await request(`/clients/${encodeURIComponent(clientId)}/crm/capabilities`);
  const client = await request(`/clients/${encodeURIComponent(clientId)}`);
  $('crm-workspace').textContent = client.name;
  $('back-link').href = `/workspace/?client=${encodeURIComponent(clientId)}`;
  let page = 1;
  let result;
  const projects = [];
  do {
    result = await request(`/projects?client_id=${encodeURIComponent(clientId)}&page_size=50&page=${page++}&sort=name`);
    projects.push(...result.items);
  } while (projects.length < result.total);
  $('project-filter').append(...projects.map((project) => h('option', { value: project.id, text: project.name })));
  if (!projects.some((project) => project.id === state.project)) state.project = '';
  $('project-filter').value = state.project;
  await loadDeals();
  $('crm-content').hidden = false;
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.capabilities) {
    request(`/clients/${encodeURIComponent(clientId)}/crm/capabilities`)
      .then(async (capabilities) => {
        state.capabilities = capabilities;
        if (state.selected) await selectDeal(state.selected.id, false);
        await loadDeals();
      })
      .catch((error) => showStatus($('page-status'), describeError(error)));
  }
});

main().catch((error) => showStatus($('page-status'), describeError(error)));
