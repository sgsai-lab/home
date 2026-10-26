import { api, ApiError, describeError, getCurrentUser, h, requireUser, showStatus } from '/assets/js/auth.js';
import {
  assetUrl, badge, chooseWorkspace, formatDay, initials, launchLink, loadWorkspaces,
  PRODUCT_KIND, PRODUCT_STATUS, PROJECT_STATUS, ROLE, SECTOR, sectorSubtitle, statusTone
} from '/assets/js/hub.js';
import { setupInstallPrompt } from '/assets/js/pwa.js';

const $ = (id) => document.getElementById(id);
const SNAPSHOT_KEY = 'sgsai.workspace.snapshot';
const canManage = (role) => role === 'owner' || role === 'admin';

function emptyState(text, action) {
  return h('li', { className: 'empty-state' }, h('p', { text }), action);
}

async function iconFor(product) {
  const icon = h('span', { className: 'app-icon', 'aria-hidden': 'true', text: initials(product.name) });
  if (product.icon_asset_id && navigator.onLine) {
    assetUrl(product.icon_asset_id)
      .then((url) => icon.replaceChildren(h('img', { src: url, alt: '' })))
      .catch(() => {});
  }
  return icon;
}

async function renderApps(products) {
  const visible = products.filter((product) => product.status !== 'planned');
  if (!visible.length) {
    $('app-list').replaceChildren(emptyState('Your apps will appear here as soon as SGS AI Technology makes them available.'));
    return;
  }
  const tiles = await Promise.all(visible.map(async (product) => h('li', {}, launchLink(product, [
    await iconFor(product),
    h('span', {},
      h('strong', { text: product.name }),
      h('span', { className: 'hint', text: product.summary ?? PRODUCT_KIND[product.kind] }),
      h('span', { className: 'card-meta' }, badge(PRODUCT_STATUS[product.status], statusTone(product.status)), badge(PRODUCT_KIND[product.kind])))
  ]))));
  $('app-list').replaceChildren(...tiles);
}

function renderProjects(projects) {
  if (!projects.length) {
    $('project-list').replaceChildren(emptyState('Your SGS AI Technology team will add your first project here.', h('a', { className: 'button button-secondary button-small', href: '/contact/', text: 'Contact us' })));
    return;
  }
  $('project-list').replaceChildren(...projects.map((project) => {
    const next = project.milestones.find((milestone) => !milestone.done);
    return h('li', {}, h('a', { className: 'hub-card', href: `/workspace/project/?id=${encodeURIComponent(project.id)}` },
      h('span', { className: 'card-meta' }, badge(PROJECT_STATUS[project.status], statusTone(project.status)), h('span', { text: sectorSubtitle(project) })),
      h('h3', { text: project.name }),
      project.summary && h('p', { text: project.summary }),
      next && h('span', { className: 'card-meta', text: `Next: ${next.title}${next.due ? ` · ${formatDay(next.due)}` : ''}` })));
  }));
}

function renderTeam(members) {
  $('team-list').replaceChildren(...members.map((member) => h('li', {},
    h('span', { className: 'avatar', 'aria-hidden': 'true', text: initials(member.full_name) }),
    h('span', {}, h('strong', { text: member.full_name }), h('span', { className: 'hint', text: ` · ${ROLE[member.role]}` })))));
}

function renderHeader(client, role) {
  $('client-name').textContent = client.name;
  $('client-meta').textContent = [SECTOR[client.primary_sector], ROLE[role] ? `You are ${ROLE[role].toLowerCase()}` : null].filter(Boolean).join(' · ');
  const logo = $('client-logo');
  logo.replaceChildren(initials(client.name));
  if (client.branding?.logo_asset_id && navigator.onLine) {
    assetUrl(client.branding.logo_asset_id).then((url) => logo.replaceChildren(h('img', { src: url, alt: '' }))).catch(() => {});
  }
  $('manage-link').hidden = !canManage(role);
  $('manage-link').href = `/admin/clients/?id=${encodeURIComponent(client.id)}`;
  $('projects-manage').hidden = !canManage(role);
  $('projects-manage').href = `/projects/?client_id=${encodeURIComponent(client.id)}`;
  document.title = `${client.name} — SGS AI Technology`;
}

async function renderWorkspace(clientId) {
  const [client, projects, products, members] = await Promise.all([
    api(`/clients/${encodeURIComponent(clientId)}`),
    api(`/projects?client_id=${encodeURIComponent(clientId)}&page_size=50&sort=-updated_at`),
    api(`/products?client_id=${encodeURIComponent(clientId)}&page_size=100`),
    api(`/clients/${encodeURIComponent(clientId)}/members`)
  ]);
  renderHeader(client, client.my_role);
  renderProjects(projects.items);
  await renderApps(products.items);
  renderTeam(members.items);
  $('workspace').hidden = false;
  // Offline snapshot: names and links only (no tokens or signed URLs). Cleared on sign-out.
  localStorage.setItem(SNAPSHOT_KEY, JSON.stringify({ client, projects: projects.items, products: products.items, members: members.items, saved_at: Date.now() }));
}

async function renderSnapshot() {
  const snapshot = JSON.parse(localStorage.getItem(SNAPSHOT_KEY) ?? 'null');
  if (!snapshot) return false;
  renderHeader(snapshot.client, snapshot.client.my_role);
  renderProjects(snapshot.projects);
  await renderApps(snapshot.products);
  renderTeam(snapshot.members);
  $('switcher-field').hidden = true;
  $('workspace').hidden = false;
  $('offline-banner').hidden = false;
  return true;
}

function setupSwitcher(workspaces, current, user) {
  if (workspaces.length < 2) return;
  const select = $('client-switcher');
  select.replaceChildren(...workspaces.map((item) => h('option', { value: item.client_id, text: item.client_name, selected: item.client_id === current.client_id })));
  $('switcher-field').hidden = false;
  select.addEventListener('change', async () => {
    showStatus($('page-status'), '');
    select.disabled = true;
    try {
      await renderWorkspace(select.value);
      const url = new URL(location.href);
      url.searchParams.set('client', select.value);
      history.replaceState(null, '', url);
      if (user.default_client_id !== select.value) {
        await api('/users/me', { method: 'PATCH', body: { default_client_id: select.value } });
        user.default_client_id = select.value;
      }
    } catch (error) {
      showStatus($('page-status'), describeError(error));
    } finally {
      select.disabled = false;
    }
  });
}

async function main() {
  setupInstallPrompt($('install-banner'), $('install-app'), $('install-dismiss'));
  let user;
  try {
    user = await requireUser();
  } catch (error) {
    if (error instanceof ApiError && error.status === 0 && await renderSnapshot()) return;
    throw error;
  }
  user = await getCurrentUser();
  const workspaces = await loadWorkspaces(user);
  const current = chooseWorkspace(workspaces, user);
  if (!current) {
    $('no-workspace').hidden = false;
    return;
  }
  setupSwitcher(workspaces, current, user);
  await renderWorkspace(current.client_id);
}

main().catch(async (error) => {
  if (error instanceof ApiError && error.status === 0 && await renderSnapshot()) return;
  showStatus($('page-status'), describeError(error));
});
