import { HttpError, sanitizeText } from '../http.mjs';
import { getDoc, newId, queryDocs, setDoc, updateDoc } from '../db.mjs';
import { isSgsAdmin, listMembershipsForUser, requireMembership, roleAtLeast } from '../authz.mjs';
import { Checker, MILESTONE_TEMPLATES, SECTORS, pageParams, sortAndPage, validateMilestones, validateSectorProfile } from '../validation.mjs';

export const PROJECT_STATUSES = ['draft', 'discovery', 'in_progress', 'on_hold', 'delivered', 'archived'];
const RESTORE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

export function etagOf(project) {
  return `"v${project.version ?? 1}"`;
}

function publicProject(project, role) {
  return {
    id: project.id,
    client_id: project.client_id,
    name: project.name,
    summary: project.summary ?? null,
    sector: project.sector,
    status: project.status,
    tags: project.tags ?? [],
    start_date: project.start_date ?? null,
    end_date: project.end_date ?? null,
    sector_profile: project.sector_profile ?? null,
    milestones: project.milestones ?? [],
    cover_asset_id: project.cover_asset_id ?? null,
    owner_user_id: project.owner_user_id ?? null,
    created_at: project.created_at,
    updated_at: project.updated_at,
    deleted_at: project.deleted_at ?? null,
    can_edit: roleAtLeast(role, 'admin')
  };
}

/** Clients the caller may read, with the caller's role on each. */
export async function readableClients(user, clientId) {
  if (clientId) {
    const { client, role } = await requireMembership(user, clientId);
    return new Map([[client.id, role]]);
  }
  if (isSgsAdmin(user)) return null;
  const memberships = await listMembershipsForUser(user.id);
  return new Map(memberships.map((membership) => [membership.client_id, membership.role]));
}

/** Loads documents of `collection` for the readable clients ('in' queries are chunked at 30). */
export async function scopedQuery(collection, scope, where = []) {
  if (scope === null) return queryDocs(collection, { where, limit: 5000 });
  const ids = [...scope.keys()];
  const results = [];
  for (let index = 0; index < ids.length; index += 30) {
    results.push(...await queryDocs(collection, { where: [['client_id', 'in', ids.slice(index, index + 30)], ...where], limit: 5000 }));
  }
  return results;
}

function readProject(check, sector, { creating }) {
  check.text('name', { required: creating, max: 120, min: 1 });
  check.text('summary', { max: 2000, nullable: true });
  check.oneOf('status', PROJECT_STATUSES);
  check.date('start_date');
  check.date('end_date');
  check.tags('tags');
  validateSectorProfile(sector, check.input.sector_profile, check);
  validateMilestones(check.input.milestones, check);
}

function checkDates(project, check) {
  if (project.start_date && project.end_date && project.end_date < project.start_date) {
    check.fail('end_date', 'End date must be on or after the start date.');
  }
}

async function listProjects(ctx) {
  const { user } = await ctx.auth();
  const scope = await readableClients(user, ctx.query.get('client_id'));
  const params = pageParams(ctx.query, { sortFields: ['created_at', 'updated_at', 'name', 'start_date', 'end_date'] });
  const deletedOnly = ctx.query.get('deleted') === 'only';
  let projects = await scopedQuery('projects', scope);
  projects = projects.filter((project) => (deletedOnly ? project.deleted_at : !project.deleted_at));
  if (deletedOnly) projects = projects.filter((project) => isSgsAdmin(user) || roleAtLeast(scope.get(project.client_id), 'admin'));
  const status = ctx.query.get('status');
  if (PROJECT_STATUSES.includes(status)) projects = projects.filter((project) => project.status === status);
  const sector = ctx.query.get('sector');
  if (SECTORS.includes(sector)) projects = projects.filter((project) => project.sector === sector);
  const tag = sanitizeText(ctx.query.get('tag'), 32).toLowerCase();
  if (tag) projects = projects.filter((project) => project.tags?.includes(tag));
  const q = sanitizeText(ctx.query.get('q'), 100).toLowerCase();
  if (q) projects = projects.filter((project) => project.name.toLowerCase().includes(q) || project.summary?.toLowerCase().includes(q) || project.tags?.some((value) => value.includes(q)));
  const page = sortAndPage(projects, params);
  page.items = page.items.map((project) => publicProject(project, scope === null ? 'owner' : scope.get(project.client_id)));
  return ctx.send(200, page);
}

async function createProject(ctx) {
  const { user } = await ctx.auth();
  ctx.limit('mutations', user.id);
  const input = await ctx.body();
  const check = new Checker(input);
  const clientId = check.text('client_id', { required: true, max: 80 });
  if (!clientId) check.done();
  const { client } = await requireMembership(user, clientId, 'admin');
  const sector = check.oneOf('sector', SECTORS) ?? client.primary_sector;
  readProject(check, sector, { creating: true });
  const values = check.done();
  checkDates(values, check);
  check.done();
  const now = new Date().toISOString();
  const milestones = values.milestones ?? (input.use_template === true ? MILESTONE_TEMPLATES[sector].map((title) => ({ title, due: null, done: false })) : []);
  const project = {
    id: newId('prj'),
    client_id: client.id,
    name: values.name,
    summary: values.summary ?? null,
    sector,
    status: values.status ?? 'draft',
    tags: values.tags ?? [],
    start_date: values.start_date ?? null,
    end_date: values.end_date ?? null,
    sector_profile: values.sector_profile ?? null,
    milestones,
    cover_asset_id: null,
    owner_user_id: user.id,
    version: 1,
    deleted_at: null,
    expires_at: null,
    created_by: user.id,
    created_at: now,
    updated_at: now
  };
  await setDoc('projects', project.id, project);
  await ctx.audit('project.created', { type: 'project', id: project.id }, { actorId: user.id, clientId: client.id });
  return ctx.send(201, publicProject(project, 'admin'), { ETag: etagOf(project) });
}

/** Loads a project the caller can see (deleted projects only for admins). */
export async function loadProject(user, projectId, minimum = 'viewer', { allowDeleted = false } = {}) {
  const project = await getDoc('projects', projectId);
  if (!project) throw new HttpError(404, 'NOT_FOUND', 'Project not found.');
  const { role } = await requireMembership(user, project.client_id, minimum);
  if (project.deleted_at && !(allowDeleted && roleAtLeast(role, 'admin'))) throw new HttpError(404, 'NOT_FOUND', 'Project not found.');
  return { project, role };
}

async function getProject(ctx) {
  const { user } = await ctx.auth();
  const { project, role } = await loadProject(user, ctx.params.id);
  return ctx.send(200, publicProject(project, role), { ETag: etagOf(project) });
}

async function updateProject(ctx) {
  const { user } = await ctx.auth();
  ctx.limit('mutations', user.id);
  const { project } = await loadProject(user, ctx.params.id, 'admin');
  const input = await ctx.body();
  const check = new Checker(input);
  const sector = check.oneOf('sector', SECTORS) ?? project.sector;
  readProject(check, sector, { creating: false });
  if (Object.hasOwn(input, 'client_id') && input.client_id !== project.client_id) check.fail('client_id', 'A project cannot move to another workspace.');
  const updates = check.done();
  if (sector !== project.sector && !Object.hasOwn(updates, 'sector_profile')) updates.sector_profile = null;
  checkDates({ ...project, ...updates }, check);
  check.done();
  const ifMatch = ctx.request.headers['if-match'];
  const { after } = await updateDoc('projects', project.id, (current) => {
    if (!current || current.deleted_at) throw new HttpError(404, 'NOT_FOUND', 'Project not found.');
    if (ifMatch && ifMatch !== etagOf(current)) {
      throw new HttpError(412, 'PRECONDITION_FAILED', 'This project was changed elsewhere. Reload it to get the latest version.');
    }
    return { ...current, ...updates, version: (current.version ?? 1) + 1, updated_at: new Date().toISOString() };
  });
  await ctx.audit('project.updated', { type: 'project', id: project.id }, { actorId: user.id, clientId: project.client_id, diff: { fields: Object.keys(updates) } });
  return ctx.send(200, publicProject(after, 'admin'), { ETag: etagOf(after) });
}

async function deleteProject(ctx) {
  const { user } = await ctx.auth();
  ctx.limit('mutations', user.id);
  const { project } = await loadProject(user, ctx.params.id, 'admin');
  const now = Date.now();
  // expires_at drives the Firestore TTL policy that purges the project after the restore window.
  await updateDoc('projects', project.id, (current) => current && { ...current, deleted_at: new Date(now).toISOString(), expires_at: now + RESTORE_WINDOW_MS, version: (current.version ?? 1) + 1 });
  await ctx.audit('project.deleted', { type: 'project', id: project.id }, { actorId: user.id, clientId: project.client_id });
  return ctx.send(200, { ok: true, restore_until: new Date(now + RESTORE_WINDOW_MS).toISOString() });
}

async function restoreProject(ctx) {
  const { user } = await ctx.auth();
  ctx.limit('mutations', user.id);
  const { project } = await loadProject(user, ctx.params.id, 'admin', { allowDeleted: true });
  if (!project.deleted_at) throw new HttpError(409, 'NOT_DELETED', 'This project is not deleted.');
  const { after } = await updateDoc('projects', project.id, (current) => current && {
    ...current, deleted_at: null, expires_at: null, version: (current.version ?? 1) + 1, updated_at: new Date().toISOString()
  });
  await ctx.audit('project.restored', { type: 'project', id: project.id }, { actorId: user.id, clientId: project.client_id });
  return ctx.send(200, publicProject(after, 'admin'), { ETag: etagOf(after) });
}

export const projectRoutes = [
  ['GET', '/api/v1/projects', listProjects],
  ['POST', '/api/v1/projects', createProject],
  ['GET', '/api/v1/projects/:id', getProject],
  ['PATCH', '/api/v1/projects/:id', updateProject],
  ['DELETE', '/api/v1/projects/:id', deleteProject],
  ['POST', '/api/v1/projects/:id/restore', restoreProject]
];
