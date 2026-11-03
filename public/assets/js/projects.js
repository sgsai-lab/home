import { api, ApiError, bindAction, describeError, getCurrentUser, h, handleSubmit, requireUser, showStatus } from '/assets/js/auth.js';
import { closeDialog, confirmDialog, openDialog, setupDialogs } from '/assets/js/dialog.js';
import { badge, formatDay, loadWorkspaces, milestoneProgress, progressBar, PROJECT_STATUS, SECTOR_FIELDS, sectorSubtitle, statusTone } from '/assets/js/hub.js';

const $ = (id) => document.getElementById(id);
const form = $('project-form');
const dialog = $('project-dialog');
const filterForm = $('filter-form');
const editorStatus = $('editor-status');
const listStatus = $('list-status');
const initialClient = new URLSearchParams(location.search).get('client_id') ?? '';
const state = { page: 1, pageSize: 12, q: '', status: '', sector: '', client_id: initialClient, sort: '-updated_at' };
let editing = null;
let workspaces = [];
let canEdit = false;

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

/** Fills the editor sheet for a new project (null) or an existing one, then opens it. */
function openEditor(project, etag) {
  editing = project ? { id: project.id, etag } : null;
  showStatus(editorStatus, '');
  $('editor-heading').textContent = project ? `Edit “${project.name}”` : 'Start a new project';
  $('submit-project').textContent = project ? 'Save changes' : 'Create project';
  $('template-field').hidden = Boolean(project);
  form.reset();
  form.elements.client_id.disabled = Boolean(project);
  const clientId = project?.client_id ?? (manageable().some((item) => item.client_id === state.client_id) ? state.client_id : manageable()[0]?.client_id);
  form.elements.client_id.value = clientId;
  form.elements.sector.value = project?.sector ?? sectorOf(clientId);
  renderProfileFields(form.elements.sector.value, project?.sector_profile ?? {});
  if (project) {
    form.elements.name.value = project.name;
    form.elements.status.value = project.status;
    form.elements.summary.value = project.summary ?? '';
    form.elements.start_date.value = project.start_date ?? '';
    form.elements.end_date.value = project.end_date ?? '';
    form.elements.tags.value = project.tags.join(', ');
  }
  openDialog(dialog, { initialFocus: form.elements.name });
}

form.elements.client_id.addEventListener('change', () => {
  form.elements.sector.value = sectorOf(form.elements.client_id.value);
  renderProfileFields(form.elements.sector.value);
});
form.elements.sector.addEventListener('change', () => renderProfileFields(form.elements.sector.value));

handleSubmit(form, editorStatus, async (values) => {
  const payload = toPayload(values);
  let message;
  if (editing) {
    try {
      await api(`/projects/${encodeURIComponent(editing.id)}`, { method: 'PATCH', body: payload, headers: editing.etag ? { 'If-Match': editing.etag } : {} });
    } catch (error) {
      if (error.code === 'PRECONDITION_FAILED') throw new ApiError(412, error.code, 'This project was changed elsewhere. Reopen it to load the latest version.');
      throw error;
    }
    message = `Saved “${payload.name}”.`;
  } else {
    await api('/projects', { method: 'POST', body: { ...payload, client_id: form.elements.client_id.value, use_template: values.use_template === 'on' } });
    message = `Project “${payload.name}” created.`;
  }
  closeDialog(dialog, 'saved');
  editing = null;
  await load();
  showStatus(listStatus, message, 'success');
});

$('new-project').addEventListener('click', () => openEditor(null));

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
  if (project.can_edit && canEdit) {
    const edit = h('button', { type: 'button', className: 'button button-secondary button-small', text: 'Edit' });
    const remove = h('button', { type: 'button', className: 'button button-danger button-small', text: 'Delete' });
    bindAction(edit, listStatus, async () => {
      const { data, headers } = await api(`/projects/${encodeURIComponent(project.id)}`, { withHeaders: true });
      openEditor(data, headers.get('ETag'));
    });
    bindAction(remove, listStatus, async () => {
      const confirmed = await confirmDialog({
        title: `Delete “${project.name}”?`,
        message: 'The project is hidden from everyone in the workspace. You can restore it for 30 days.',
        confirmLabel: 'Delete project',
        danger: true
      });
      if (!confirmed) return;
      await api(`/projects/${encodeURIComponent(project.id)}`, { method: 'DELETE' });
      await load();
      showUndo(project);
    });
    actions.push(edit, remove);
  }
  const progress = milestoneProgress(project);
  const dates = [project.start_date, project.end_date].some(Boolean) ? `${formatDay(project.start_date) || '…'} → ${formatDay(project.end_date) || '…'}` : null;
  return h('li', {}, h('article', { className: 'hub-card' },
    h('span', { className: 'card-meta' }, badge(PROJECT_STATUS[project.status] ?? project.status, statusTone(project.status)), workspace && badge(workspace.client_name, 'purple')),
    h('h3', { text: project.name }),
    h('span', { className: 'hint', text: sectorSubtitle(project) }),
    project.summary && h('p', { text: project.summary }),
    project.tags.length > 0 && h('span', { className: 'card-meta' }, project.tags.map((tag) => badge(`#${tag}`, 'muted'))),
    progress.total > 0 && progressBar(progress, `${progress.done} of ${progress.total} milestones complete`),
    h('span', { className: 'card-foot' },
      h('span', { text: progress.total ? `${progress.done}/${progress.total} milestones` : 'No milestones yet' }),
      dates && h('span', { text: dates })),
    h('div', { className: 'row-actions' }, actions)));
}

async function load() {
  const params = new URLSearchParams({ page: state.page, page_size: state.pageSize, sort: state.sort });
  for (const key of ['q', 'status', 'sector', 'client_id']) if (state[key]) params.set(key, state[key]);
  const result = await api(`/projects?${params}`);
  const pages = Math.max(1, Math.ceil(result.total / result.page_size));
  const filtered = Boolean(state.q || state.status || state.sector || state.client_id);
  $('filter-reset').hidden = !filtered;
  $('project-list').replaceChildren(...(result.items.length
    ? result.items.map(renderCard)
    : [h('li', { className: 'empty-state' },
      h('p', { text: filtered ? 'No projects match these filters.' : 'No projects yet.' }),
      !filtered && canEdit && h('button', { type: 'button', className: 'button button-primary button-small', text: 'Start your first project', onclick: () => openEditor(null) }))]));
  $('list-summary').textContent = `${result.total} ${result.total === 1 ? 'project' : 'projects'}`;
  $('page-info').textContent = `Page ${result.page} of ${pages}`;
  $('prev-page').disabled = result.page <= 1;
  $('next-page').disabled = result.page >= pages;
}

// Filters apply as you type or change a control; controls stay enabled so focus is never lost.
let searchTimer;
async function applyFilters() {
  const { q, status, sector, client_id: clientId, sort } = Object.fromEntries(new FormData(filterForm));
  Object.assign(state, { page: 1, q: q.trim(), status, sector, client_id: clientId, sort });
  showStatus(listStatus, '');
  try {
    await load();
  } catch (error) {
    showStatus(listStatus, describeError(error));
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
$('filter-reset').addEventListener('click', () => {
  filterForm.reset();
  filterForm.elements.client_id.value = '';
  applyFilters();
});

bindAction($('prev-page'), listStatus, async () => { state.page -= 1; await load(); });
bindAction($('next-page'), listStatus, async () => { state.page += 1; await load(); });

async function main() {
  setupDialogs();
  await requireUser();
  const user = await getCurrentUser();
  workspaces = await loadWorkspaces(user);
  const filter = filterForm.elements.client_id;
  filter.append(...workspaces.map((item) => h('option', { value: item.client_id, text: item.client_name, selected: item.client_id === initialClient })));
  const editable = manageable();
  if (editable.length) {
    form.elements.client_id.replaceChildren(...editable.map((item) => h('option', { value: item.client_id, text: item.client_name })));
    if (user.email_verified) {
      canEdit = true;
      $('new-project').hidden = false;
    } else {
      showStatus($('page-status'), 'Verify your email address to create and edit projects.', 'info');
    }
  }
  if (!workspaces.length) {
    showStatus($('page-status'), 'You are not part of a workspace yet, so there are no projects to show.', 'info');
  }
  await load();
  // The site footer links to /projects/#project-form: open the editor straight away.
  if (canEdit && ['#project-form', '#new'].includes(location.hash)) openEditor(null);
}

main().catch((error) => showStatus($('page-status'), describeError(error)));
