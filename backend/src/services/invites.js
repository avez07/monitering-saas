import { assert } from '../lib/errors.js';
import { token as newToken, digest, hashPassword } from '../lib/crypto.js';
import { enforceCount } from './limits.js';
import { sendInviteEmail } from './mail.js';

export const INVITE_TTL_MS = 7 * 86400000;
export const INVITE_ROLES = ['admin', 'viewer'];

export const inviteStatus = (invite, now = Date.now()) =>
  invite.acceptedAt
    ? 'accepted'
    : invite.revokedAt
      ? 'revoked'
      : invite.expiresAt.getTime() <= now
        ? 'expired'
        : 'pending';

export async function publicInvite(store, invite) {
  const inviter = await store.find('user', { id: invite.invitedById });
  return {
    id: invite.id,
    email: invite.email,
    role: invite.role,
    status: inviteStatus(invite),
    expiresAt: invite.expiresAt,
    createdAt: invite.createdAt,
    invitedByName: inviter?.name ?? '',
  };
}

/** Members plus invitations still open: both take a seat on the plan. */
async function seatsTaken(store, orgId) {
  const members = (await store.list('organizationMember', { orgId })).length;
  const open = (await store.list('invite', { orgId, acceptedAt: null, revokedAt: null })).filter(
    (i) => inviteStatus(i) === 'pending',
  ).length;
  return members + open;
}

async function deliver(store, invite, raw) {
  const [org, inviter] = await Promise.all([
    store.find('organization', { id: invite.orgId }),
    store.find('user', { id: invite.invitedById }),
  ]);
  return sendInviteEmail({
    to: invite.email,
    token: raw,
    organizationName: org.name,
    inviterName: inviter?.name ?? 'A teammate',
    role: invite.role,
  });
}

export async function createInvite(store, { orgId, email, role, invitedById }) {
  const existing = (await store.list('user', { email }))[0];
  if (existing)
    assert(
      !(await store.find('organizationMember', { orgId, userId: existing.id })),
      409,
      'This person is already a member of your organization.',
    );
  const open = (await store.list('invite', { orgId, email, acceptedAt: null, revokedAt: null })).find(
    (i) => inviteStatus(i) === 'pending',
  );
  assert(!open, 409, 'This email already has a pending invitation. Resend it instead.');
  await enforceCount(store, orgId, 'members', await seatsTaken(store, orgId));
  const raw = newToken('inv');
  const invite = await store.create('invite', {
    orgId,
    email,
    role,
    invitedById,
    tokenHash: digest(raw),
    expiresAt: new Date(Date.now() + INVITE_TTL_MS),
  });
  await deliver(store, invite, raw);
  return invite;
}

/** A fresh token (the old link stops working) and a fresh seven days. */
export async function resendInvite(store, invite) {
  assert(inviteStatus(invite) === 'pending', 409, 'Only pending invitations can be resent.');
  const raw = newToken('inv');
  const updated = await store.update('invite', invite.id, {
    tokenHash: digest(raw),
    expiresAt: new Date(Date.now() + INVITE_TTL_MS),
  });
  await deliver(store, updated, raw);
  return updated;
}

/** Look an invitation up by its emailed token; 404 for unknown, 410 (with a reason) for finished ones. */
export async function findOpenInvite(store, raw) {
  const invite = await store.find('invite', { tokenHash: digest(String(raw)) });
  assert(invite, 404, 'This invitation link is not valid.');
  const status = inviteStatus(invite);
  if (status !== 'pending') {
    const reason = { accepted: 'used', revoked: 'revoked', expired: 'expired' }[status];
    const message = {
      used: 'This invitation was already used.',
      revoked: 'This invitation was cancelled.',
      expired: 'This invitation has expired. Ask your teammate to send a new one.',
    }[reason];
    throw Object.assign(new Error(message), { status: 410, reason });
  }
  return invite;
}

/**
 * Join the organization. `user` is the signed-in account (must own the invited email) or null, in
 * which case a new account is created from `profile`. The invitation is claimed atomically, so two
 * simultaneous clicks cannot both succeed.
 */
export async function acceptInvite(store, invite, input) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await acceptOnce(store, invite, input);
    } catch (error) {
      // Two accepts racing: the loser retries and then finds the invitation already used (410).
      if (attempt < 3 && ['P2034', 'P2002'].includes(error.code)) continue;
      throw error;
    }
  }
}

function acceptOnce(store, invite, { user, profile }) {
  return store.transaction(async (tx) => {
    const claimed = await tx.claim(
      'invite',
      invite.id,
      { acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } },
      { acceptedAt: new Date() },
    );
    if (!claimed)
      throw Object.assign(new Error('This invitation was already used.'), { status: 410, reason: 'used' });
    // Seats are checked again: other invitations may have been accepted since this one was sent.
    const members = (await tx.list('organizationMember', { orgId: invite.orgId })).length;
    await enforceCount(tx, invite.orgId, 'members', members);
    let account = user;
    if (!account) {
      account = await tx.create('user', {
        name: profile.name,
        email: invite.email,
        passwordHash: hashPassword(profile.password),
        // They proved they own the address by opening the emailed link.
        emailVerifiedAt: new Date(),
      });
    } else if (!account.emailVerifiedAt) {
      await tx.update('user', account.id, { emailVerifiedAt: new Date() });
    }
    assert(
      !(await tx.find('organizationMember', { orgId: invite.orgId, userId: account.id })),
      409,
      'You are already a member of this organization.',
    );
    const membership = await tx.create('organizationMember', {
      orgId: invite.orgId,
      userId: account.id,
      role: invite.role,
      projectIds: [],
    });
    return { user: account, membership };
  });
}
