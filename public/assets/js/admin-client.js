import { api, ApiError, bindAction, describeError, formatDate, getCurrentUser, h, handleSubmit, requireUser, showStatus } from '/assets/js/auth.js';
import { closeDialog, confirmDialog, openDialog, setupDialogs } from '/assets/js/dialog.js';
import { assetUrl, badge, initials, PRODUCT_KIND, PRODUCT_STATUS, ROLE, ROLE_HELP, SECTOR, setupTabs, statusTone } from '/assets/js/hub.js';
import { createUploader } from '/assets/js/upload.js';

const $ = (id) => document.getElementById(id);
const clientId = new URLSearchParams(location.search).get('id');
const base = `/clients/${encodeURIComponent(clientId ?? '')}`;
let me;
let client;
let editingProduct = null;

// --- Side navigation ----------------------------------------------------------------------
setupDialogs();
setupTabs(document.querySelector('.hub-sidenav'), {
  onSelect: (tab) => {
    if (tab.id === 'tab-activity' && client) loadActivityOnce();
  }
});
const canManage = () => client.my_role === 'owner' || client.my_role === 'admin';

// --- Overview ---------------------------------------------------------------------------
function renderLogo() {
  const targets = [$('logo-preview'), $('client-logo')];
  targets.forEach((target) => target.replaceChildren(initials(client.name)));
  if (client.branding?.logo_asset_id) {
    assetUrl(client.branding.logo_asset_id).then((url) => targets.forEach((target) => target.replaceChildren(h('img', { src: url, alt: '' })))).catch(() => {});
  }
}

function renderOverview() {
  const form = $('client-form');
  $('client-title').textContent = client.name;
  $('client-subtitle').textContent = [SECTOR[client.primary_sector], client.contact?.email].filter(Boolean).join(' · ');
  document.title = `${client.name} — Manage workspace`;
  form.elements.name.value = client.name;
  form.elements.primary_sector.value = client.primary_sector;
  form.elements.contact_email.value = client.contact?.email ?? '';
  form.elements.contact_phone.value = client.contact?.phone ?? '';
  form.elements.contact_website.value = client.contact?.website ?? '';
  form.elements.primary_color.value = client.branding?.primary_color ?? '#7538c4';
  form.elements.status.value = client.status;
  $('status-field').hidden = me.role !== 'admin';
  $('projects-link').href = `/projects/?client_id=${encodeURIComponent(client.id)}`;
  $('workspace-link').href = `/workspace/?client=${encodeURIComponent(client.id)}`;
  $('back-link').href = `/workspace/?client=${encodeURIComponent(client.id)}`;
  renderLogo();
}

handleSubmit($('client-form'), $('client-status'), async (values) => {
  const body = {
    name: values.name.trim(),
    primary_sector: values.primary_sector,
    contact: { email: values.contact_email.trim() || null, phone: values.contact_phone.trim() || null, website: values.contact_website.trim() || null },
    branding: { primary_color: values.primary_color }
  };
  if (!body.contact.email) delete body.contact.email;
  if (me.role === 'admin') body.status = values.status;
  client = { ...client, ...await api(base, { method: 'PATCH', body }) };
  renderOverview();
  showStatus($('client-status'), 'Workspace details saved.', 'success');
});

// --- People -----------------------------------------------------------------------------
function roleSelect(value, disabled) {
  return h('select', { 'aria-label': 'Role', disabled }, Object.entries(ROLE).map(([role, label]) => h('option', { value: role, text: label, title: ROLE_HELP[role], selected: role === value })));
}

async function loadMembers() {
  const { items } = await api(`${base}/members`);
  $('people-count').textContent = String(items.length);
  $('people-count').hidden = false;
  $('member-body').replaceChildren(...items.map((member) => {
    const self = member.user_id === me.id;
    const locked = !canManage() || (member.role === 'owner' && client.my_role !== 'owner');
    const select = roleSelect(member.role, locked);
    const remove = h('button', { type: 'button', className: 'button button-danger button-small', text: self ? 'Leave' : 'Remove', disabled: !self && !canManage() });
    // Role changes save as soon as a new role is picked.
    select.addEventListener('change', async () => {
      showStatus($('members-status'), '');
      select.disabled = true;
      try {
        await api(`${base}/members/${encodeURIComponent(member.user_id)}`, { method: 'PATCH', body: { role: select.value } });
        showStatus($('members-status'), `${member.full_name} is now ${ROLE[select.value].toLowerCase()}.`, 'success');
        await loadMembers();
      } catch (error) {
        select.value = member.role;
        select.disabled = locked;
        showStatus($('members-status'), describeError(error));
      }
    });
    bindAction(remove, $('members-status'), async () => {
      const confirmed = await confirmDialog({
        title: self ? `Leave ${client.name}?` : `Remove ${member.full_name}?`,
        message: self ? 'You lose access to this workspace, its projects and apps.' : `${member.full_name} loses access to ${client.name}, its projects and apps.`,
        confirmLabel: self ? 'Leave workspace' : 'Remove member',
        danger: true
      });
      if (!confirmed) return;
      await api(`${base}/members/${encodeURIComponent(member.user_id)}`, { method: 'DELETE' });
      if (self) {
        location.assign('/workspace/');
        return;
      }
      await loadMembers();
    });
    return h('tr', {},
      h('td', {}, h('span', { className: 'cell-person' },
        h('span', { className: 'avatar', 'aria-hidden': 'true', text: initials(member.full_name) }),
        h('span', { className: 'cell-primary' },
          h('strong', { text: self ? `${member.full_name} (you)` : member.full_name }),
          h('span', { className: 'hint', text: member.email })))),
      h('td', {}, select),
      h('td', {}, h('div', { className: 'row-actions' }, remove)));
  }));
}

async function loadInvites() {
  if (!canManage()) {
    $('invite-list').replaceChildren(h('li', { className: 'hint', text: 'Only workspace admins can invite people.' }));
    return;
  }
  $('invite-open').hidden = false;
  const { items } = await api(`${base}/invites`);
  $('invite-list').replaceChildren(...(items.length ? items.map((invite) => {
    const resend = h('button', { type: 'button', className: 'button button-secondary button-small', text: 'Resend' });
    const revoke = h('button', { type: 'button', className: 'button button-danger button-small', text: 'Revoke' });
    bindAction(resend, $('invite-status'), async () => {
      await api(`${base}/invites/${encodeURIComponent(invite.id)}/resend`, { method: 'POST' });
      showStatus($('invite-status'), `A new invitation was sent to ${invite.email}. The previous link no longer works.`, 'success');
      await loadInvites();
    });
    bindAction(revoke, $('invite-status'), async () => {
      await api(`${base}/invites/${encodeURIComponent(invite.id)}`, { method: 'DELETE' });
      await loadInvites();
    });
    return h('li', {},
      h('span', { className: 'avatar', 'aria-hidden': 'true', text: initials(invite.email) }),
      h('span', {}, h('strong', { text: invite.email }), h('span', { className: 'hint', text: ` · ${ROLE[invite.role]} · expires ${formatDate(invite.expires_at)}` })),
      h('span', { className: 'row-actions' }, resend, revoke));
  }) : [h('li', { className: 'hint', text: 'No pending invitations.' })]));
}

$('invite-open').addEventListener('click', () => {
  $('invite-form').reset();
  showStatus($('invite-form-status'), '');
  openDialog($('invite-dialog'));
});

handleSubmit($('invite-form'), $('invite-form-status'), async ({ email, role }) => {
  if (!email.trim()) throw new ApiError(0, 'CLIENT', 'Enter an email address.');
  const invite = await api(`${base}/invites`, { method: 'POST', body: { email: email.trim(), role } });
  closeDialog($('invite-dialog'), 'saved');
  await loadInvites();
  showStatus($('invite-status'), invite.email_sent ? `Invitation sent to ${invite.email}.` : `Invitation created for ${invite.email}, but the email could not be sent. Try resending.`, invite.email_sent ? 'success' : 'error');
});

// --- Apps -------------------------------------------------------------------------------
const productForm = $('product-form');

function productPayload(values) {
  const body = {
    name: values.name.trim(),
    kind: values.kind,
    summary: values.summary.trim() || null,
    launch_url: values.launch_url.trim() || null,
    store_urls: Object.fromEntries([['android', values.android.trim()], ['ios', values.ios.trim()]].filter(([, url]) => url)),
    status: values.status,
    project_id: values.project_id || null
  };
  if (values.slug.trim()) body.slug = values.slug.trim().toLowerCase();
  if (me.role === 'admin') body.visibility = values.visibility;
  if (!body.name) throw new ApiError(0, 'CLIENT', 'Enter a name.');
  return body;
}

function editProduct(product) {
  editingProduct = product;
  productForm.reset();
  showStatus($('product-status'), '');
  $('product-heading').textContent = product ? `Edit ${product.name}` : 'Add an app or service';
  $('product-submit').textContent = product ? 'Save app' : 'Add app';
  if (product) {
    for (const name of ['name', 'kind', 'status', 'visibility']) productForm.elements[name].value = product[name];
    productForm.elements.summary.value = product.summary ?? '';
    productForm.elements.launch_url.value = product.launch_url ?? '';
    productForm.elements.slug.value = product.slug;
    productForm.elements.android.value = product.store_urls.android ?? '';
    productForm.elements.ios.value = product.store_urls.ios ?? '';
    productForm.elements.project_id.value = product.project_id ?? '';
  }
  openDialog($('product-dialog'), { initialFocus: productForm.elements.name });
}

$('product-open').addEventListener('click', () => editProduct(null));

handleSubmit(productForm, $('product-status'), async (values) => {
  const body = productPayload(values);
  let message;
  if (editingProduct) {
    await api(`/products/${encodeURIComponent(editingProduct.id)}`, { method: 'PATCH', body });
    message = `${body.name} saved.`;
  } else {
    const created = await api('/products', { method: 'POST', body: { ...body, client_id: client.id } });
    message = `${created.name} added. Its link is /go/${created.slug}.`;
  }
  closeDialog($('product-dialog'), 'saved');
  editingProduct = null;
  await loadProducts();
  showStatus($('products-status'), message, 'success');
});

function productCard(product) {
  const icon = h('span', { className: 'app-icon', 'aria-hidden': 'true', text: initials(product.name) });
  if (product.icon_asset_id) assetUrl(product.icon_asset_id).then((url) => icon.replaceChildren(h('img', { src: url, alt: '' }))).catch(() => {});
  const launches = h('span', { className: 'hint' });
  api(`/products/${encodeURIComponent(product.id)}/launches`).then((stats) => { launches.textContent = `${stats.total} launches in 30 days`; }).catch(() => {});
  const link = `${location.origin}/go/${product.slug}`;
  const copy = h('button', { type: 'button', className: 'button button-secondary button-small', text: 'Copy link' });
  const edit = h('button', { type: 'button', className: 'button button-secondary button-small', text: 'Edit' });
  const remove = h('button', { type: 'button', className: 'button button-danger button-small', text: 'Delete' });
  const iconToggle = h('button', { type: 'button', className: 'link-button', text: 'Change icon' });
  const uploaderSlot = h('div', { hidden: true });
  bindAction(copy, $('products-status'), async () => {
    await navigator.clipboard.writeText(link);
    showStatus($('products-status'), `Copied ${link}`, 'success');
  });
  edit.addEventListener('click', () => editProduct(product));
  bindAction(remove, $('products-status'), async () => {
    const confirmed = await confirmDialog({
      title: `Delete ${product.name}?`,
      message: `Its /go/${product.slug} link stops working and the app disappears from the workspace.`,
      confirmLabel: 'Delete app',
      danger: true
    });
    if (!confirmed) return;
    await api(`/products/${encodeURIComponent(product.id)}`, { method: 'DELETE' });
    await loadProducts();
  });
  iconToggle.addEventListener('click', () => {
    if (!uploaderSlot.childElementCount) {
      uploaderSlot.append(createUploader({ owner: { type: 'product', id: product.id }, purpose: 'icon', kinds: ['image'], label: 'Upload an icon', requireAlt: true, onUploaded: loadProducts }));
    }
    uploaderSlot.hidden = !uploaderSlot.hidden;
  });
  const manageActions = canManage() ? [edit, remove] : [];
  return h('li', {}, h('article', { className: 'hub-card' },
    h('div', { className: 'hub-identity' }, icon, h('div', {}, h('h3', { text: product.name }), h('span', { className: 'hint', text: `/go/${product.slug}` }))),
    h('span', { className: 'card-meta' },
      badge(PRODUCT_STATUS[product.status], statusTone(product.status)),
      badge(PRODUCT_KIND[product.kind]),
      badge(product.visibility === 'public' ? 'Public' : 'Members only', product.visibility === 'public' ? 'info' : '')),
    product.summary && h('p', { text: product.summary }),
    launches,
    h('div', { className: 'row-actions' }, copy, ...manageActions),
    canManage() && iconToggle,
    uploaderSlot));
}

async function loadProducts() {
  const { items } = await api(`/products?client_id=${encodeURIComponent(client.id)}&page_size=100`);
  $('apps-count').textContent = String(items.length);
  $('apps-count').hidden = false;
  $('product-open').hidden = !canManage();
  $('product-list').replaceChildren(...(items.length ? items.map(productCard) : [h('li', { className: 'empty-state' },
    h('p', { text: canManage() ? 'No apps yet. Add the first one with “Add app”.' : 'No apps yet.' }))]));
}

async function loadProjectOptions() {
  const { items } = await api(`/projects?client_id=${encodeURIComponent(client.id)}&page_size=50&sort=name`);
  productForm.elements.project_id.append(...items.map((project) => h('option', { value: project.id, text: project.name })));
}

// --- Activity ---------------------------------------------------------------------------
const ACTIONS = {
  'client.created': 'created the workspace',
  'client.updated': 'updated workspace details',
  'member.added': 'added a member',
  'member.removed': 'removed a member',
  'member.left': 'left the workspace',
  'member.role_changed': 'changed a role',
  'invite.created': 'sent an invitation',
  'invite.resent': 'resent an invitation',
  'invite.revoked': 'revoked an invitation',
  'invite.accepted': 'accepted an invitation',
  'project.created': 'created a project',
  'project.updated': 'updated a project',
  'project.deleted': 'deleted a project',
  'project.restored': 'restored a project',
  'product.created': 'added an app',
  'product.updated': 'updated an app',
  'product.deleted': 'deleted an app',
  'asset.uploaded': 'uploaded a file',
  'asset.deleted': 'deleted a file'
};

// One request at a time: a tab click during startup must not duplicate the initial load.
let activityLoading = null;
function loadActivityOnce() {
  activityLoading ??= loadActivity()
    .catch((error) => showStatus($('activity-status'), describeError(error)))
    .finally(() => { activityLoading = null; });
  return activityLoading;
}

async function loadActivity() {
  if (client.my_role !== 'owner') {
    $('activity-body').replaceChildren(h('tr', {}, h('td', { colspan: 3, className: 'empty', text: 'Only workspace owners can view activity.' })));
    return;
  }
  const [{ items }, { items: members }] = await Promise.all([api(`/audit?client_id=${encodeURIComponent(client.id)}&page_size=50`), api(`${base}/members`)]);
  const names = new Map(members.map((member) => [member.user_id, member.full_name]));
  $('activity-body').replaceChildren(...(items.length ? items.map((entry) => h('tr', {},
    h('td', { text: formatDate(entry.ts) }),
    h('td', { text: names.get(entry.actor_id) ?? (entry.actor_id === me.id ? 'You' : 'SGS AI Technology') }),
    h('td', { text: ACTIONS[entry.action] ?? entry.action }))) : [h('tr', {}, h('td', { colspan: 3, className: 'empty', text: 'No activity yet.' }))]));
}

async function main() {
  if (!clientId) throw new ApiError(404, 'NOT_FOUND', 'No workspace was selected.');
  await requireUser();
  me = await getCurrentUser();
  client = await api(base);
  if (client.my_role !== 'owner' && client.my_role !== 'admin') {
    showStatus($('page-status'), 'You can view this workspace, but only its admins can change it.', 'info');
  }
  $('visibility-field').hidden = me.role !== 'admin';
  renderOverview();
  if (location.hash === '#activity') loadActivityOnce();
  if (canManage()) {
    $('logo-upload').append(createUploader({
      owner: { type: 'client', id: client.id }, purpose: 'logo', kinds: ['image'], label: 'Upload a logo', requireAlt: true,
      onUploaded: async () => {
        client = await api(base);
        renderLogo();
      }
    }));
  }
  await Promise.all([loadMembers(), loadInvites(), loadProducts(), loadProjectOptions()]);
}

main().catch((error) => {
  showStatus($('page-status'), error.status === 404 ? 'This workspace was not found, or you do not have access to it.' : describeError(error));
});
