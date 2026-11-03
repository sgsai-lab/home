import { HttpError } from './http.mjs';
import { getDoc, newId, transactDocs } from './db.mjs';
import { membershipId, requireActualOwner } from './authz.mjs';

export const CRM_DEFAULTS = Object.freeze({
  currency: 'INR', tax_status: 'unconfigured', tax_jurisdiction: 'IN',
  billing_cycle: 'month_end', payment_terms_days: 30, invoice_issuance_enabled: false
});
export const DEAL_STAGES = ['qualified', 'discovery', 'proposal', 'negotiation', 'closed_won', 'closed_lost'];
export const DEAL_PROBABILITY = { qualified: 10, discovery: 25, proposal: 50, negotiation: 75, closed_won: 100, closed_lost: 0 };
export const ref = (collection, id) => ({ collection, id });
export const write = (collection, id, data) => ({ collection, id, data });
export const dealEtag = (deal) => `"v${deal.version}"`;

export async function financeAccess(ctx, clientId) {
  const { user } = await ctx.auth();
  await requireActualOwner(user, clientId);
  const operator = await getDoc('issuer_operators', user.id);
  const issuer = operator?.active === true && user.role === 'admin';
  return { user, issuer };
}

export async function financeProject(ctx, id) {
  const project = await getDoc('projects', id);
  if (!project || project.deleted_at) throw new HttpError(404, 'NOT_FOUND', 'Project not found.');
  await financeAccess(ctx, project.client_id);
  return project;
}

/** Revalidates authority and records a durable finance event in the same commit as the mutation. */
export async function commitFinance(ctx, project, refs, mode, action, mutate) {
  if (!['issuer', 'customer', 'owner'].includes(mode)) throw new TypeError('Unknown financial authorization mode.');
  const { user } = await ctx.auth();
  ctx.limit('mutations', user.id);
  const eventId = newId('fev');
  return transactDocs([
    ref('users', user.id), ref('clients', project.client_id),
    ref('memberships', membershipId(project.client_id, user.id)),
    ref('issuer_operators', user.id), ref('projects', project.id),
    ...refs, ref('financial_events', eventId)
  ], ([actor, client, membership, operator, currentProject, ...documents]) => {
    if (actor?.status !== 'active') throw new HttpError(401, 'UNAUTHORIZED', 'An active account is required.');
    if (!client || !membership || membership.status !== 'active') throw new HttpError(404, 'NOT_FOUND', 'Workspace not found.');
    if (membership.role !== 'owner') throw new HttpError(403, 'FORBIDDEN', 'Actual workspace owner access is required.');
    const issuer = actor.role === 'admin' && operator?.active === true;
    if (mode === 'issuer' && !issuer) throw new HttpError(403, 'FORBIDDEN', 'An assigned SGS issuer operator is required.');
    if (mode === 'customer' && actor.role === 'admin') throw new HttpError(403, 'FORBIDDEN', 'A customer owner, not an SGS administrator, must accept this proposal.');
    if (!currentProject || currentProject.deleted_at || currentProject.client_id !== project.client_id) throw new HttpError(404, 'NOT_FOUND', 'Project not found.');
    const now = new Date().toISOString();
    const outcome = mutate(documents.slice(0, refs.length), { user: actor, project: currentProject, now });
    if (outcome.replayed) return outcome;
    return {
      writes: [...outcome.writes, write('financial_events', eventId, {
        id: eventId, client_id: project.client_id, project_id: project.id,
        actor_id: actor.id, action, target_id: outcome.result.id,
        target_version: outcome.result.version, request_id: ctx.requestId, ts: now
      })],
      result: outcome.result
    };
  });
}

export function requireDealVersion(ctx, deal) {
  const version = ctx.request.headers['if-match'];
  if (!version) throw new HttpError(428, 'PRECONDITION_REQUIRED', 'Reload the record and send its If-Match version.');
  if (version !== dealEtag(deal)) throw new HttpError(412, 'PRECONDITION_FAILED', 'This deal changed. Reload it before continuing.');
}

export function ensureDeal(deal, project) {
  if (!deal || deal.project_id !== project.id || deal.client_id !== project.client_id) throw new HttpError(404, 'NOT_FOUND', 'Deal not found.');
}
