import { HttpError } from '../http.mjs';
import { getDoc, newId, queryPage, transactDocs } from '../db.mjs';
import { Checker } from '../validation.mjs';
import { sha256 } from '../security.mjs';
import {
  CRM_DEFAULTS, DEAL_PROBABILITY, DEAL_STAGES, commitFinance, dealEtag, ensureDeal,
  financeAccess, financeProject, ref, requireDealVersion, write
} from '../crm.mjs';

const PRIVATE_HEADERS = { 'Cache-Control': 'no-store' };
const FIELDS = ['name', 'scope', 'amount_minor', 'billing_method', 'currency', 'hourly_rate_minor', 'planned_minutes', 'start_date', 'end_date', 'expected_close_date', 'stage'];
const OPEN_STAGES = ['qualified', 'discovery', 'negotiation'];

function sendDeal(ctx, status, deal) {
  return ctx.send(status, deal, { ...PRIVATE_HEADERS, ETag: dealEtag(deal) });
}

function listParams(ctx) {
  const raw = ctx.query.get('page_size') ?? '25';
  if (!/^\d+$/.test(raw)) throw new HttpError(400, 'BAD_REQUEST', 'Invalid page_size.');
  return { pageSize: Number(raw), after: ctx.query.get('cursor') };
}

function readTerms(input, { creating = false, current = {} } = {}) {
  const check = new Checker(input);
  for (const field of Object.keys(input)) if (!FIELDS.includes(field)) check.fail(field, 'This field cannot be set here.');
  check.text('name', { required: creating, min: 1, max: 120 });
  check.text('scope', { required: creating, min: 1, max: 4000 });
  check.oneOf('billing_method', ['fixed', 'hourly'], { required: creating });
  check.oneOf('currency', ['INR'], { required: creating });
  check.integer('amount_minor', { min: 1, max: 1_000_000_000_000 });
  check.integer('hourly_rate_minor', { min: 1, max: 100_000_000 });
  check.integer('planned_minutes', { min: 1, max: 60_000_000 });
  check.oneOf('stage', OPEN_STAGES);
  for (const field of ['start_date', 'end_date', 'expected_close_date']) {
    const value = check.date(field);
    if (value && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) check.fail(field, 'Enter a real calendar date.');
  }
  const merged = { ...current, ...check.output };
  if (!merged.amount_minor) check.fail('amount_minor', 'An agreed amount or hourly cap is required.');
  if (merged.billing_method === 'hourly' && (!merged.hourly_rate_minor || !merged.planned_minutes)) check.fail('hourly_rate_minor', 'Hourly billing requires a rate and planned effort.');
  if (merged.start_date && merged.end_date && merged.end_date < merged.start_date) check.fail('end_date', 'End date cannot precede start date.');
  return check.done();
}

async function capabilities(ctx) {
  const { issuer, user } = await financeAccess(ctx, ctx.params.client_id);
  return ctx.send(200, {
    can_prepare: issuer, can_accept: user.role !== 'admin', ...CRM_DEFAULTS,
    implementation_stage: 'deals_and_accepted_billing_plans'
  }, PRIVATE_HEADERS);
}

async function listDeals(ctx) {
  const project = await financeProject(ctx, ctx.params.project_id);
  const page = await queryPage('deals', { where: [['client_id', '==', project.client_id], ['project_id', '==', project.id]], ...listParams(ctx) });
  return ctx.send(200, page, PRIVATE_HEADERS);
}

async function workspaceDeals(ctx) {
  await financeAccess(ctx, ctx.params.client_id);
  const stage = ctx.query.get('stage');
  if (stage && !DEAL_STAGES.includes(stage)) throw new HttpError(400, 'BAD_REQUEST', 'Invalid deal stage.');
  const where = [['client_id', '==', ctx.params.client_id]];
  if (stage) where.push(['stage', '==', stage]);
  const projectId = ctx.query.get('project_id');
  if (projectId) {
    const project = await financeProject(ctx, projectId);
    if (project.client_id !== ctx.params.client_id) throw new HttpError(404, 'NOT_FOUND', 'Project not found.');
    where.push(['project_id', '==', projectId]);
  }
  return ctx.send(200, await queryPage('deals', { where, ...listParams(ctx) }), PRIVATE_HEADERS);
}

async function createDeal(ctx) {
  const project = await financeProject(ctx, ctx.params.project_id);
  const values = readTerms(await ctx.body(), { creating: true });
  const id = newId('dea');
  const result = await commitFinance(ctx, project, [ref('deals', id)], 'issuer', 'deal.created', ([_existing], { user, project: currentProject, now }) => {
    const stage = values.stage ?? 'qualified';
    const deal = {
      id, client_id: project.client_id, project_id: project.id, project_name: currentProject.name,
      ...values, stage, probability: DEAL_PROBABILITY[stage],
      hourly_rate_minor: values.hourly_rate_minor ?? null, planned_minutes: values.planned_minutes ?? null,
      start_date: values.start_date ?? null, end_date: values.end_date ?? null, expected_close_date: values.expected_close_date ?? null,
      current_revision_id: null, revision_number: 0, accepted_revision_id: null,
      accepted_by: null, accepted_at: null, active_plan_id: null, loss_reason: null,
      version: 1, created_by: user.id, created_at: now, updated_at: now
    };
    return {
      writes: [
        write('deals', id, deal),
        write('projects', project.id, { ...currentProject, finance_retained: true, expires_at: null, version: (currentProject.version ?? 1) + 1, updated_at: now })
      ],
      result: deal
    };
  });
  return sendDeal(ctx, 201, result);
}

async function loadDeal(ctx) {
  const deal = await getDoc('deals', ctx.params.id);
  if (!deal) throw new HttpError(404, 'NOT_FOUND', 'Deal not found.');
  const project = await financeProject(ctx, deal.project_id);
  ensureDeal(deal, project);
  return { deal, project };
}

async function getDeal(ctx) {
  const { deal } = await loadDeal(ctx);
  return sendDeal(ctx, 200, deal);
}

async function editDeal(ctx) {
  const { deal, project } = await loadDeal(ctx);
  const input = await ctx.body();
  const values = readTerms(input, { current: deal });
  const result = await commitFinance(ctx, project, [ref('deals', deal.id)], 'issuer', 'deal.updated', ([current], { now }) => {
    ensureDeal(current, project);
    requireDealVersion(ctx, current);
    if (current.stage.startsWith('closed_')) throw new HttpError(409, 'DEAL_CLOSED', 'Closed deals are immutable. Create a new deal for changed scope.');
    const stage = values.stage ?? (current.current_revision_id ? 'discovery' : current.stage);
    const updated = {
      ...current, ...values, stage, probability: DEAL_PROBABILITY[stage], current_revision_id: null,
      accepted_revision_id: null, accepted_by: null, accepted_at: null, version: current.version + 1, updated_at: now
    };
    return { writes: [write('deals', deal.id, updated)], result: updated };
  });
  return sendDeal(ctx, 200, result);
}

async function dealAction(ctx) {
  const { deal, project } = await loadDeal(ctx);
  const action = ctx.params.action;
  if (!['publish', 'accept', 'activate', 'lose'].includes(action)) throw new HttpError(404, 'NOT_FOUND', 'Action not found.');
  const input = await ctx.body();
  const key = ctx.request.headers['idempotency-key'];
  if (typeof key !== 'string' || !/^[a-zA-Z0-9_-]{1,120}$/.test(key)) throw new HttpError(400, 'IDEMPOTENCY_KEY_REQUIRED', 'Send a unique Idempotency-Key using letters, numbers, underscores or hyphens.');
  const { user } = await ctx.auth();
  const operationId = sha256(`${user.id}:${deal.id}:${action}:${key}`);
  const hash = sha256(JSON.stringify(input));
  const revisionId = action === 'publish' ? `${deal.id}__r${String(deal.revision_number + 1).padStart(6, '0')}` : (deal.current_revision_id ?? `${deal.id}__none`);
  const planId = `${project.id}__base`;
  const result = await commitFinance(ctx, project, [
    ref('deals', deal.id), ref('idempotency_records', operationId), ref('commercial_revisions', revisionId),
    ref('commercial_acceptances', revisionId), ref('billing_plans', planId)
  ], action === 'accept' ? 'customer' : 'issuer', `deal.${action === 'activate' ? 'activated' : action === 'lose' ? 'lost' : action === 'publish' ? 'published' : 'accepted'}`,
  ([current, replay, revision, acceptance, plan], { now, user: actor }) => {
    ensureDeal(current, project);
    if (replay) {
      if (replay.request_hash !== hash) throw new HttpError(409, 'IDEMPOTENCY_CONFLICT', 'This key was used with different input.');
      return { replayed: true, writes: [], result: replay.result };
    }
    requireDealVersion(ctx, current);
    if (current.stage.startsWith('closed_')) throw new HttpError(409, 'DEAL_CLOSED', 'This deal is already closed.');
    const updated = { ...current, version: current.version + 1, updated_at: now };
    const writes = [];
    if (action === 'publish') {
      if (Object.keys(input).length) throw new HttpError(400, 'BAD_REQUEST', 'Publish uses the saved deal terms; no body fields are allowed.');
      if (current.accepted_revision_id) throw new HttpError(409, 'ALREADY_ACCEPTED', 'Activate this acceptance or edit a new revision first.');
      if (revision) throw new HttpError(409, 'REVISION_EXISTS', 'Reload the latest deal.');
      const snapshot = Object.fromEntries(FIELDS.filter((field) => field !== 'stage').map((field) => [field, current[field]]));
      writes.push(write('commercial_revisions', revisionId, {
        id: revisionId, deal_id: deal.id, client_id: project.client_id, project_id: project.id,
        ...snapshot, revision_number: current.revision_number + 1, ...CRM_DEFAULTS, published_by: actor.id, published_at: now
      }));
      Object.assign(updated, { current_revision_id: revisionId, revision_number: current.revision_number + 1, stage: 'proposal', probability: 50 });
    } else if (action === 'accept') {
      if (Object.keys(input).some((field) => field !== 'revision_id')) throw new HttpError(400, 'BAD_REQUEST', 'Only revision_id is allowed.');
      if (!revision || input.revision_id !== current.current_revision_id || revision.id !== current.current_revision_id) throw new HttpError(409, 'REVISION_CHANGED', 'Only the current published proposal can be accepted.');
      if (acceptance || current.accepted_revision_id) throw new HttpError(409, 'ALREADY_ACCEPTED', 'This proposal is already accepted.');
      writes.push(write('commercial_acceptances', revisionId, {
        id: revisionId, client_id: project.client_id, project_id: project.id, deal_id: deal.id,
        revision_id: revisionId, accepted_by: actor.id, accepted_at: now
      }));
      Object.assign(updated, { accepted_revision_id: revisionId, accepted_by: actor.id, accepted_at: now });
    } else if (action === 'activate') {
      if (Object.keys(input).length) throw new HttpError(400, 'BAD_REQUEST', 'Activate does not accept body fields.');
      if (!revision || !acceptance || current.accepted_revision_id !== revision.id || acceptance.revision_id !== revision.id) throw new HttpError(409, 'ACCEPTANCE_REQUIRED', 'Customer acceptance of the current proposal is required.');
      if (plan) throw new HttpError(409, 'BILLING_PLAN_EXISTS', 'This project already has a base plan. Change orders are not available yet.');
      writes.push(write('billing_plans', planId, {
        id: planId, client_id: project.client_id, project_id: project.id, deal_id: deal.id,
        commercial_revision_id: revision.id, billing_method: revision.billing_method,
        amount_minor: revision.amount_minor, hourly_rate_minor: revision.hourly_rate_minor,
        planned_minutes: revision.planned_minutes, start_date: revision.start_date, end_date: revision.end_date,
        ...CRM_DEFAULTS, status: 'active', activated_by: actor.id, created_at: now, version: 1
      }));
      Object.assign(updated, { stage: 'closed_won', probability: 100, active_plan_id: planId });
    } else {
      const check = new Checker(input);
      check.text('reason', { required: true, min: 1, max: 500 });
      if (Object.keys(input).some((field) => field !== 'reason')) check.fail('reason', 'Only a loss reason is allowed.');
      const { reason } = check.done();
      if (current.accepted_revision_id) throw new HttpError(409, 'ALREADY_ACCEPTED', 'Accepted scope cannot be silently closed lost. Revise it with the customer first.');
      Object.assign(updated, { stage: 'closed_lost', probability: 0, loss_reason: reason });
    }
    writes.push(write('deals', deal.id, updated), write('idempotency_records', operationId, {
      id: operationId, client_id: project.client_id, project_id: project.id, actor_id: actor.id,
      request_hash: hash, result: updated, created_at: now
    }));
    return { writes, result: updated };
  });
  return sendDeal(ctx, 200, result);
}

async function revisions(ctx) {
  const { deal } = await loadDeal(ctx);
  return ctx.send(200, await queryPage('commercial_revisions', { where: [['deal_id', '==', deal.id], ['client_id', '==', deal.client_id]], ...listParams(ctx) }), PRIVATE_HEADERS);
}

async function billingPlan(ctx) {
  const project = await financeProject(ctx, ctx.params.project_id);
  const plan = await getDoc('billing_plans', `${project.id}__base`);
  return ctx.send(200, { plan, ...CRM_DEFAULTS }, PRIVATE_HEADERS);
}

async function financeEvents(ctx) {
  const project = await financeProject(ctx, ctx.params.project_id);
  return ctx.send(200, await queryPage('financial_events', { where: [['client_id', '==', project.client_id], ['project_id', '==', project.id]], ...listParams(ctx) }), PRIVATE_HEADERS);
}

async function listOperators(ctx) {
  await ctx.admin();
  return ctx.send(200, await queryPage('issuer_operators', listParams(ctx)), PRIVATE_HEADERS);
}

async function setOperator(ctx) {
  const { user } = await ctx.admin();
  ctx.limit('mutations', user.id);
  const check = new Checker(await ctx.body());
  check.boolean('active');
  check.text('reason', { required: true, min: 1, max: 500 });
  if (!check.has('active')) check.fail('active', 'This field is required.');
  for (const field of Object.keys(check.input)) if (!['active', 'reason'].includes(field)) check.fail(field, 'This field cannot be set here.');
  const values = check.done();
  const eventId = newId('ioe');
  const targetId = ctx.params.user_id;
  const refs = [ref('users', user.id)];
  if (targetId !== user.id) refs.push(ref('users', targetId));
  refs.push(ref('issuer_operators', targetId), ref('issuer_operator_events', eventId));
  const result = await transactDocs(refs, (docs) => {
    const actor = docs[0];
    const target = targetId === user.id ? actor : docs[1];
    if (actor?.status !== 'active' || actor.role !== 'admin') throw new HttpError(403, 'FORBIDDEN', 'Administrator access is required.');
    if (!target || (values.active && (target.status !== 'active' || target.role !== 'admin'))) throw new HttpError(400, 'INVALID_OPERATOR', 'An issuer operator must be an active SGS administrator.');
    const now = new Date().toISOString();
    const operator = { id: targetId, user_id: targetId, active: values.active, updated_by: actor.id, updated_at: now };
    return {
      writes: [
        write('issuer_operators', targetId, operator),
        write('issuer_operator_events', eventId, { id: eventId, target_user_id: targetId, actor_id: actor.id, ...values, ts: now, request_id: ctx.requestId })
      ], result: operator
    };
  });
  return ctx.send(200, result, PRIVATE_HEADERS);
}

export const crmRoutes = [
  ['GET', '/api/v1/clients/:client_id/crm/capabilities', capabilities],
  ['GET', '/api/v1/clients/:client_id/crm/deals', workspaceDeals],
  ['GET', '/api/v1/projects/:project_id/deals', listDeals],
  ['POST', '/api/v1/projects/:project_id/deals', createDeal],
  ['GET', '/api/v1/projects/:project_id/billing-plan', billingPlan],
  ['GET', '/api/v1/projects/:project_id/finance-events', financeEvents],
  ['GET', '/api/v1/crm/deals/:id/revisions', revisions],
  ['GET', '/api/v1/crm/deals/:id', getDeal],
  ['PATCH', '/api/v1/crm/deals/:id', editDeal],
  ['POST', '/api/v1/crm/deals/:id/:action', dealAction],
  ['GET', '/api/v1/crm/issuer-operators', listOperators],
  ['PUT', '/api/v1/crm/issuer-operators/:user_id', setOperator]
];
