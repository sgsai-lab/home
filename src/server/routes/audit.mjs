import { HttpError } from '../http.mjs';
import { queryDocs } from '../db.mjs';
import { isSgsAdmin, requireMembership } from '../authz.mjs';
import { pageParams, sortAndPage } from '../validation.mjs';

async function listAudit(ctx) {
  const { user } = await ctx.auth();
  const clientId = ctx.query.get('client_id');
  const where = [];
  if (clientId) {
    await requireMembership(user, clientId, 'owner');
    where.push(['client_id', '==', clientId]);
  } else if (!isSgsAdmin(user)) {
    throw new HttpError(403, 'FORBIDDEN', 'Choose a workspace you own.');
  }
  const action = ctx.query.get('action');
  if (action && /^[a-z_.]+$/.test(action)) where.push(['action', '==', action]);
  const params = pageParams(ctx.query, { sortFields: ['ts'], defaultSort: '-ts' });
  const entries = await queryDocs('audit_log', { where, limit: 5000 });
  const page = sortAndPage(entries, params);
  page.items = page.items.map(({ ip_hash: _ipHash, ...entry }) => entry);
  return ctx.send(200, page);
}

export const auditRoutes = [['GET', '/api/v1/audit', listAudit]];
