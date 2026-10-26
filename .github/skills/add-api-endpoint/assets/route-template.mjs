// Template: a route table entry in src/server/routes/<area>.mjs (register the table in server.mjs).
// Replace widget/Widget names.
import { HttpError } from '../http.mjs';
import { getDoc, newId, queryDocs, setDoc, updateDoc } from '../db.mjs';
import { requireMembership } from '../authz.mjs';
import { Checker } from '../validation.mjs';

async function listWidgets(ctx) {
  const { user } = await ctx.auth();
  const clientId = ctx.query.get('client_id');
  await requireMembership(user, clientId);
  const items = await queryDocs('widgets', { where: [['client_id', '==', clientId]] });
  return ctx.send(200, { items, total: items.length });
}

async function createWidget(ctx) {
  const { user } = await ctx.auth();
  ctx.limit('mutations', user.id);
  const check = new Checker(await ctx.body());
  const clientId = check.text('client_id', { required: true, max: 80 });
  const name = check.text('name', { required: true, max: 120 });
  check.done();
  await requireMembership(user, clientId, 'admin');
  const widget = { id: newId('wdg'), client_id: clientId, name, created_at: new Date().toISOString() };
  await setDoc('widgets', widget.id, widget);
  await ctx.audit('widget.created', { type: 'widget', id: widget.id }, { actorId: user.id, clientId });
  return ctx.send(201, widget);
}

async function renameWidget(ctx) {
  const { user } = await ctx.auth();
  const widget = await getDoc('widgets', ctx.params.id);
  if (!widget) throw new HttpError(404, 'NOT_FOUND', 'Widget not found.');
  await requireMembership(user, widget.client_id, 'admin');
  const check = new Checker(await ctx.body());
  const name = check.text('name', { required: true, max: 120 });
  check.done();
  const { after } = await updateDoc('widgets', widget.id, (current) => current && { ...current, name });
  return ctx.send(200, after);
}

export const widgetRoutes = [
  ['GET', '/api/v1/widgets', listWidgets],
  ['POST', '/api/v1/widgets', createWidget],
  ['PATCH', '/api/v1/widgets/:id', renameWidget]
];
