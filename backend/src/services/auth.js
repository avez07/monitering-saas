import { config } from '../config.js';
import { assert } from '../lib/errors.js';
import { token as newToken, digest } from '../lib/crypto.js';

export const SESSION_COOKIE = 'yuktiops_session';
const IDLE_MS = 7 * 86400000; // sign out after 7 idle days
const ABSOLUTE_MS = 30 * 86400000; // and never keep a session longer than 30 days
const TOUCH_EVERY_MS = 60000;

export const publicUser = ({ id, name, email }) => ({ id, name, email });

const cookieOptions = () => ({
  httpOnly: true,
  sameSite: 'lax',
  secure: config.APP_URL.startsWith('https://'),
  path: '/',
});
function readCookie(req, name) {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const [key, ...value] = part.trim().split('=');
    if (key === name) return decodeURIComponent(value.join('='));
  }
  return null;
}

/** Create a server-side session and set its httpOnly cookie. Only a hash of the token is stored. */
export async function startSession(store, req, res, user) {
  const raw = newToken('ses');
  await store.create('session', {
    userId: user.id,
    tokenHash: digest(raw),
    expiresAt: new Date(Date.now() + ABSOLUTE_MS),
    userAgent: String(req.headers['user-agent'] || '').slice(0, 300),
    ip: String(req.ip || '').slice(0, 64),
  });
  res.cookie(SESSION_COOKIE, raw, { ...cookieOptions(), maxAge: ABSOLUTE_MS });
}
export function clearSessionCookie(res) {
  res.clearCookie(SESSION_COOKIE, cookieOptions());
}
export async function endSession(store, req) {
  const raw = readCookie(req, SESSION_COOKIE);
  const session = raw && (await store.find('session', { tokenHash: digest(raw) }));
  if (session && !session.revokedAt)
    await store.update('session', session.id, { revokedAt: new Date() });
}
export async function endAllSessions(store, userId) {
  for (const s of await store.list('session', { userId, revokedAt: null }))
    await store.update('session', s.id, { revokedAt: new Date() });
}

/** Resolve the signed-in user from the session cookie (no organization needed). */
export async function resolveSession(store, req) {
  const raw = readCookie(req, SESSION_COOKIE);
  assert(raw, 401, 'Sign in to continue.');
  const session = await store.find('session', { tokenHash: digest(raw) });
  const now = Date.now();
  assert(
    session &&
      !session.revokedAt &&
      session.expiresAt.getTime() > now &&
      now - session.lastUsedAt.getTime() < IDLE_MS,
    401,
    'Your session has expired. Please sign in again.',
  );
  if (now - session.lastUsedAt.getTime() > TOUCH_EVERY_MS)
    await store.update('session', session.id, { lastUsedAt: new Date() });
  const user = await store.find('user', { id: session.userId });
  assert(user, 401, 'Account not found.');
  return user;
}

export function auth(store) {
  return async (req, res, next) => {
    try {
      const user = await resolveSession(store, req);
      const memberships = await store.list('organizationMember', { userId: user.id });
      const orgId = req.headers['x-organization-id'] || memberships[0]?.orgId;
      const membership = memberships.find((m) => m.orgId === orgId);
      assert(membership, 403, 'You do not have access to this organization.');
      req.context = { user: publicUser(user), orgId, membership };
      next();
    } catch (error) {
      next(error);
    }
  };
}

/**
 * CSRF protection for cookie-authenticated requests that change data. Browsers always send an
 * Origin header on cross-site writes; we only accept our own dashboard origin.
 */
export function allowedOrigins() {
  const origin = new URL(config.APP_URL);
  const list = [origin.origin];
  if (config.NODE_ENV !== 'production') {
    // Developers open the dev server as either localhost or 127.0.0.1.
    for (const host of ['localhost', '127.0.0.1'])
      list.push(`${origin.protocol}//${host}${origin.port ? `:${origin.port}` : ''}`);
  }
  return list;
}
export function csrfGuard(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const origin = req.headers.origin;
  const ok = origin
    ? allowedOrigins().includes(origin)
    : req.headers['sec-fetch-site'] === 'same-origin';
  if (!ok) return next(Object.assign(new Error('Cross-site request blocked.'), { status: 403 }));
  next();
}

export function permit(...roles) {
  return (req, res, next) => {
    try {
      assert(
        roles.includes(req.context.membership.role),
        403,
        'Your role does not allow this action.',
      );
      next();
    } catch (error) {
      next(error);
    }
  };
}
export const canEdit = permit('owner', 'admin', 'editor');
export const canAdmin = permit('owner', 'admin');
export function requireMemberGrant(context, role, projectIds = []) {
  if (context.membership.role === 'owner') return;
  assert(!['owner', 'admin'].includes(role), 403, 'Only the owner can manage administrators.');
  const allowed = context.membership.projectIds || [];
  assert(
    !allowed.length || (projectIds.length > 0 && projectIds.every((id) => allowed.includes(id))),
    403,
    'A restricted administrator cannot grant access beyond their assigned projects.',
  );
}
export async function visibleProjects(store, context) {
  const rows = await store.list('project', { orgId: context.orgId });
  const assigned = context.membership.projectIds || [];
  return rows.filter((p) => !p.deletedAt && (!assigned.length || assigned.includes(p.id)));
}
export async function requireProject(store, context, projectId) {
  assert(
    (await visibleProjects(store, context)).some((p) => p.id === projectId),
    404,
    'Project not found.',
  );
  return projectId;
}
export async function scopedRows(store, context, table, filters = {}) {
  const projects = new Set((await visibleProjects(store, context)).map((p) => p.id));
  const rows = await store.list(table, { orgId: context.orgId, ...filters });
  return rows.filter((r) => !r.deletedAt && (!r.projectId || projects.has(r.projectId)));
}
export async function requireRow(store, context, table, id) {
  const row = (await scopedRows(store, context, table)).find((r) => r.id === id);
  assert(row, 404, 'Record not found.');
  return row;
}
export function credentialAuth(store) {
  return async (req, res, next) => {
    try {
      const raw = req.headers.authorization?.replace(/^Bearer /, '');
      assert(raw, 401, 'An agent credential is required.');
      const credential = await store.find('agentCredential', { tokenHash: digest(raw) });
      assert(
        credential &&
          !credential.revokedAt &&
          (!credential.expiresAt || new Date(credential.expiresAt) > new Date()),
        401,
        'Invalid or revoked agent credential.',
      );
      const project = await store.find('project', {
        id: credential.projectId,
        orgId: credential.orgId,
      });
      assert(project && !project.deletedAt, 403, 'Project is unavailable.');
      req.credential = credential;
      next();
    } catch (error) {
      next(error);
    }
  };
}
export const audit = (store, context, action, target, details = {}) =>
  store.create('auditLog', {
    orgId: context.orgId,
    userId: context.user.id,
    action,
    target,
    details,
  });
