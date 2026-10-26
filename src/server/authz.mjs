import { forbidden, notFound } from './http.mjs';
import { getDoc, queryDocs } from './db.mjs';

export const MEMBER_ROLES = ['viewer', 'member', 'admin', 'owner'];
const RANK = Object.fromEntries(MEMBER_ROLES.map((role, index) => [role, index]));

export function membershipId(clientId, userId) {
  return `${clientId}__${userId}`;
}

export function isSgsAdmin(user) {
  return user?.role === 'admin';
}

export function roleAtLeast(role, minimum) {
  return (RANK[role] ?? -1) >= RANK[minimum];
}

export async function getMembership(clientId, userId) {
  const membership = await getDoc('memberships', membershipId(clientId, userId));
  return membership?.status === 'active' ? membership : null;
}

export async function listMembershipsForUser(userId) {
  return queryDocs('memberships', { where: [['user_id', '==', userId], ['status', '==', 'active']] });
}

/**
 * Resolves the caller's effective role on a client. SGS admins act as owners on every client.
 * Unknown clients and non-members both yield 404/403 without revealing which.
 */
export async function requireMembership(user, clientId, minimum = 'viewer') {
  const client = clientId ? await getDoc('clients', clientId) : null;
  if (!client) throw notFound('Workspace not found.');
  if (isSgsAdmin(user)) return { client, role: 'owner', sgsAdmin: true };
  const membership = await getMembership(clientId, user.id);
  if (!membership) throw notFound('Workspace not found.');
  if (!roleAtLeast(membership.role, minimum)) throw forbidden(`This action needs the ${minimum} role in ${client.name}.`);
  return { client, role: membership.role, sgsAdmin: false };
}
