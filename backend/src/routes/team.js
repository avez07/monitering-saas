import { Router } from 'express';
import { z } from 'zod';
import { assert } from '../lib/errors.js';
import {
  canAdmin,
  audit,
  csrfGuard,
  publicUser,
  resolveSession,
  startSession,
} from '../services/auth.js';
import {
  INVITE_ROLES,
  acceptInvite,
  createInvite,
  findOpenInvite,
  inviteStatus,
  publicInvite,
  resendInvite,
} from '../services/invites.js';

const email = z
  .string()
  .trim()
  .email()
  .max(200)
  .transform((v) => v.toLowerCase());

/** Invitation management for admins (cookie session). Member routes live in control.js. */
export function teamRoutes(store, limits) {
  const router = Router();

  router.get('/invites', canAdmin, async (req, res) => {
    const rows = (await store.list('invite', { orgId: req.context.orgId })).sort(
      (a, b) => b.createdAt - a.createdAt,
    );
    res.json(await Promise.all(rows.map((i) => publicInvite(store, i))));
  });
  router.post('/invites', canAdmin, async (req, res) => {
    await limits.use(`invite:${req.context.orgId}`, 1, 30, 3600);
    const input = z
      .object({ email, role: z.enum(INVITE_ROLES) })
      .strict()
      .parse(req.body);
    const invite = await createInvite(store, {
      orgId: req.context.orgId,
      invitedById: req.context.user.id,
      ...input,
    });
    await audit(store, req.context, 'invite.created', invite.email, { role: invite.role });
    res.status(201).json(await publicInvite(store, invite));
  });
  const ownInvite = async (req) => {
    const invite = await store.find('invite', { id: req.params.id, orgId: req.context.orgId });
    assert(invite, 404, 'Invitation not found.');
    return invite;
  };
  router.post('/invites/:id/resend', canAdmin, async (req, res) => {
    const invite = await ownInvite(req);
    await limits.use(`invite-resend:${invite.id}`, 1, 5, 3600);
    res.json(await publicInvite(store, await resendInvite(store, invite)));
  });
  router.delete('/invites/:id', canAdmin, async (req, res) => {
    const invite = await ownInvite(req);
    assert(inviteStatus(invite) === 'pending', 409, 'Only pending invitations can be cancelled.');
    await store.update('invite', invite.id, { revokedAt: new Date() });
    await audit(store, req.context, 'invite.revoked', invite.email);
    res.status(204).end();
  });
  return router;
}

/** The two public invitation routes, reached from the emailed link. */
export function publicInviteRoutes(store, limits) {
  const router = Router();
  router.use(csrfGuard);
  const find = async (req) => {
    await limits.use(`invite-token:${req.ip}`, 1, 60, 600);
    return findOpenInvite(store, req.params.token);
  };

  router.get('/:token', async (req, res) => {
    const invite = await find(req);
    const [org, inviter, existing] = await Promise.all([
      store.find('organization', { id: invite.orgId }),
      store.find('user', { id: invite.invitedById }),
      store.find('user', { email: invite.email }),
    ]);
    res.json({
      email: invite.email,
      role: invite.role,
      organizationName: org.name,
      invitedByName: inviter?.name ?? '',
      expiresAt: invite.expiresAt,
      userExists: Boolean(existing),
    });
  });

  router.post('/:token/accept', async (req, res) => {
    const invite = await find(req);
    const existing = await store.find('user', { email: invite.email });
    let signedIn = null;
    try {
      signedIn = await resolveSession(store, req);
    } catch {
      /* not signed in */
    }
    let user = null;
    let profile = null;
    if (existing) {
      if (!signedIn)
        throw Object.assign(new Error(`Sign in as ${invite.email} to accept this invitation.`), {
          status: 401,
          reason: 'signin_required',
        });
      if (signedIn.id !== existing.id)
        throw Object.assign(
          new Error(`This invitation is for ${invite.email}. Sign out and sign in with that account.`),
          { status: 403, reason: 'wrong_account' },
        );
      user = existing;
    } else {
      if (signedIn)
        throw Object.assign(
          new Error(`This invitation is for ${invite.email}, not the account you are signed in to.`),
          { status: 403, reason: 'wrong_account' },
        );
      profile = z
        .object({
          name: z.string().trim().min(2).max(80),
          password: z.string().min(10).max(128),
        })
        .parse(req.body);
    }
    const result = await acceptInvite(store, invite, { user, profile });
    if (!signedIn) await startSession(store, req, res, result.user);
    const org = await store.find('organization', { id: invite.orgId });
    res.status(existing ? 200 : 201).json({
      user: publicUser({ ...result.user, emailVerifiedAt: result.user.emailVerifiedAt ?? new Date() }),
      organization: { id: org.id, name: org.name },
      role: result.membership.role,
    });
  });
  return router;
}
