// Shared helpers for the client hub pages (workspace, project detail, admin consoles).
import { api, h } from '/assets/js/auth.js';

export const PROJECT_STATUS = {
  draft: 'Draft', discovery: 'Discovery', in_progress: 'In progress', on_hold: 'On hold', delivered: 'Delivered', archived: 'Archived'
};
export const PRODUCT_STATUS = { planned: 'Planned', beta: 'Beta', live: 'Live', retired: 'Retired' };
export const PRODUCT_KIND = { pwa: 'Web app (PWA)', web: 'Website', android: 'Android app', ios: 'iOS app', service: 'Service' };
export const SECTOR = { business: 'Business', education: 'Education' };
export const ROLE = { owner: 'Owner', admin: 'Admin', member: 'Member', viewer: 'Viewer' };
export const ROLE_HELP = {
  owner: 'Full control, including other owners',
  admin: 'Manages projects, apps and people',
  member: 'Opens apps and follows projects',
  viewer: 'Read-only access'
};

export const SECTOR_FIELDS = {
  business: [
    { name: 'engagement_type', label: 'Engagement type', options: { advisory: 'Advisory', build: 'Build', managed_service: 'Managed service' } },
    { name: 'department', label: 'Department', max: 120 }
  ],
  education: [
    { name: 'institution_type', label: 'Institution type', options: { school: 'School', college: 'College', university: 'University', training: 'Training provider' } },
    { name: 'programme', label: 'Programme', max: 120 },
    { name: 'cohort', label: 'Cohort', max: 60 },
    { name: 'academic_year', label: 'Academic year', max: 20, placeholder: '2026/27' }
  ]
};

export function sectorSubtitle(project) {
  const profile = project.sector_profile ?? {};
  const fields = SECTOR_FIELDS[project.sector] ?? [];
  const parts = fields.map((field) => (field.options ? field.options[profile[field.name]] : profile[field.name])).filter(Boolean);
  return [SECTOR[project.sector], ...parts].filter(Boolean).join(' · ');
}

export function badge(text, tone = '') {
  return h('span', { className: `badge${tone ? ` badge-${tone}` : ''}`, text });
}

export function statusTone(status) {
  return { live: 'success', delivered: 'success', in_progress: 'info', beta: 'info', on_hold: 'warning', retired: 'muted', archived: 'muted' }[status] ?? '';
}

/** Workspaces the user can open: SGS admins see every client. */
export async function loadWorkspaces(user) {
  if (user.role !== 'admin') return user.memberships ?? [];
  const { items } = await api('/clients?page_size=50&sort=name');
  return items.map((client) => ({ client_id: client.id, client_name: client.name, primary_sector: client.primary_sector, role: 'owner' }));
}

export function chooseWorkspace(workspaces, user) {
  const requested = new URLSearchParams(location.search).get('client');
  return workspaces.find((item) => item.client_id === requested)
    ?? workspaces.find((item) => item.client_id === user.default_client_id)
    ?? workspaces[0]
    ?? null;
}

const signedUrls = new Map();

/** Short-lived signed read URL for an asset, cached until shortly before it expires. */
export async function assetUrl(assetId) {
  const cached = signedUrls.get(assetId);
  if (cached && cached.expires > Date.now()) return cached.url;
  const { url, expires_in: ttl } = await api(`/assets/${encodeURIComponent(assetId)}/url`);
  signedUrls.set(assetId, { url, expires: Date.now() + (ttl - 60) * 1000 });
  return url;
}

export function formatDay(value) {
  if (!value) return '';
  return new Date(`${value}T00:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

export function initials(name) {
  return String(name ?? '?').split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0].toUpperCase()).join('');
}

/**
 * WAI-ARIA tabs with arrow-key navigation. Tabs carrying data-hash sync with location.hash so
 * sections can be deep-linked (/admin/clients/?id=…#people). Returns { tabs, select }.
 */
export function setupTabs(tablist, { onSelect } = {}) {
  const tabs = [...tablist.querySelectorAll('[role="tab"]')];
  function select(tab, { focus = true } = {}) {
    for (const other of tabs) {
      const selected = other === tab;
      other.setAttribute('aria-selected', String(selected));
      other.tabIndex = selected ? 0 : -1;
      const panel = document.getElementById(other.getAttribute('aria-controls'));
      if (panel) panel.hidden = !selected;
    }
    if (focus) tab.focus();
    // On narrow screens the tablist scrolls horizontally; keep the active tab visible.
    tab.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    if (tab.dataset.hash) history.replaceState(null, '', `${location.pathname}${location.search}#${tab.dataset.hash}`);
    onSelect?.(tab);
  }
  tabs.forEach((tab, index) => {
    tab.addEventListener('click', () => select(tab));
    tab.addEventListener('keydown', (event) => {
      const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
      if (step) {
        event.preventDefault();
        select(tabs[(index + step + tabs.length) % tabs.length]);
      }
      if (event.key === 'Home') select(tabs[0]);
      if (event.key === 'End') select(tabs.at(-1));
    });
  });
  const fromHash = tabs.find((tab) => tab.dataset.hash && `#${tab.dataset.hash}` === location.hash);
  select(fromHash ?? tabs.find((tab) => tab.getAttribute('aria-selected') === 'true') ?? tabs[0], { focus: false });
  return { tabs, select };
}

/** Progress of a project's milestones as { done, total, percent }. */
export function milestoneProgress(project) {
  const total = project.milestones?.length ?? 0;
  const done = project.milestones?.filter((milestone) => milestone.done).length ?? 0;
  return { done, total, percent: total ? Math.round((done / total) * 100) : 0 };
}

/** Thin progress bar with an accessible label. */
export function progressBar(progress, label) {
  const bar = h('span', { className: 'progress', role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': progress.percent, 'aria-label': label },
    h('span', { className: 'progress-value' }));
  bar.firstChild.style.setProperty('--progress', `${progress.percent}%`);
  return bar;
}

/** Launch links open /go/{slug}; client-only apps bounce through /workspace/launch/ to get a token. */
export function launchLink(product, children) {
  const retired = product.status === 'retired';
  return h(retired ? 'span' : 'a', {
    className: `app-tile${retired ? ' is-retired' : ''}`,
    ...(retired ? { 'aria-disabled': 'true' } : { href: `/go/${encodeURIComponent(product.slug)}`, target: '_blank', rel: 'noopener' }),
    'aria-label': retired ? `${product.name} (retired)` : `Open ${product.name} in a new tab`
  }, children);
}
