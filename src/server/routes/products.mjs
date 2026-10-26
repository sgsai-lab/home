import { escapeHtml, html, HttpError, redirect, sanitizeText } from '../http.mjs';
import { consumeOneTimeToken, deleteDoc, getDoc, newId, queryDocs, saveOneTimeToken, setDoc, updateDoc } from '../db.mjs';
import { requireMembership, roleAtLeast } from '../authz.mjs';
import { randomToken } from '../security.mjs';
import { siteOrigin } from '../mail.mjs';
import { Checker, SLUG_PATTERN, pageParams, slugify, sortAndPage } from '../validation.mjs';
import { readableClients, scopedQuery } from './projects.mjs';

export const PRODUCT_KINDS = ['pwa', 'web', 'android', 'ios', 'service'];
export const PRODUCT_STATUSES = ['planned', 'beta', 'live', 'retired'];
const VISIBILITY = ['client', 'public'];
const LAUNCH_TOKEN_TTL = 60 * 1000;
const LAUNCH_EVENT_RETENTION = 180 * 24 * 60 * 60 * 1000;
const SOURCES = ['web', 'android', 'ios'];

function publicProduct(product, role = null) {
  return {
    id: product.id,
    client_id: product.client_id,
    project_id: product.project_id ?? null,
    kind: product.kind,
    name: product.name,
    slug: product.slug,
    summary: product.summary ?? null,
    launch_url: product.launch_url ?? null,
    store_urls: product.store_urls ?? {},
    icon_asset_id: product.icon_asset_id ?? null,
    public_icon_url: product.public_icon_url ?? null,
    status: product.status,
    visibility: product.visibility,
    order: product.order ?? 0,
    created_at: product.created_at,
    updated_at: product.updated_at,
    ...(role ? { can_edit: roleAtLeast(role, 'admin') } : {})
  };
}

async function slugAvailable(slug, exceptId = null) {
  const [taken] = await queryDocs('products', { where: [['slug', '==', slug]], limit: 1 });
  return !taken || taken.id === exceptId;
}

async function suggestSlug(base) {
  for (let attempt = 2; attempt < 50; attempt += 1) {
    const candidate = `${base.slice(0, 55)}-${attempt}`;
    if (await slugAvailable(candidate)) return candidate;
  }
  return `${base.slice(0, 50)}-${randomToken(3).toLowerCase().replace(/[^a-z0-9]/g, '')}`;
}

function readStoreUrls(check) {
  const raw = check.input.store_urls;
  if (raw === undefined) return;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    check.fail('store_urls', 'Expected an object.');
    return;
  }
  const inner = new Checker(raw);
  inner.url('android');
  inner.url('ios');
  inner.details.forEach((detail) => check.fail(`store_urls.${detail.field}`, detail.message));
  check.output.store_urls = Object.fromEntries(Object.entries(inner.output).filter(([, value]) => value));
}

function readProduct(check, { creating }) {
  check.oneOf('kind', PRODUCT_KINDS, { required: creating });
  check.text('name', { required: creating, max: 120, min: 1 });
  check.text('summary', { max: 1000, nullable: true });
  check.url('launch_url');
  readStoreUrls(check);
  check.oneOf('status', PRODUCT_STATUSES);
  check.oneOf('visibility', VISIBILITY);
  check.integer('order', { min: 0, max: 1000 });
  const slug = check.text('slug', { max: 60 });
  if (slug && !SLUG_PATTERN.test(slug)) check.fail('slug', 'Use lowercase letters, numbers and dashes.');
}

function requireTarget(product, check) {
  const needsUrl = ['pwa', 'web', 'service'].includes(product.kind);
  if (needsUrl && !product.launch_url) check.fail('launch_url', 'Apps and services need a launch address.');
  if (!needsUrl && !product.launch_url && !product.store_urls?.android && !product.store_urls?.ios) {
    check.fail('store_urls', 'Add a store link or a launch address.');
  }
}

async function projectInClient(projectId, clientId, check) {
  if (projectId === undefined || projectId === null) return projectId;
  const project = await getDoc('projects', projectId);
  if (!project || project.deleted_at || project.client_id !== clientId) return check.fail('project_id', 'Choose a project of this workspace.');
  return projectId;
}

/** Copies or removes the public icon so only public products expose an icon publicly. */
export async function syncPublicIcon(storage, product) {
  const icon = product.icon_asset_id ? await getDoc('assets', product.icon_asset_id) : null;
  const shouldPublish = product.visibility === 'public' && product.status !== 'retired' && icon?.status === 'ready';
  const wantedObject = shouldPublish ? `products/${product.id}/${icon.gcs_object.split('/').pop()}` : null;
  if (product.public_icon_object === wantedObject) return product;
  if (product.public_icon_object) await storage.unpublish(product.public_icon_object);
  const url = wantedObject ? await storage.publish(icon.gcs_object, wantedObject) : null;
  const { after } = await updateDoc('products', product.id, (current) => current && {
    ...current, public_icon_object: url ? wantedObject : null, public_icon_url: url
  });
  return after;
}

async function listProducts(ctx) {
  const { user } = await ctx.auth();
  const scope = await readableClients(user, ctx.query.get('client_id'));
  const params = pageParams(ctx.query, { sortFields: ['order', 'name', 'created_at', 'updated_at'], defaultSort: 'order', maxPageSize: 100 });
  let products = await scopedQuery('products', scope);
  const projectId = ctx.query.get('project_id');
  if (projectId) products = products.filter((product) => product.project_id === projectId);
  const status = ctx.query.get('status');
  if (PRODUCT_STATUSES.includes(status)) products = products.filter((product) => product.status === status);
  const page = sortAndPage(products, params);
  page.items = page.items.map((product) => publicProduct(product, scope === null ? 'owner' : scope.get(product.client_id)));
  return ctx.send(200, page);
}

async function createProduct(ctx) {
  const { user } = await ctx.auth();
  ctx.limit('mutations', user.id);
  const check = new Checker(await ctx.body());
  const clientId = check.text('client_id', { required: true, max: 80 });
  if (!clientId) check.done();
  const { sgsAdmin } = await requireMembership(user, clientId, 'admin');
  readProduct(check, { creating: true });
  const values = check.done();
  values.project_id = await projectInClient(check.input.project_id, clientId, check);
  if (values.visibility === 'public' && !sgsAdmin) check.fail('visibility', 'Only SGS AI Technology can publish a product on the public site.');
  const slug = values.slug || slugify(values.name) || 'app';
  const draft = { ...values, slug };
  requireTarget(draft, check);
  check.done();
  if (!await slugAvailable(slug)) {
    throw new HttpError(409, 'SLUG_TAKEN', 'This link name is already in use.', [{ field: 'slug', message: `Try ${await suggestSlug(slug)}.` }]);
  }
  const now = new Date().toISOString();
  const product = {
    id: newId('prd'),
    client_id: clientId,
    project_id: values.project_id ?? null,
    kind: values.kind,
    name: values.name,
    slug,
    summary: values.summary ?? null,
    launch_url: values.launch_url ?? null,
    store_urls: values.store_urls ?? {},
    icon_asset_id: null,
    public_icon_url: null,
    public_icon_object: null,
    status: values.status ?? 'planned',
    visibility: values.visibility ?? 'client',
    order: values.order ?? 0,
    created_by: user.id,
    created_at: now,
    updated_at: now
  };
  await setDoc('products', product.id, product);
  await ctx.audit('product.created', { type: 'product', id: product.id }, { actorId: user.id, clientId, diff: { visibility: product.visibility } });
  return ctx.send(201, publicProduct(product, 'admin'));
}

async function loadProduct(user, id, minimum = 'viewer') {
  const product = await getDoc('products', id);
  if (!product) throw new HttpError(404, 'NOT_FOUND', 'Product not found.');
  const access = await requireMembership(user, product.client_id, minimum);
  return { product, ...access };
}

async function getProduct(ctx) {
  const { user } = await ctx.auth();
  const { product, role } = await loadProduct(user, ctx.params.id);
  return ctx.send(200, publicProduct(product, role));
}

async function getProductBySlug(ctx) {
  const [product] = await queryDocs('products', { where: [['slug', '==', ctx.params.slug.toLowerCase()]], limit: 1 });
  if (!product) throw new HttpError(404, 'NOT_FOUND', 'Product not found.');
  if (product.visibility === 'public') return ctx.send(200, publicProduct(product));
  const auth = await ctx.optionalAuth();
  if (!auth) throw new HttpError(401, 'UNAUTHORIZED', 'Sign in to open this app.');
  const { role } = await requireMembership(auth.user, product.client_id).catch(() => {
    throw new HttpError(403, 'FORBIDDEN', 'You do not have access to this app. Ask your workspace admin to invite you.');
  });
  return ctx.send(200, publicProduct(product, role));
}

async function updateProduct(ctx) {
  const { user } = await ctx.auth();
  ctx.limit('mutations', user.id);
  const { product, sgsAdmin } = await loadProduct(user, ctx.params.id, 'admin');
  const check = new Checker(await ctx.body());
  readProduct(check, { creating: false });
  const updates = check.done();
  if (Object.hasOwn(check.input, 'project_id')) updates.project_id = await projectInClient(check.input.project_id, product.client_id, check);
  if ('visibility' in updates && updates.visibility !== product.visibility && !sgsAdmin) {
    check.fail('visibility', 'Only SGS AI Technology can change whether a product is public.');
  }
  requireTarget({ ...product, ...updates }, check);
  check.done();
  if (updates.slug && updates.slug !== product.slug && !await slugAvailable(updates.slug, product.id)) {
    throw new HttpError(409, 'SLUG_TAKEN', 'This link name is already in use.', [{ field: 'slug', message: `Try ${await suggestSlug(updates.slug)}.` }]);
  }
  const { after } = await updateDoc('products', product.id, (current) => current && { ...current, ...updates, updated_at: new Date().toISOString() });
  const synced = await syncPublicIcon(ctx.deps.storage, after);
  const diff = Object.fromEntries(['visibility', 'status', 'slug'].filter((key) => key in updates && updates[key] !== product[key]).map((key) => [key, { from: product[key], to: updates[key] }]));
  await ctx.audit('product.updated', { type: 'product', id: product.id }, { actorId: user.id, clientId: product.client_id, diff });
  return ctx.send(200, publicProduct(synced, 'admin'));
}

async function deleteProduct(ctx) {
  const { user } = await ctx.auth();
  ctx.limit('mutations', user.id);
  const { product } = await loadProduct(user, ctx.params.id, 'admin');
  if (product.public_icon_object) await ctx.deps.storage.unpublish(product.public_icon_object);
  await deleteDoc('products', product.id);
  await ctx.audit('product.deleted', { type: 'product', id: product.id }, { actorId: user.id, clientId: product.client_id });
  return ctx.send(200, { ok: true });
}

async function createLaunchToken(ctx) {
  const { user } = await ctx.auth();
  ctx.limit('launch', user.id);
  const { product } = await loadProduct(user, ctx.params.id);
  if (product.status === 'retired') throw new HttpError(410, 'RETIRED', 'This app has been retired.');
  const token = randomToken();
  const source = SOURCES.includes(ctx.client) ? ctx.client : 'web';
  await saveOneTimeToken('launch_tokens', token, { product_id: product.id, client_id: product.client_id, user_id: user.id, source }, LAUNCH_TOKEN_TTL);
  const path = `/go/${encodeURIComponent(product.slug)}?t=${encodeURIComponent(token)}&src=${source}`;
  return ctx.send(201, { token, url: `${siteOrigin(ctx.env)}${path}`, path, expires_in: LAUNCH_TOKEN_TTL / 1000 });
}

async function catalog(ctx) {
  const products = (await queryDocs('products', { where: [['visibility', '==', 'public']], limit: 500 })).filter((product) => product.status !== 'retired');
  const clients = new Map();
  const projects = new Map();
  for (const product of products) {
    if (!clients.has(product.client_id)) clients.set(product.client_id, await getDoc('clients', product.client_id));
    if (product.project_id && !projects.has(product.project_id)) projects.set(product.project_id, await getDoc('projects', product.project_id));
  }
  const items = products
    .map((product) => ({
      name: product.name,
      slug: product.slug,
      summary: product.summary ?? null,
      kind: product.kind,
      status: product.status,
      icon_url: product.public_icon_url ?? null,
      sector: projects.get(product.project_id)?.sector ?? clients.get(product.client_id)?.primary_sector ?? null,
      launch_path: `/go/${product.slug}`,
      order: product.order ?? 0
    }))
    .sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
  return ctx.send(200, { items }, { 'Cache-Control': 'public, max-age=300' });
}

async function launchStats(ctx) {
  const { user } = await ctx.auth();
  const { product } = await loadProduct(user, ctx.params.id, 'admin');
  const since = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const events = (await queryDocs('launch_events', { where: [['product_id', '==', product.id]], limit: 10000 })).filter((event) => Date.parse(event.ts) >= since);
  const bySource = Object.fromEntries(['web', 'android', 'ios', 'link'].map((source) => [source, events.filter((event) => event.source === source).length]));
  return ctx.send(200, { product_id: product.id, days: 30, total: events.length, by_source: bySource });
}

// --- /go/{slug} launch links ----------------------------------------------------------

/** `title`, `message` and `contactEmail` are plain text; everything is escaped here. */
function goPage(ctx, status, title, message, contactEmail = null) {
  const contact = contactEmail ? ` Contact <a href="mailto:${escapeHtml(contactEmail)}">${escapeHtml(contactEmail)}</a> for its replacement.` : '';
  return html(ctx.response, status, `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${escapeHtml(title)} — SGS AI Technology</title><link rel="stylesheet" href="/assets/css/global.css"><link rel="stylesheet" href="/assets/css/account.css"></head><body><main id="main" class="auth-main"><div class="section-wrap"><div class="panel"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}${contact}</p><p><a class="button button-primary" href="/workspace/">Go to your workspace</a></p></div></div></main></body></html>`);
}

function withUtm(target, medium) {
  const url = new URL(target);
  url.searchParams.set('utm_source', 'sgsai_hub');
  url.searchParams.set('utm_medium', medium);
  return url.href;
}

async function go(ctx) {
  ctx.limit('launch', ctx.ip);
  const slug = sanitizeText(ctx.params.slug, 60).toLowerCase();
  const [product] = SLUG_PATTERN.test(slug) ? await queryDocs('products', { where: [['slug', '==', slug]], limit: 1 }) : [];
  if (!product) return goPage(ctx, 404, 'App not found', 'This link does not point to an SGS AI app. Check the address, or open the app from your workspace.');
  if (product.status === 'retired') {
    const client = await getDoc('clients', product.client_id);
    return goPage(ctx, 410, 'This app has been retired', `${product.name} is no longer available.`, client?.contact?.email);
  }
  const token = ctx.query.get('t');
  const record = token ? await consumeOneTimeToken('launch_tokens', token) : null;
  const valid = record && record.product_id === product.id;
  if (product.visibility === 'client' && !valid) {
    // The launch page signs the visitor in, checks membership and comes back with a fresh token.
    return redirect(ctx.response, `/workspace/launch/?slug=${encodeURIComponent(product.slug)}`);
  }
  const source = valid ? record.source : 'link';
  const target = product.launch_url || (source === 'ios' ? product.store_urls?.ios : product.store_urls?.android) || product.store_urls?.android || product.store_urls?.ios;
  if (!target) return goPage(ctx, 404, 'Not available yet', `${product.name} does not have a launch address yet.`);
  const id = newId('lev');
  const now = Date.now();
  await setDoc('launch_events', id, {
    id, product_id: product.id, client_id: product.client_id, user_id: valid ? record.user_id : null, source,
    ts: new Date(now).toISOString(), expires_at: now + LAUNCH_EVENT_RETENTION
  });
  return redirect(ctx.response, withUtm(target, source));
}

export const productRoutes = [
  ['GET', '/api/v1/products', listProducts],
  ['POST', '/api/v1/products', createProduct],
  ['GET', '/api/v1/products/by-slug/:slug', getProductBySlug],
  ['GET', '/api/v1/products/:id', getProduct],
  ['PATCH', '/api/v1/products/:id', updateProduct],
  ['DELETE', '/api/v1/products/:id', deleteProduct],
  ['POST', '/api/v1/products/:id/launch-token', createLaunchToken],
  ['GET', '/api/v1/products/:id/launches', launchStats],
  ['GET', '/api/v1/catalog', catalog]
];

export const goRoutes = [['GET', '/go/:slug', go]];
