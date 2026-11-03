import { createSign, createHmac, timingSafeEqual } from 'node:crypto';
import { OAuth2Client } from 'google-auth-library';
import { HttpError } from './http.mjs';

const API_ORIGIN = 'https://api.github.com';
const GITHUB_ORIGIN = 'https://github.com';
const TOKEN_LIFETIME_SECONDS = 9 * 60;
const MAX_PROJECT_ITEMS = 100;
const MAX_WORKER_BATCH = 10;

function unavailable(message = 'GitHub CRM is not configured.') {
  return new HttpError(503, 'GITHUB_CRM_UNAVAILABLE', message, [], { 'Retry-After': '60' });
}

function appIsConfigured(env) {
  return /^\d+$/.test(String(env.GITHUB_APP_ID ?? '')) && Boolean(String(env.GITHUB_APP_PRIVATE_KEY ?? '').trim());
}

function b64url(value) {
  return Buffer.from(value).toString('base64url');
}

function safeJson(response, text) {
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw Object.assign(new Error('GitHub returned an invalid response.'), {
      status: response.status,
      ambiguous: response.ok || response.status >= 500
    });
  }
}

function apiError(response) {
  const error = new Error(response.status >= 500
    ? 'GitHub is temporarily unavailable.'
    : 'GitHub rejected the requested operation.');
  error.status = response.status;
  error.ambiguous = response.status >= 500 || response.status === 429;
  error.code = response.status === 403 || response.status === 404 ? 'GITHUB_PERMISSION_OR_RESOURCE' : 'GITHUB_API_ERROR';
  return error;
}

function parseRepositoryUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new HttpError(400, 'INVALID_GITHUB_URL', 'Use an exact https://github.com/{owner}/{repository} URL.');
  }
  const parts = url.pathname.split('/').filter(Boolean);
  if (url.protocol !== 'https:' || url.origin !== GITHUB_ORIGIN || url.username || url.password
    || url.search || url.hash || parts.length !== 2 || url.pathname !== `/${parts.join('/')}`
    || url.href !== `${GITHUB_ORIGIN}/${parts.join('/')}`
    || parts.some((part) => !/^[A-Za-z0-9_.-]+$/.test(part) || part === '.' || part === '..')) {
    throw new HttpError(400, 'INVALID_GITHUB_URL', 'Use an exact https://github.com/{owner}/{repository} URL.');
  }
  return { owner: parts[0], name: parts[1], fullName: `${parts[0]}/${parts[1]}` };
}

function parseProjectUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new HttpError(400, 'INVALID_GITHUB_PROJECT_URL', 'Use an exact organization Project v2 URL.');
  }
  const match = /^\/orgs\/([A-Za-z0-9_.-]+)\/projects\/([1-9]\d*)$/.exec(url.pathname);
  if (url.protocol !== 'https:' || url.origin !== GITHUB_ORIGIN || url.username || url.password
    || url.search || url.hash || !match || url.href !== `${GITHUB_ORIGIN}/orgs/${match[1]}/projects/${match[2]}`
    || match[1] === '.' || match[1] === '..') {
    throw new HttpError(400, 'INVALID_GITHUB_PROJECT_URL', 'Use https://github.com/orgs/{organization}/projects/{number}.');
  }
  const number = Number(match[2]);
  if (!Number.isSafeInteger(number)) throw new HttpError(400, 'INVALID_GITHUB_PROJECT_URL', 'Project number is outside the supported range.');
  return { organization: match[1], number };
}

export function parseGithubCrmBinding({ repository_url, project_url }) {
  const repository = parseRepositoryUrl(repository_url);
  const project = parseProjectUrl(project_url);
  if (repository.owner.toLowerCase() !== project.organization.toLowerCase()) {
    throw new HttpError(400, 'GITHUB_ORGANIZATION_MISMATCH', 'The repository and Project v2 board must belong to the same organization.');
  }
  return { ...repository, ...project, repository_url, project_url };
}

/** GitHub App integration. All HTTP targets are fixed API origins and validated path segments. */
export function createGithubAppAdapter(env = process.env, { fetchImpl = globalThis.fetch, now = Date.now } = {}) {
  const cachedTokens = new Map();
  const configured = appIsConfigured(env);

  function appJwt() {
    if (!configured) throw unavailable();
    const issued = Math.floor(now() / 1000) - 30;
    const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const payload = b64url(JSON.stringify({ iat: issued, exp: issued + TOKEN_LIFETIME_SECONDS, iss: env.GITHUB_APP_ID }));
    const unsigned = `${header}.${payload}`;
    const privateKey = String(env.GITHUB_APP_PRIVATE_KEY).replace(/\\n/g, '\n');
    let signature;
    try {
      signature = createSign('RSA-SHA256').update(unsigned).end().sign(privateKey).toString('base64url');
    } catch {
      throw unavailable('GitHub App credentials are invalid.');
    }
    return `${unsigned}.${signature}`;
  }

  async function request(path, { token, method = 'GET', body } = {}) {
    if (!path.startsWith('/') || path.startsWith('//')) throw new Error('Invalid internal GitHub API path.');
    let response;
    try {
      response = await fetchImpl(`${API_ORIGIN}${path}`, {
        method,
        redirect: 'error',
        signal: AbortSignal.timeout(15_000),
        headers: {
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'SGSAI-GitHub-CRM',
          Authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' })
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
      });
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw Object.assign(new Error('Unable to reach GitHub.'), { ambiguous: true, code: 'GITHUB_NETWORK_ERROR' });
    }
    const text = await response.text();
    if (!response.ok) throw apiError(response);
    return safeJson(response, text);
  }

  async function installationToken(installationId, repositoryName) {
    if (!configured) throw unavailable();
    const cacheKey = `${installationId}:${repositoryName}`;
    const cached = cachedTokens.get(cacheKey);
    if (cached?.expiresAt > now() + 60_000) return cached.token;
    const jwt = appJwt();
    const response = await fetchImpl(`${API_ORIGIN}/app/installations/${encodeURIComponent(installationId)}/access_tokens`, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'SGSAI-GitHub-CRM',
        Authorization: `Bearer ${jwt}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(repositoryName ? { repositories: [repositoryName] } : {})
    }).catch(() => { throw Object.assign(new Error('Unable to reach GitHub.'), { ambiguous: true, code: 'GITHUB_NETWORK_ERROR' }); });
    if (!response.ok) throw apiError(response);
    const data = safeJson(response, await response.text());
    if (!data.token || !data.expires_at) throw unavailable('GitHub did not issue an installation token.');
    cachedTokens.set(cacheKey, { token: data.token, expiresAt: Date.parse(data.expires_at) });
    return data.token;
  }

  async function tokenFor(binding) {
    if (!binding?.installation_id || !binding.repository_owner || !binding.repository_name) throw unavailable('The GitHub repository binding is incomplete.');
    return installationToken(binding.installation_id, binding.repository_name);
  }

  async function graph(token, query, variables) {
    let response;
    try {
      response = await fetchImpl(`${API_ORIGIN}/graphql`, {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(20_000),
        headers: {
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'SGSAI-GitHub-CRM',
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ query, variables })
      });
    } catch {
      throw Object.assign(new Error('Unable to reach GitHub.'), { ambiguous: true, code: 'GITHUB_NETWORK_ERROR' });
    }
    const data = safeJson(response, await response.text());
    if (!response.ok || data.errors?.length) throw apiError(response);
    return data.data;
  }

  return {
    configured,
    async resolveProject(organization, number, installationId, repositoryName) {
      const token = await installationToken(installationId, repositoryName);
      const result = await graph(token, `query ProjectCrmBinding($organization: String!, $number: Int!) {
        organization(login: $organization) { projectV2(number: $number) { id title url } }
      }`, { organization, number });
      const project = result?.organization?.projectV2;
      if (!project?.id) throw unavailable('The GitHub organization Project v2 board is unavailable or not permitted.');
      return project;
    },
    async verifyRepository(repository) {
      if (!configured) throw unavailable();
      const [owner, name] = repository.split('/');
      const jwt = appJwt();
      let response;
      try {
        response = await fetchImpl(`${API_ORIGIN}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/installation`, {
          method: 'GET', redirect: 'error', signal: AbortSignal.timeout(15_000),
          headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', Authorization: `Bearer ${jwt}` }
        });
      } catch {
        throw Object.assign(new Error('Unable to verify the repository installation.'), { ambiguous: true });
      }
      if (!response.ok) throw apiError(response);
      const install = safeJson(response, await response.text());
      const token = await installationToken(install.id, name);
      const repo = await request(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`, { token });
      if (repo.full_name?.toLowerCase() !== repository.toLowerCase() || repo.owner?.type !== 'Organization'
        || install.account?.login?.toLowerCase() !== owner.toLowerCase()) {
        throw new HttpError(400, 'GITHUB_INSTALLATION_MISMATCH', 'The selected repository is not available from its organization installation.');
      }
      return {
        id: repo.id,
        full_name: repo.full_name,
        installation_id: install.id,
        organization: repo.owner.login,
        node_id: repo.node_id
      };
    },
    async readProject(binding) {
      const token = await tokenFor(binding);
      const query = `query ProjectCrm($organization: String!, $number: Int!) {
        organization(login: $organization) {
          projectV2(number: $number) {
            id title url
            fields(first: 50) {
              nodes {
                __typename
                ... on ProjectV2IterationField {
                  id name configuration { iterations { id title startDate duration } }
                }
                ... on ProjectV2SingleSelectField { id name options { id name } }
              }
            }
            items(first: ${MAX_PROJECT_ITEMS}) {
              nodes {
                id content {
                  __typename
                  ... on Issue { id number title state url }
                  ... on PullRequest { id number title state url }
                }
                fieldValues(first: 50) {
                  nodes {
                    __typename
                    ... on ProjectV2ItemFieldTextValue { text field { name } }
                    ... on ProjectV2ItemFieldSingleSelectValue { name field { name } }
                    ... on ProjectV2ItemFieldIterationValue { title startDate duration field { name } }
                  }
                }
              }
            }
          }
        }
      }`;
      const result = await graph(token, query, { organization: binding.organization, number: binding.project_v2_number });
      const project = result?.organization?.projectV2;
      if (!project?.id) throw unavailable('The GitHub organization Project v2 board is unavailable or not permitted.');
      const iterations = new Map();
      const statusOptions = [];
      for (const field of project.fields?.nodes ?? []) {
        if (field.__typename === 'ProjectV2IterationField') {
          for (const iteration of field.configuration?.iterations ?? []) {
            iterations.set(iteration.id, {
              id: iteration.id,
              title: iteration.title,
              start_date: iteration.startDate,
              duration: iteration.duration,
              field_id: field.id
            });
          }
        } else if (field.__typename === 'ProjectV2SingleSelectField' && field.name?.toLowerCase() === 'status') {
          statusOptions.push({ field_id: field.id, name: field.name, options: field.options ?? [] });
        }
      }
      const items = (project.items?.nodes ?? []).flatMap((node) => {
        const content = node.content;
        if (!content || !['Issue', 'PullRequest'].includes(content.__typename)) return [];
        let status = null;
        let iteration = null;
        for (const fieldValue of node.fieldValues?.nodes ?? []) {
          if (fieldValue.field?.name?.toLowerCase() === 'status') status = fieldValue.name ?? null;
          if (fieldValue.__typename === 'ProjectV2ItemFieldIterationValue') {
            iteration = fieldValue.title ?? null;
          }
        }
        return [{
          id: node.id,
          type: content.__typename === 'Issue' ? 'issue' : 'pull_request',
          number: content.number,
          title: content.title,
          state: content.state,
          url: content.url,
          status,
          iteration
        }];
      });
      return {
        project: { id: project.id, title: project.title, url: project.url },
        items: items.slice(0, MAX_PROJECT_ITEMS),
        iterations: [...iterations.values()],
        status_options: statusOptions
      };
    },
    async executeCommand(binding, command) {
      const token = await tokenFor(binding);
      if (command.type === 'issue.create') {
        const marker = `<!-- sgsai-github-crm:${command.id} -->`;
        const created = await request(`/repos/${encodeURIComponent(binding.repository_owner)}/${encodeURIComponent(binding.repository_name)}/issues`, {
          token, method: 'POST',
          body: { title: command.title, body: `${command.body ? `${command.body}\n\n` : ''}${marker}` }
        });
        let result;
        try {
          result = await graph(token, `mutation AddProjectItem($project: ID!, $content: ID!) {
            addProjectV2ItemById(input: { projectId: $project, contentId: $content }) { item { id } }
          }`, { project: binding.project_v2_id, content: created.node_id });
        } catch (error) {
          throw Object.assign(error, {
            ambiguous: true,
            external_id: String(created.number),
            external_url: created.html_url,
            content_node_id: created.node_id
          });
        }
        return { external_id: String(created.number), item_id: result.addProjectV2ItemById?.item?.id ?? null, url: created.html_url };
      }
      const input = {
        projectId: binding.project_v2_id,
        itemId: command.item_id,
        fieldId: command.field_id,
        value: command.type === 'issue.status'
          ? { singleSelectOptionId: command.option_id }
          : { iterationId: command.iteration_id }
      };
      const result = await graph(token, `mutation UpdateProjectField($input: UpdateProjectV2ItemFieldValueInput!) {
        updateProjectV2ItemFieldValue(input: $input) { projectV2Item { id } }
      }`, { input });
      return { external_id: result.updateProjectV2ItemFieldValue.projectV2Item.id, item_id: command.item_id };
    },
    async reconcile(binding, command) {
      if (command.type !== 'issue.create') return null;
      const token = await tokenFor(binding);
      const marker = `sgsai-github-crm:${command.id}`;
      const search = `repo:${binding.repository_owner}/${binding.repository_name} in:body "${marker}"`;
      const data = await request(`/search/issues?q=${encodeURIComponent(search)}&per_page=1`, { token });
      const item = data.items?.[0];
      if (!item) return null;
      const added = await graph(token, `mutation AddProjectItem($project: ID!, $content: ID!) {
        addProjectV2ItemById(input: { projectId: $project, contentId: $content }) { item { id } }
      }`, { project: binding.project_v2_id, content: item.node_id });
      return {
        external_id: String(item.number),
        item_id: added.addProjectV2ItemById?.item?.id ?? null,
        url: item.html_url,
        reconciled: true
      };
    }
  };
}

export function verifyGithubWebhookSignature(rawBody, signature, secret) {
  if (!secret || typeof signature !== 'string' || !/^sha256=[a-f0-9]{64}$/i.test(signature)) return false;
  const expected = createHmac('sha256', secret).update(rawBody).digest();
  const provided = Buffer.from(signature.slice(7), 'hex');
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

/** Verifies a Google-issued OIDC service identity. Missing configuration is a hard 503. */
export async function verifyCrmWorker(ctx, { env = process.env, verifyServiceIdentity } = {}) {
  const audience = String(env.GITHUB_CRM_WORKER_AUDIENCE ?? '').trim();
  const serviceEmail = String(env.GITHUB_CRM_WORKER_SERVICE_ACCOUNT ?? '').trim().toLowerCase();
  if (!audience || !serviceEmail) throw unavailable('CRM worker identity is not configured.');
  const authorization = ctx.request?.headers?.authorization ?? '';
  const match = /^Bearer ([^\s]+)$/.exec(authorization);
  if (!match) throw new HttpError(401, 'UNAUTHORIZED', 'A verified worker identity is required.');
  let claims;
  try {
    claims = verifyServiceIdentity
      ? await verifyServiceIdentity(match[1], audience)
      : await new OAuth2Client().verifyIdToken({ idToken: match[1], audience }).then((ticket) => ticket.getPayload());
  } catch {
    throw new HttpError(401, 'UNAUTHORIZED', 'A verified worker identity is required.');
  }
  const email = String(claims?.email ?? '').toLowerCase();
  if (!claims || claims.email_verified !== true || email !== serviceEmail) {
    throw new HttpError(403, 'FORBIDDEN', 'This service identity is not authorized for CRM workers.');
  }
  return claims;
}

export const GITHUB_CRM_WORKER_BATCH_SIZE = MAX_WORKER_BATCH;
