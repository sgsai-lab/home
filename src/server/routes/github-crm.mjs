import { createHash } from 'node:crypto';
import { HttpError, sanitizeText } from '../http.mjs';
import { getDoc, queryDocs, transactDocs } from '../db.mjs';
import { financeAccess, financeProject, commitFinance, ref, write } from '../crm.mjs';
import { Checker } from '../validation.mjs';
import {
  createGithubAppAdapter, GITHUB_CRM_WORKER_BATCH_SIZE, parseGithubCrmBinding,
  verifyCrmWorker, verifyGithubWebhookSignature
} from '../github-crm.mjs';

const PRIVATE_HEADERS = { 'Cache-Control': 'no-store' };
const RAW_BODY_LIMIT = 512 * 1024;
const ID_PATTERN = /^[A-Za-z0-9_:=+.-]{1,256}$/;
const COMMAND_TYPES = ['issue.create', 'issue.status', 'issue.iteration'];

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
function unavailableGithubError(error, message) {
  if (error instanceof HttpError) return error;
  return new HttpError(503, 'GITHUB_CRM_UNAVAILABLE', message, [], { 'Retry-After': '60' });
}

const stableJson = (value) => {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
};

function requireAdapter(adapter) {
  if (!adapter?.configured) throw new HttpError(503, 'GITHUB_CRM_UNAVAILABLE', 'GitHub App credentials and organization permissions are not configured.', [], { 'Retry-After': '60' });
}

function requireIssuer(issuer) {
  if (!issuer) throw new HttpError(403, 'FORBIDDEN', 'An assigned SGS issuer operator is required.');
}

function validateProjectId(id) {
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(id)) {
    throw new HttpError(400, 'BAD_REQUEST', 'Invalid project ID.');
  }
  return id;
}

function readCommand(input) {
  const check = new Checker(input);
  check.oneOf('type', COMMAND_TYPES, { required: true });
  if (input.type === 'issue.create') {
    check.text('title', { required: true, min: 1, max: 256 });
    check.text('body', { max: 6000 });
  } else {
    for (const field of Object.keys(input ?? {})) {
      if (!['type', 'item_id', 'field_id', input.type === 'issue.status' ? 'option_id' : 'iteration_id'].includes(field)) {
        check.fail(field, 'This field cannot be set here.');
      }
    }
    for (const field of ['item_id', 'field_id']) {
      const value = check.text(field, { required: true, max: 256, min: 1 });
      if (value && !ID_PATTERN.test(value)) check.fail(field, 'Use a valid GitHub project field identifier.');
    }
    const choice = input.type === 'issue.status' ? 'option_id' : 'iteration_id';
    const value = check.text(choice, { required: true, max: 256, min: 1 });
    if (value && !ID_PATTERN.test(value)) check.fail(choice, 'Use a valid GitHub project field identifier.');
  }
  for (const field of Object.keys(input ?? {})) {
    if (input.type === 'issue.create' && !['type', 'title', 'body'].includes(field)) check.fail(field, 'This field cannot be set here.');
  }
  return check.done();
}

function commandId(projectId, userId, key) {
  return `gcmd_${sha256(`${projectId}:${userId}:${key}`)}`;
}

function publicBinding(binding) {
  if (!binding) return null;
  return {
    repository: binding.repository,
    repository_url: binding.repository_url,
    project_url: binding.project_url,
    organization: binding.organization,
    project_v2_number: binding.project_v2_number,
    project_v2_id: binding.project_v2_id,
    project_title: binding.project_title ?? null
  };
}

async function loadBinding(project) {
  const binding = await getDoc('github_project_bindings', project.id);
  if (!binding || binding.client_id !== project.client_id || binding.project_id !== project.id) return null;
  return binding;
}

function assertBinding(binding, project) {
  if (!binding || binding.client_id !== project.client_id || binding.project_id !== project.id) {
    throw new HttpError(409, 'GITHUB_NOT_BOUND', 'Bind this project to one GitHub repository and organization Project v2 board first.');
  }
  return binding;
}

async function readRawBody(request) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > RAW_BODY_LIMIT) throw new HttpError(413, 'PAYLOAD_TOO_LARGE', 'GitHub webhook payload is too large.');
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function parseWebhookBody(raw) {
  try {
    const body = JSON.parse(raw.toString('utf8'));
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Expected object.');
    return body;
  } catch {
    throw new HttpError(400, 'BAD_REQUEST', 'GitHub webhook body must be a JSON object.');
  }
}

export function createGithubCrmRoutes({
  env = process.env,
  adapter = createGithubAppAdapter(env),
  verifyServiceIdentity
} = {}) {
  async function getProjectView(ctx) {
    validateProjectId(ctx.params.project_id);
    const project = await financeProject(ctx, ctx.params.project_id);
    requireAdapter(adapter);
    const binding = await loadBinding(project);
    const storedSnapshot = await getDoc('github_project_snapshots', project.id);
    const snapshot = storedSnapshot?.project_id === project.id && storedSnapshot.client_id === project.client_id
      ? storedSnapshot
      : null;
    return ctx.send(200, {
      configured: true,
      can_manage: (await financeAccess(ctx, project.client_id)).issuer,
      binding: publicBinding(binding),
      synced_at: snapshot?.synced_at ?? null,
      items: snapshot?.items ?? [],
      iterations: snapshot?.iterations ?? [],
      status_options: snapshot?.status_options ?? [],
      project: snapshot?.project ?? null,
      command_states: ['pending', 'failed', 'reconciliation_required', 'completed']
    }, PRIVATE_HEADERS);
  }

  async function bindProject(ctx) {
    validateProjectId(ctx.params.project_id);
    const project = await financeProject(ctx, ctx.params.project_id);
    const { issuer } = await financeAccess(ctx, project.client_id);
    requireIssuer(issuer);
    requireAdapter(adapter);
    const input = await ctx.body();
    const check = new Checker(input);
    check.text('repository_url', { required: true, max: 500, min: 1 });
    check.text('project_url', { required: true, max: 500, min: 1 });
    for (const field of Object.keys(input ?? {})) if (!['repository_url', 'project_url'].includes(field)) check.fail(field, 'This field cannot be set here.');
    const values = check.done();
    const parsed = parseGithubCrmBinding(values);
    let verifiedRepository;
    try {
      verifiedRepository = await adapter.verifyRepository(parsed.fullName);
    } catch (error) {
      throw unavailableGithubError(error, 'GitHub repository installation verification is unavailable.');
    }
    if (!verifiedRepository?.id || !verifiedRepository.installation_id
      || verifiedRepository.full_name?.toLowerCase() !== parsed.fullName.toLowerCase()
      || verifiedRepository.organization?.toLowerCase() !== parsed.organization.toLowerCase()) {
      throw new HttpError(400, 'GITHUB_INSTALLATION_MISMATCH', 'The selected repository is not verified by the expected GitHub organization installation.');
    }
    if (typeof adapter.resolveProject !== 'function') {
      throw new HttpError(503, 'GITHUB_CRM_UNAVAILABLE', 'GitHub organization Project v2 lookup is unavailable.');
    }
    let resolved;
    try {
      resolved = await adapter.resolveProject(
        parsed.organization,
        parsed.number,
        verifiedRepository.installation_id,
        parsed.fullName
      );
    } catch (error) {
      throw unavailableGithubError(error, 'GitHub organization Project v2 lookup is unavailable.');
    }
    if (!resolved?.id || (resolved.url && resolved.url !== parsed.project_url)) {
      throw new HttpError(400, 'GITHUB_PROJECT_NOT_FOUND', 'The organization Project v2 board could not be verified.');
    }
    const result = await commitFinance(ctx, project, [ref('github_project_bindings', project.id)], 'issuer', 'github.binding.updated',
      ([current], { user: actor, project: currentProject, now }) => {
        const binding = {
          id: project.id,
          project_id: project.id,
          client_id: currentProject.client_id,
          repository: verifiedRepository.full_name,
          repository_owner: parsed.owner,
          repository_name: parsed.name,
          repository_id: verifiedRepository.id,
          repository_node_id: verifiedRepository.node_id ?? null,
          repository_url: `https://github.com/${verifiedRepository.full_name}`,
          installation_id: verifiedRepository.installation_id,
          organization: parsed.organization,
          project_v2_number: parsed.number,
          project_v2_id: resolved.id,
          project_title: resolved.title ?? null,
          project_url: `https://github.com/orgs/${parsed.organization}/projects/${parsed.number}`,
          version: (current?.version ?? 0) + 1,
          updated_by: actor.id,
          updated_at: now
        };
        return { writes: [write('github_project_bindings', project.id, binding)], result: binding };
      });
    return ctx.send(200, { binding: publicBinding(result) }, PRIVATE_HEADERS);
  }

  async function syncProject(ctx) {
    validateProjectId(ctx.params.project_id);
    const project = await financeProject(ctx, ctx.params.project_id);
    const { issuer } = await financeAccess(ctx, project.client_id);
    requireIssuer(issuer);
    requireAdapter(adapter);
    const binding = assertBinding(await loadBinding(project), project);
    let remote;
    try {
      remote = await adapter.readProject(binding);
    } catch (error) {
      throw new HttpError(503, 'GITHUB_SYNC_FAILED', error?.message ?? 'GitHub project sync is unavailable.', [], { 'Retry-After': '60' });
    }
    const normalized = {
      id: project.id,
      project_id: project.id,
      client_id: project.client_id,
      project: remote.project ?? null,
      items: Array.isArray(remote.items) ? remote.items.slice(0, 100) : [],
      iterations: Array.isArray(remote.iterations) ? remote.iterations.slice(0, 100) : [],
      status_options: Array.isArray(remote.status_options) ? remote.status_options.slice(0, 20) : [],
      synced_at: new Date().toISOString(),
      version: 1
    };
    const result = await commitFinance(ctx, project, [ref('github_project_snapshots', project.id)], 'issuer', 'github.project.synced',
      ([current], { now }) => {
        const snapshot = { ...normalized, synced_at: now, version: (current?.version ?? 0) + 1 };
        return { writes: [write('github_project_snapshots', project.id, snapshot)], result: snapshot };
      });
    return ctx.send(200, result, PRIVATE_HEADERS);
  }

  async function executeCommand(ctx, project, binding, command) {
    const started = await commitFinance(ctx, project, [ref('github_crm_commands', command.id)], 'issuer', 'github.command.attempted',
      ([current], { now }) => {
        if (!current || current.project_id !== project.id || current.client_id !== project.client_id) {
          throw new HttpError(404, 'NOT_FOUND', 'GitHub command not found.');
        }
        if (current.status !== 'pending') {
          throw new HttpError(409, 'GITHUB_COMMAND_NOT_PENDING', `This command is ${current.status} and cannot start execution.`);
        }
        const updated = {
          ...current, attempt_count: (current.attempt_count ?? 0) + 1,
          attempt_started_at: now, updated_at: now, version: (current.version ?? 0) + 1
        };
        return { writes: [write('github_crm_commands', command.id, updated)], result: updated };
      });
    let result;
    let status = 'completed';
    let external = null;
    try {
      external = await adapter.executeCommand(binding, started);
      if (!external?.external_id) throw Object.assign(new Error('GitHub did not confirm the command result.'), { ambiguous: true });
    } catch (error) {
      result = {
        error_code: sanitizeText(error?.code ?? (error?.ambiguous ? 'GITHUB_OUTCOME_UNKNOWN' : 'GITHUB_COMMAND_FAILED'), 64),
        error_message: error?.ambiguous
          ? 'GitHub may have applied this command. Reconcile it before retrying.'
          : 'GitHub rejected this command. Correct the request or explicitly retry it.'
      };
      status = error?.ambiguous ? 'reconciliation_required' : 'failed';
    }
    const refs = [ref('github_crm_commands', command.id)];
    return commitFinance(ctx, project, refs, 'issuer', `github.command.${status}`, ([current], { now }) => {
      if (!current || current.project_id !== project.id || current.client_id !== project.client_id) {
        throw new HttpError(404, 'NOT_FOUND', 'GitHub command not found.');
      }
      const updated = {
        ...current,
        status,
        ...(external ? { external_id: external.external_id, external_url: external.url ?? null, item_id: external.item_id ?? current.item_id ?? null } : result),
        updated_at: now,
        version: (current.version ?? 0) + 1
      };
      return { writes: [write('github_crm_commands', command.id, updated)], result: updated };
    });
  }

  async function createCommand(ctx) {
    validateProjectId(ctx.params.project_id);
    const project = await financeProject(ctx, ctx.params.project_id);
    const { issuer, user } = await financeAccess(ctx, project.client_id);
    requireIssuer(issuer);
    requireAdapter(adapter);
    const binding = assertBinding(await loadBinding(project), project);
    const key = ctx.request.headers['idempotency-key'];
    if (typeof key !== 'string' || !/^[A-Za-z0-9_-]{1,120}$/.test(key)) {
      throw new HttpError(400, 'IDEMPOTENCY_KEY_REQUIRED', 'Send an Idempotency-Key using letters, numbers, underscores or hyphens.');
    }
    const values = readCommand(await ctx.body());
    const id = commandId(project.id, user.id, key);
    const hash = sha256(stableJson(values));
    const record = await commitFinance(ctx, project, [ref('github_crm_commands', id)], 'issuer', 'github.command.queued',
      ([current], { user: actor, now }) => {
        if (current) {
          if (current.request_hash !== hash) throw new HttpError(409, 'IDEMPOTENCY_CONFLICT', 'This Idempotency-Key was already used with different command data.');
          return { replayed: true, result: { ...current, replayed: true } };
        }
        const command = {
          id, project_id: project.id, client_id: project.client_id, actor_id: actor.id,
          type: values.type, ...values,
          request_hash: hash,
          status: 'pending', attempt_count: 0, version: 1,
          created_at: now, updated_at: now
        };
        return { writes: [write('github_crm_commands', id, command)], result: command };
      });
    if (record.replayed) {
      const command = { ...record };
      delete command.replayed;
      return ctx.send(202, command, PRIVATE_HEADERS);
    }
    const final = await executeCommand(ctx, project, binding, record);
    return ctx.send(202, final, PRIVATE_HEADERS);
  }

  async function retryCommand(ctx) {
    validateProjectId(ctx.params.project_id);
    if (!/^gcmd_[a-f0-9]{64}$/.test(ctx.params.command_id ?? '')) {
      throw new HttpError(404, 'NOT_FOUND', 'GitHub command not found.');
    }
    const project = await financeProject(ctx, ctx.params.project_id);
    const { issuer } = await financeAccess(ctx, project.client_id);
    requireIssuer(issuer);
    requireAdapter(adapter);
    const binding = assertBinding(await loadBinding(project), project);
    const command = await getDoc('github_crm_commands', ctx.params.command_id);
    if (!command || command.project_id !== project.id || command.client_id !== project.client_id) {
      throw new HttpError(404, 'NOT_FOUND', 'GitHub command not found.');
    }
    if (!['failed', 'reconciliation_required'].includes(command.status)) {
      throw new HttpError(409, 'GITHUB_COMMAND_NOT_RETRYABLE', 'Only failed or ambiguous commands can be explicitly retried.');
    }
    const reservation = await commitFinance(ctx, project, [ref('github_crm_commands', command.id)], 'issuer', 'github.command.retry_requested',
      ([current], { now }) => {
        if (!current || !['failed', 'reconciliation_required'].includes(current.status)) {
          throw new HttpError(409, 'GITHUB_COMMAND_NOT_RETRYABLE', 'This command has changed and cannot be retried.');
        }
        const updated = { ...current, status: 'pending', updated_at: now, version: current.version + 1 };
        return { writes: [write('github_crm_commands', command.id, updated)], result: updated };
      });
    return ctx.send(202, await executeCommand(ctx, project, binding, reservation), PRIVATE_HEADERS);
  }

  async function webhook(ctx) {
    const secret = String(env.GITHUB_WEBHOOK_SECRET ?? '');
    if (!secret) throw new HttpError(503, 'GITHUB_WEBHOOK_UNAVAILABLE', 'GitHub webhook verification is not configured.');
    const raw = await readRawBody(ctx.request);
    if (!verifyGithubWebhookSignature(raw, ctx.request.headers['x-hub-signature-256'], secret)) {
      throw new HttpError(401, 'INVALID_WEBHOOK_SIGNATURE', 'GitHub webhook signature is invalid.');
    }
    const delivery = String(ctx.request.headers['x-github-delivery'] ?? '');
    const event = String(ctx.request.headers['x-github-event'] ?? '');
    if (!/^[A-Za-z0-9-]{1,128}$/.test(delivery) || !/^[a-z_]{1,64}$/.test(event)) {
      throw new HttpError(400, 'BAD_WEBHOOK_HEADERS', 'GitHub webhook delivery headers are invalid.');
    }
    const payload = parseWebhookBody(raw);
    const id = sha256(delivery);
    const reference = ref('github_webhook_inbox', id);
    const saved = await transactDocs([reference], ([current]) => {
      if (current) return { result: { duplicate: true, delivery } };
      return {
        writes: [write('github_webhook_inbox', id, {
          id, delivery_id: delivery, event, action: sanitizeText(payload.action, 80),
          repository: sanitizeText(payload.repository?.full_name, 200),
          payload, status: 'pending', received_at: new Date().toISOString()
        })],
        result: { duplicate: false, delivery }
      };
    });
    return ctx.send(202, saved, PRIVATE_HEADERS);
  }

  async function workerReconcile(ctx) {
    await verifyCrmWorker(ctx, { env, verifyServiceIdentity });
    const input = await ctx.body();
    const checker = new Checker(input);
    const projectId = checker.text('project_id', { required: true, max: 80, min: 1 });
    for (const field of Object.keys(input ?? {})) if (field !== 'project_id') checker.fail(field, 'This field cannot be set here.');
    checker.done();
    validateProjectId(projectId);
    const project = await getDoc('projects', projectId);
    if (!project || project.deleted_at) throw new HttpError(404, 'NOT_FOUND', 'Project not found.');
    const binding = assertBinding(await loadBinding(project), project);
    requireAdapter(adapter);

    // Reconcile only one explicitly selected project; never import a mixed-tenant board.
    const pending = await queryDocs('github_crm_commands', {
      where: [['project_id', '==', project.id], ['status', 'in', ['pending', 'reconciliation_required']]],
      limit: GITHUB_CRM_WORKER_BATCH_SIZE
    });
    let reconciledCommands = 0;
    for (const command of pending.filter((item) => item.client_id === project.client_id).slice(0, GITHUB_CRM_WORKER_BATCH_SIZE)) {
      const actorRef = ref('users', command.actor_id);
      const clientRef = ref('clients', project.client_id);
      const memberRef = ref('memberships', `${project.client_id}__${command.actor_id}`);
      const operatorRef = ref('issuer_operators', command.actor_id);
      const projectRef = ref('projects', project.id);
      const commandRef = ref('github_crm_commands', command.id);
      const authorized = await transactDocs([actorRef, clientRef, memberRef, operatorRef, projectRef, commandRef], ([actor, client, membership, operator, currentProject, current]) => {
        const valid = actor?.status === 'active' && actor.role === 'admin'
          && client && membership?.status === 'active' && membership.role === 'owner'
          && operator?.active === true && currentProject && !currentProject.deleted_at
          && current?.project_id === project.id && current?.status === command.status;
        return { result: valid };
      });
      if (!authorized) continue;
      let result;
      try {
        result = await adapter.reconcile?.(binding, command);
      } catch {
        throw new HttpError(503, 'GITHUB_RECONCILE_FAILED', 'GitHub command reconciliation is temporarily unavailable.', [], { 'Retry-After': '60' });
      }
      if (!result) {
        if (command.status === 'pending') {
          await transactDocs([actorRef, clientRef, memberRef, operatorRef, projectRef, commandRef], ([actor, client, membership, operator, currentProject, current]) => {
            if (actor?.status !== 'active' || actor.role !== 'admin' || !client
              || membership?.status !== 'active' || membership.role !== 'owner' || operator?.active !== true
              || !currentProject || currentProject.deleted_at || !current || current.status !== 'pending') {
              return { result: false };
            }
            const next = {
              ...current,
              status: 'reconciliation_required',
              error_code: 'GITHUB_OUTCOME_UNKNOWN',
              error_message: 'GitHub may have applied this command. Reconcile it before retrying.',
              version: (current.version ?? 0) + 1,
              updated_at: new Date().toISOString()
            };
            return { writes: [write('github_crm_commands', command.id, next)], result: true };
          });
        }
        continue;
      }
      const updated = await transactDocs([actorRef, clientRef, memberRef, operatorRef, projectRef, commandRef], ([actor, client, membership, operator, currentProject, current]) => {
        if (actor?.status !== 'active' || actor.role !== 'admin' || !client
          || membership?.status !== 'active' || membership.role !== 'owner' || operator?.active !== true
          || !currentProject || currentProject.deleted_at || !current || current.status !== command.status) {
          return { result: false };
        }
        const next = {
          ...current, status: 'completed', external_id: result.external_id,
          external_url: result.url ?? null, item_id: result.item_id ?? current.item_id ?? null,
          reconciled_at: new Date().toISOString(), version: (current.version ?? 0) + 1
        };
        return { writes: [write('github_crm_commands', command.id, next)], result: true };
      });
      if (updated) reconciledCommands += 1;
    }

    const inbox = await queryDocs('github_webhook_inbox', { where: [['status', '==', 'pending']], limit: 100 });
    const deliveries = inbox.filter((item) => item.repository?.toLowerCase() === binding.repository.toLowerCase())
      .slice(0, GITHUB_CRM_WORKER_BATCH_SIZE);
    let processedWebhooks = 0;
    if (deliveries.length) {
      const remote = await adapter.readProject(binding);
      const snapshotRef = ref('github_project_snapshots', project.id);
      const refs = [snapshotRef, ...deliveries.map((item) => ref('github_webhook_inbox', item.id))];
      const processed = await transactDocs(refs, ([current, ...currentDeliveries]) => {
        const timestamp = new Date().toISOString();
        const snapshot = {
          id: project.id, project_id: project.id, client_id: project.client_id,
          project: remote.project ?? null,
          items: Array.isArray(remote.items) ? remote.items.slice(0, 100) : [],
          iterations: Array.isArray(remote.iterations) ? remote.iterations.slice(0, 100) : [],
          status_options: Array.isArray(remote.status_options) ? remote.status_options.slice(0, 20) : [],
          synced_at: timestamp, version: (current?.version ?? 0) + 1
        };
        const writes = [write('github_project_snapshots', project.id, snapshot)];
        const processedCount = currentDeliveries.filter((delivery) => delivery?.status === 'pending').length;
        currentDeliveries.forEach((delivery, index) => {
          if (delivery?.status === 'pending') {
            writes.push(write('github_webhook_inbox', deliveries[index].id, {
              ...delivery, status: 'processed', processed_at: timestamp
            }));
          }
        });
        return { writes, result: { processedWebhooks: processedCount } };
      });
      processedWebhooks = processed.processedWebhooks;
    }
    return ctx.send(200, { project_id: project.id, reconciled_commands: reconciledCommands, processed_webhooks: processedWebhooks }, PRIVATE_HEADERS);
  }

  return [
    ['GET', '/api/v1/projects/:project_id/github-crm', getProjectView],
    ['PUT', '/api/v1/projects/:project_id/github-crm/binding', bindProject],
    ['POST', '/api/v1/projects/:project_id/github-crm/sync', syncProject],
    ['POST', '/api/v1/projects/:project_id/github-crm/commands', createCommand],
    ['POST', '/api/v1/projects/:project_id/github-crm/commands/:command_id/retry', retryCommand],
    ['POST', '/api/v1/github-crm/webhooks', webhook],
    ['POST', '/api/v1/github-crm/worker/reconcile', workerReconcile]
  ];
}
