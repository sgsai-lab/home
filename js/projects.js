import { api, ApiError, bindAction, describeError, h, handleSubmit, requireUser, showStatus } from '/js/auth.js';

const $ = (id) => document.getElementById(id);
const form = $('project-form');
const editorStatus = $('editor-status');
const listStatus = $('list-status');
const STATUS_LABELS = { draft: 'Draft', active: 'Active', on_hold: 'On hold', completed: 'Completed', archived: 'Archived' };
const state = { page: 1, pageSize: 10, q: '', status: '', tag: '', sort: '-created_at' };
let editing = null;

function toPayload(values) {
  const tags = values.tags.split(',').map((tag) => tag.trim().toLowerCase()).filter(Boolean);
  const payload = {
    name: values.name.trim(),
    description: values.description.trim() || null,
    status: values.status,
    tags: [...new Set(tags)],
    start_date: values.start_date || null,
    end_date: values.end_date || null
  };
  if (!payload.name) throw new ApiError(0, 'CLIENT', 'Enter a project name.');
  if (payload.tags.length > 20) throw new ApiError(0, 'CLIENT', 'Use at most 20 tags.');
  if (payload.tags.some((tag) => tag.length > 32)) throw new ApiError(0, 'CLIENT', 'Each tag can be at most 32 characters.');
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
  form.reset();
  if (!project) return;
  form.elements.name.value = project.name;
  form.elements.status.value = project.status;
  form.elements.description.value = project.description ?? '';
  form.elements.start_date.value = project.start_date ?? '';
  form.elements.end_date.value = project.end_date ?? '';
  form.elements.tags.value = project.tags.join(', ');
  form.scrollIntoView({ behavior: 'smooth', block: 'start' });
  form.elements.name.focus({ preventScroll: true });
}

handleSubmit(form, editorStatus, async (values) => {
  const payload = toPayload(values);
  if (editing) {
    try {
      await api(`/projects/${encodeURIComponent(editing.id)}`, {
        method: 'PATCH',
        body: payload,
        headers: editing.etag ? { 'If-Match': editing.etag } : {}
      });
    } catch (error) {
      if (error.code === 'PRECONDITION_FAILED') {
        throw new ApiError(412, error.code, 'This project was changed elsewhere. Reopen it to load the latest version.');
      }
      throw error;
    }
    showStatus(editorStatus, `Saved “${payload.name}”.`, 'success');
  } else {
    await api('/projects', { method: 'POST', body: payload });
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

  const dates = [project.start_date, project.end_date].some(Boolean)
    ? `${project.start_date ?? '…'} → ${project.end_date ?? '…'}`
    : null;
  return h('li', { className: 'project-card' },
    h('h3', { text: project.name }),
    h('div', { className: 'project-meta' },
      h('span', { className: 'badge', text: STATUS_LABELS[project.status] ?? project.status }),
      project.tags.map((tag) => h('span', { className: 'badge badge-success', text: `#${tag}` })),
      dates && h('span', { text: dates }),
      h('span', { text: `Updated ${new Date(project.updated_at).toLocaleDateString()}` })),
    project.description && h('p', { className: 'hint', text: project.description }),
    h('div', { className: 'row-actions' }, edit, remove));
}

async function load() {
  const params = new URLSearchParams({ page: state.page, page_size: state.pageSize, sort: state.sort });
  for (const key of ['q', 'status', 'tag']) if (state[key]) params.set(key, state[key]);
  const result = await api(`/projects?${params}`);
  const pages = Math.max(1, Math.ceil(result.total / result.page_size));
  $('project-list').replaceChildren(...(result.items.length
    ? result.items.map(renderCard)
    : [h('li', { className: 'empty', text: state.q || state.status || state.tag ? 'No projects match these filters.' : 'No projects yet. Start your first one above.' })]));
  $('page-info').textContent = `Page ${result.page} of ${pages} · ${result.total} projects`;
  $('prev-page').disabled = result.page <= 1;
  $('next-page').disabled = result.page >= pages;
}

handleSubmit($('filter-form'), listStatus, async ({ q, status, tag, sort }) => {
  Object.assign(state, { page: 1, q: q.trim(), status, tag: tag.trim().toLowerCase(), sort });
  await load();
});

bindAction($('prev-page'), listStatus, async () => { state.page -= 1; await load(); });
bindAction($('next-page'), listStatus, async () => { state.page += 1; await load(); });

async function main() {
  const user = await requireUser();
  if (!user.email_verified) {
    $('verify-banner').hidden = false;
    form.querySelectorAll('input, select, textarea, button').forEach((control) => { control.disabled = true; });
  }
  if (location.hash === '#project-form' && user.email_verified) {
    form.scrollIntoView({ behavior: 'smooth', block: 'start' });
    form.elements.name.focus({ preventScroll: true });
  }
  await load();
}

main().catch((error) => showStatus($('page-status'), describeError(error)));
