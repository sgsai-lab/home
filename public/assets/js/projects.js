import { api, ApiError, bindAction, describeError, getCurrentUser, h, handleSubmit, requireUser, showStatus } from '/assets/js/auth.js';
import { badge, formatDay, loadWorkspaces, PROJECT_STATUS, SECTOR_FIELDS, sectorSubtitle, statusTone } from '/assets/js/hub.js';

const $ = (id) => document.getElementById(id);
const form = $('project-form');
const editorStatus = $('editor-status');
const listStatus = $('list-status');
const initialClient = new URLSearchParams(location.search).get('client_id') ?? '';
const state = { page: 1, pageSize: 12, q: '', status: '', sector: '', client_id: initialClient, sort: '-updated_at' };
let editing = null;
let workspaces = [];

const manageable = () => workspaces.filter((item) => item.role === 'owner' || item.role === 'admin');

function renderProfileFields(sector, values = {}) {
  $('profile-legend').textContent = sector === 'education' ? 'Programme details' : 'Engagement details';
  $('profile-inputs').replaceChildren(...SECTOR_FIELDS[sector].map((field) => {
    const control = field.options
      ? h('select', { name: `profile_${field.name}` }, h('option', { value: '', text: 'Not set' }),
        Object.entries(field.options).map(([value, text]) => h('option', { value, text, selected: values[field.name] === value })))
      : h('input', { name: `profile_${field.name}`, type: 'text', maxlength: field.max, placeholder: field.placeholder, value: values[field.name] ?? '' });
    return h('label', { className: 'field' }, field.label, control);
  }));
}

function sectorOf(clientId) {
  return workspaces.find((item) => item.client_id === clientId)?.primary_sector ?? 'business';
}

function toPayload(values) {
  const tags = values.tags.split(',').map((tag) => tag.trim().toLowerCase()).filter(Boolean);
  const profile = {};
  for (const field of SECTOR_FIELDS[values.sector]) {
    const value = (values[`profile_${field.name}`] ?? '').trim();
    if (value) profile[field.name] = value;
  }
  const payload = {
    name: values.name.trim(),
    sector: values.sector,
    status: values.status,
    summary: values.summary.trim() || null,
    tags: [...new Set(tags)],
    start_date: values.start_date || null,
    end_date: values.end_date || null,
    sector_profile: profile
  };
  if (!payload.name) throw new ApiError(0, 'CLIENT', 'Enter a project name.');
  if (payload.tags.length > 20) throw new ApiError(0, 'CLIENT', 'Use at most 20 tags.');
  if (payload.start_date && payload.end_date && payload.end_date < payload.start_date) {
    throw new ApiError(0, 'CLIENT', 'End date must be on or after the start date.');
  }
  return payload;
}

function setEditing(project, etag) {
  editing = project ? { id: project.id, etag } : null;
  $('editor-heading').textContent = project ? `Edit “${project.name}”` : 'Start a new project';
  $('submit-project').textContent = project ? 'Save changes' : 'Create project';
  $('cancel-edit').hidden = !project;
  $('template-field').hidden = Boolean(project);
  form.reset();
  form.elements.client_id.disabled = Boolean(project);
  const clientId = project?.client_id ?? (form.elements.client_id.value || manageable()[0]?.client_id);
  form.elements.client_id.value = clientId;
  form.elements.sector.value = project?.sector ?? sectorOf(clientId);
  renderProfileFields(form.elements.sector.value, project?.sector_profile ?? {});
  if (!project) return;
  form.elements.name.value = project.name;
  form.elements.status.value = project.status;
  form.elements.summary.value = project.summary ?? '';
  form.elements.start_date.value = project.start_date ?? '';
  form.elements.end_date.value = project.end_date ?? '';
  form.elements.tags.value = project.tags.join(', ');
  $('editor').scrollIntoView({ behavior: 'smooth', block: 'start' });
  form.elements.name.focus({ preventScroll: true });
}

form.elements.client_id.addEventListener('change', () => {
  form.elements.sector.value = sectorOf(form.elements.client_id.value);
  renderProfileFields(form.elements.sector.value);
});
form.elements.sector.addEventListener('change', () => renderProfileFields(form.elements.sector.value));

handleSubmit(form, editorStatus, async (values) => {
  const payload = toPayload(values);
  if (editing) {
    try {
      await api(`/projects/${encodeURIComponent(editing.id)}`, { method: 'PATCH', body: payload, headers: editing.etag ? { 'If-Match': editing.etag } : {} });
    } catch (error) {
      if (error.code === 'PRECONDITION_FAILED') throw new ApiError(412, error.code, 'This project was changed elsewhere. Reopen it to load the latest version.');
      throw error;
    }
    showStatus(editorStatus, `Saved “${payload.name}”.`, 'success');
  } else {
    await api('/projects', { method: 'POST', body: { ...payload, client_id: form.elements.client_id.value, use_template: values.use_template === 'on' } });
    showStatus(editorStatus, `Project “${payload.name}” created.`, 'success');
  }
  setEditing(null);
  await load();
});

$('cancel-edit').addEventListener('click', () => {
  setEditing(null);
  showStatus(editorStatus, '');
});

function showUndo(project) {
  const undo = h('button', { type: 'button', className: 'link-button', text: 'Undo' });
  bindAction(undo, listStatus, async () => {
    await api(`/projects/${encodeURIComponent(project.id)}/restore`, { method: 'POST' });
    showStatus(listStatus, `Restored “${project.name}”.`, 'success');
    await load();
  });
  listStatus.dataset.kind = 'info';
  listStatus.replaceChildren(`Deleted “${project.name}”. `, undo);
  listStatus.hidden = false;
}

function renderCard(project) {
  const workspace = workspaces.find((item) => item.client_id === project.client_id);
  const actions = [h('a', { className: 'button button-secondary button-small', href: `/workspace/project/?id=${encodeURIComponent(project.id)}`, text: 'Open' })];
  if (project.can_edit) {
    const edit = h('button', { type: 'button', className: 'button button-secondary button-small', text: 'Edit' });
    const remove = h('button', { type: 'button', className: 'button button-danger button-small', text: 'Delete' });
    bindAction(edit, listStatus, async () => {
      const { data, headers } = await api(`/projects/${encodeURIComponent(project.id)}`, { withHeaders: true });
      setEditing(data, headers.get('ETag'));
    });
    bindAction(remove, listStatus, async () => {
      if (!window.confirm(`Delete “${project.name}”? You can restore it for 30 days.`)) return;
      await api(`/projects/${encodeURIComponent(project.id)}`, { method: 'DELETE' });
      if (editing?.id === project.id) setEditing(null);
      await load();
      showUndo(project);
    });
    actions.push(edit, remove);
  }
  const dates = [project.start_date, project.end_date].some(Boolean) ? `${formatDay(project.start_date) || '…'} → ${formatDay(project.end_date) || '…'}` : null;
  return h('li', {}, h('article', { className: 'hub-card' },
    h('span', { className: 'card-meta' }, badge(PROJECT_STATUS[project.status] ?? project.status, statusTone(project.status)), workspace && h('span', { text: workspace.client_name })),
    h('h3', { text: project.name }),
    h('span', { className: 'hint', text: sectorSubtitle(project) }),
    project.summary && h('p', { text: project.summary }),
    h('span', { className: 'card-meta' }, project.tags.map((tag) => badge(`#${tag}`)), dates && h('span', { text: dates })),
    h('div', { className: 'row-actions' }, actions)));
}

async function load() {
  const params = new URLSearchParams({ page: state.page, page_size: state.pageSize, sort: state.sort });
  for (const key of ['q', 'status', 'sector', 'client_id']) if (state[key]) params.set(key, state[key]);
  const result = await api(`/projects?${params}`);
  const pages = Math.max(1, Math.ceil(result.total / result.page_size));
  const filtered = state.q || state.status || state.sector;
  $('project-list').replaceChildren(...(result.items.length
    ? result.items.map(renderCard)
    : [h('li', { className: 'empty-state', text: filtered ? 'No projects match these filters.' : 'No projects yet.' })]));
  $('page-info').textContent = `Page ${result.page} of ${pages} · ${result.total} projects`;
  $('prev-page').disabled = result.page <= 1;
  $('next-page').disabled = result.page >= pages;
}

handleSubmit($('filter-form'), listStatus, async ({ q, status, sector, client_id: clientId, sort }) => {
  Object.assign(state, { page: 1, q: q.trim(), status, sector, client_id: clientId, sort });
  await load();
});

bindAction($('prev-page'), listStatus, async () => { state.page -= 1; await load(); });
bindAction($('next-page'), listStatus, async () => { state.page += 1; await load(); });

async function main() {
  await requireUser();
  const user = await getCurrentUser();
  workspaces = await loadWorkspaces(user);
  const filter = $('filter-form').elements.client_id;
  filter.append(...workspaces.map((item) => h('option', { value: item.client_id, text: item.client_name, selected: item.client_id === initialClient })));
  const editable = manageable();
  if (editable.length) {
    form.elements.client_id.replaceChildren(...editable.map((item) => h('option', { value: item.client_id, text: item.client_name })));
    if (editable.some((item) => item.client_id === initialClient)) form.elements.client_id.value = initialClient;
    $('editor').hidden = false;
    setEditing(null);
    if (!user.email_verified) {
      form.querySelectorAll('input, select, textarea, button').forEach((control) => { control.disabled = true; });
      showStatus(editorStatus, 'Verify your email address to create and edit projects.', 'info');
    }
  }
  if (!workspaces.length) {
    showStatus($('page-status'), 'You are not part of a workspace yet, so there are no projects to show.', 'info');
  }
  await load();
}

main().catch((error) => showStatus($('page-status'), describeError(error)));
