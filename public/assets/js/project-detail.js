import { api, ApiError, bindAction, describeError, h, requireUser, showStatus } from '/assets/js/auth.js';
import { assetUrl, badge, formatDay, initials, launchLink, milestoneProgress, PRODUCT_KIND, PRODUCT_STATUS, progressBar, PROJECT_STATUS, ROLE, sectorSubtitle, statusTone } from '/assets/js/hub.js';
import { confirmDialog } from '/assets/js/dialog.js';
import { createUploader } from '/assets/js/upload.js';

const $ = (id) => document.getElementById(id);
const projectId = new URLSearchParams(location.search).get('id');
let project;
let etag;

const today = new Date().toISOString().slice(0, 10);

function renderMilestones() {
  const list = $('milestone-list');
  const progress = milestoneProgress(project);
  $('milestone-summary').textContent = progress.total ? `${progress.done} of ${progress.total} complete` : '';
  $('milestone-progress').replaceChildren(progress.total ? progressBar(progress, `${progress.done} of ${progress.total} milestones complete`) : '');
  if (!project.milestones.length) {
    list.replaceChildren(h('li', { className: 'hint', text: 'No milestones yet.' }));
    return;
  }
  list.replaceChildren(...project.milestones.map((milestone, index) => {
    const overdue = !milestone.done && milestone.due && milestone.due < today;
    const id = `milestone-${index}`;
    const check = h('input', { type: 'checkbox', id, checked: milestone.done, disabled: !project.can_edit });
    check.addEventListener('change', () => toggle(index, check));
    return h('li', { className: `${milestone.done ? 'is-done' : ''}${overdue ? ' is-overdue' : ''}`.trim() || null },
      check,
      h('label', { for: id }, h('span', { text: milestone.title })),
      h('span', { className: 'due', text: milestone.due ? `${overdue ? 'Overdue · ' : ''}${formatDay(milestone.due)}` : '' }));
  }));
}

async function toggle(index, checkbox) {
  showStatus($('milestone-status'), '');
  const milestones = project.milestones.map((milestone, position) => (position === index ? { ...milestone, done: checkbox.checked } : milestone));
  checkbox.disabled = true;
  try {
    const { data, headers } = await api(`/projects/${encodeURIComponent(project.id)}`, {
      method: 'PATCH', body: { milestones }, headers: { 'If-Match': etag }, withHeaders: true
    });
    project = data;
    etag = headers.get('ETag');
    renderMilestones();
  } catch (error) {
    checkbox.checked = !checkbox.checked;
    if (error.code === 'PRECONDITION_FAILED') {
      showStatus($('milestone-status'), 'Someone else updated this project. The latest version has been loaded.', 'info');
      await loadProject();
    } else {
      showStatus($('milestone-status'), describeError(error));
    }
  } finally {
    checkbox.disabled = !project.can_edit;
  }
}

async function renderApps() {
  const { items } = await api(`/products?client_id=${encodeURIComponent(project.client_id)}&project_id=${encodeURIComponent(project.id)}&page_size=100`);
  if (!items.length) {
    $('app-list').replaceChildren(h('li', { className: 'empty-state', text: 'No apps are linked to this project yet.' }));
    return;
  }
  $('app-list').replaceChildren(...items.map((product) => {
    const meta = h('span', { className: 'card-meta' }, badge(PRODUCT_STATUS[product.status], statusTone(product.status)), badge(PRODUCT_KIND[product.kind]));
    const icon = h('span', { className: 'app-icon', 'aria-hidden': 'true', text: initials(product.name) });
    return h('li', {}, launchLink(product, [icon, h('span', {}, h('strong', { text: product.name }), meta)]));
  }));
}

async function renderDeliverables() {
  const { items } = await api(`/assets?owner_type=project&owner_id=${encodeURIComponent(project.id)}&purpose=deliverable`);
  $('deliverable-list').replaceChildren(...(items.length ? items.map((asset) => {
    const download = h('button', { type: 'button', className: 'button button-secondary button-small', text: 'Download' });
    bindAction(download, $('deliverable-status'), async () => {
      location.assign(await assetUrl(asset.id));
    });
    const actions = [download];
    if (project.can_edit) {
      const remove = h('button', { type: 'button', className: 'button button-danger button-small', text: 'Delete' });
      bindAction(remove, $('deliverable-status'), async () => {
        const confirmed = await confirmDialog({ title: `Delete ${asset.filename}?`, message: 'The file is removed for everyone in the workspace.', confirmLabel: 'Delete file', danger: true });
        if (!confirmed) return;
        await api(`/assets/${encodeURIComponent(asset.id)}`, { method: 'DELETE' });
        await renderDeliverables();
      });
      actions.push(remove);
    }
    return h('li', {},
      h('span', { className: 'avatar', 'aria-hidden': 'true', text: asset.kind[0].toUpperCase() }),
      h('span', {}, h('strong', { text: asset.filename }), h('span', { className: 'hint', text: ` · ${(asset.size_bytes / 1024 / 1024).toFixed(1)} MB` })),
      h('span', { className: 'row-actions' }, actions));
  }) : [h('li', { className: 'hint', text: 'Deliverables shared by SGS AI Technology will appear here.' })]));
}

async function renderTeam() {
  const { items } = await api(`/clients/${encodeURIComponent(project.client_id)}/members`);
  $('team-list').replaceChildren(...items.map((member) => h('li', {},
    h('span', { className: 'avatar', 'aria-hidden': 'true', text: initials(member.full_name) }),
    h('span', {}, h('strong', { text: member.full_name }), h('br'), h('span', { className: 'hint', text: ROLE[member.role] })))));
}

function renderHeader() {
  $('project-name').textContent = project.name;
  document.title = `${project.name} — SGS AI Technology`;
  $('project-sector').textContent = sectorSubtitle(project);
  $('project-summary').textContent = project.summary ?? '';
  $('project-dates').textContent = [project.start_date && `Started ${formatDay(project.start_date)}`, project.end_date && `Target ${formatDay(project.end_date)}`].filter(Boolean).join(' · ');
  $('project-badges').replaceChildren(badge(PROJECT_STATUS[project.status], statusTone(project.status)), ...project.tags.map((tag) => badge(`#${tag}`)));
  $('back-link').href = `/workspace/?client=${encodeURIComponent(project.client_id)}`;
  const cover = $('project-cover');
  cover.replaceChildren();
  if (project.cover_asset_id) {
    // Decorative: the project name and summary carry the meaning.
    assetUrl(project.cover_asset_id).then((url) => cover.replaceChildren(h('img', { className: 'project-cover', src: url, alt: '' }))).catch(() => {});
  }
}

async function loadProject() {
  const result = await api(`/projects/${encodeURIComponent(projectId)}`, { withHeaders: true });
  project = result.data;
  etag = result.headers.get('ETag');
  renderHeader();
  renderMilestones();
}

async function main() {
  if (!projectId) throw new ApiError(404, 'NOT_FOUND', 'No project was selected.');
  await requireUser();
  await loadProject();
  $('project').hidden = false;
  await Promise.all([renderApps(), renderDeliverables(), renderTeam()]);
  if (project.can_edit) {
    $('deliverable-upload').replaceChildren(createUploader({
      owner: { type: 'project', id: project.id }, purpose: 'deliverable', kinds: ['document', 'image', 'video'], label: 'Share a deliverable', onUploaded: renderDeliverables
    }));
    $('cover-upload').replaceChildren(createUploader({
      owner: { type: 'project', id: project.id }, purpose: 'cover', kinds: ['image'], label: 'Upload a cover image', requireAlt: true,
      onUploaded: async () => {
        await loadProject();
      }
    }));
    $('cover-panel').hidden = false;
  }
}

main().catch((error) => {
  const message = error.status === 404 || error.status === 403
    ? 'This project was not found, or you do not have access to it.'
    : describeError(error);
  showStatus($('page-status'), message);
});
