import { Router } from 'express';
import { z } from 'zod';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';
import { assert } from '../lib/errors.js';
import { canAdmin, audit } from '../services/auth.js';
import {
  CONTACT_TYPES,
  allowedContactTypes,
  contactToApi,
  validateContactUrl,
  createTelegramLink,
  telegramConfigured,
  handleTelegramUpdate,
  testContact,
} from '../services/contacts.js';

const name = z.string().trim().min(2).max(80);
const MAX_CONTACTS = 30;

/** Public: Telegram calls this when someone presses Start on our bot. Authenticated by a secret header. */
export function telegramWebhookRoutes(store) {
  const router = Router();
  router.post('/webhook', async (req, res) => {
    const secret = config.TELEGRAM_WEBHOOK_SECRET;
    const given = Buffer.from(String(req.headers['x-telegram-bot-api-secret-token'] || ''));
    const wanted = Buffer.from(secret);
    assert(
      secret && given.length === wanted.length && timingSafeEqual(given, wanted),
      401,
      'Invalid webhook secret.',
    );
    // Telegram retries on errors, so a bad update must still answer 200.
    await handleTelegramUpdate(store, req.body).catch((e) => console.error('Telegram:', e.message));
    res.json({ ok: true });
  });
  return router;
}

export function contactRoutes(store) {
  const router = Router();
  const org = (req) => req.context.orgId;
  const find = async (req) => {
    const row = await store.find('notificationChannel', { id: req.params.id, orgId: org(req) });
    assert(row, 404, 'Contact not found.');
    return row;
  };
  async function assertAllowed(req, type) {
    const allowed = await allowedContactTypes(store, org(req));
    assert(
      allowed.includes(type),
      402,
      'Your Free plan sends alerts by Email and Telegram. Upgrade to add Slack, Discord or Webhook.',
    );
  }

  router.get('/contacts', async (req, res) => {
    const items = (await store.list('notificationChannel', { orgId: org(req) })).sort(
      (a, b) => a.createdAt - b.createdAt,
    );
    res.json({
      items: items.map(contactToApi),
      allowedTypes: await allowedContactTypes(store, org(req)),
      telegram: { configured: telegramConfigured(), botName: config.TELEGRAM_BOT_NAME || null },
    });
  });

  router.get('/contacts/deliveries', async (req, res) => {
    const limit = z.coerce.number().int().min(1).max(200).default(50).parse(req.query.limit);
    const rows = await store.client.notificationDelivery.findMany({
      where: { orgId: org(req) },
      include: { channel: true },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
    res.json({
      items: rows.map((d) => ({
        id: d.id,
        contactId: d.channelId,
        contactName: d.channel.name,
        type: d.channel.type,
        subject: d.subject,
        status: d.status,
        error: d.error,
        createdAt: d.createdAt,
        deliveredAt: d.deliveredAt,
      })),
    });
  });

  router.post('/contacts', canAdmin, async (req, res) => {
    const input = z
      .object({
        type: z.enum(CONTACT_TYPES),
        name,
        address: z.string().trim().email().max(200).optional(),
        url: z.string().trim().url().max(1000).optional(),
      })
      .parse(req.body);
    await assertAllowed(req, input.type);
    assert(
      (await store.list('notificationChannel', { orgId: org(req) })).length < MAX_CONTACTS,
      402,
      `You can add up to ${MAX_CONTACTS} contacts.`,
    );
    const base = { orgId: org(req), name: input.name, type: input.type, enabled: true };
    let row;
    const extra = {};
    if (input.type === 'email') {
      assert(input.address, 400, 'Enter an email address.');
      row = await store.create('notificationChannel', { ...base, address: input.address.toLowerCase() });
    } else if (input.type === 'telegram') {
      assert(telegramConfigured(), 503, 'Telegram is not set up on this server yet.');
      row = await store.create('notificationChannel', { ...base, address: '', enabled: false });
      extra.link = await createTelegramLink(store, row);
    } else {
      assert(input.url, 400, 'Enter the web address to send alerts to.');
      const secret = input.type === 'webhook' ? `whsec_${randomBytes(24).toString('hex')}` : null;
      row = await store.create('notificationChannel', {
        ...base,
        address: validateContactUrl(input.type, input.url),
        secret,
      });
      if (secret) extra.secret = secret;
    }
    await audit(store, req.context, 'contact.created', row.name, { type: row.type });
    res.status(201).json({ ...contactToApi(row), ...extra });
  });

  router.patch('/contacts/:id', canAdmin, async (req, res) => {
    const row = await find(req);
    const input = z
      .object({
        name: name.optional(),
        enabled: z.boolean().optional(),
        address: z.string().trim().email().max(200).optional(),
        url: z.string().trim().url().max(1000).optional(),
      })
      .parse(req.body);
    const data = {};
    if (input.name) data.name = input.name;
    if (input.enabled !== undefined) {
      assert(!input.enabled || row.address, 400, 'Connect this Telegram chat before turning it on.');
      data.enabled = input.enabled;
    }
    if (input.address) {
      assert(row.type === 'email', 400, 'Only email contacts have an address.');
      data.address = input.address.toLowerCase();
    }
    if (input.url) {
      assert(['slack', 'discord', 'webhook'].includes(row.type), 400, 'This contact has no web address.');
      data.address = validateContactUrl(row.type, input.url);
    }
    res.json(contactToApi(await store.update('notificationChannel', row.id, data)));
  });

  router.delete('/contacts/:id', canAdmin, async (req, res) => {
    const row = await find(req);
    const rules = await store.client.alertRule.findMany({
      where: { orgId: org(req), contactIds: { has: row.id } },
    });
    for (const rule of rules)
      await store.update('alertRule', rule.id, {
        contactIds: rule.contactIds.filter((c) => c !== row.id),
      });
    await store.remove('notificationChannel', row.id);
    await audit(store, req.context, 'contact.deleted', row.name, { type: row.type });
    res.status(204).end();
  });

  router.post('/contacts/:id/test', canAdmin, async (req, res) => {
    const row = await find(req);
    res.json(await testContact(store, row));
  });

  router.post('/contacts/:id/telegram-link', canAdmin, async (req, res) => {
    const row = await find(req);
    assert(row.type === 'telegram', 400, 'This is not a Telegram contact.');
    res.json(await createTelegramLink(store, row));
  });

  router.post('/contacts/:id/rotate-secret', canAdmin, async (req, res) => {
    const row = await find(req);
    assert(row.type === 'webhook', 400, 'Only webhook contacts have a signing secret.');
    const secret = `whsec_${randomBytes(24).toString('hex')}`;
    await store.update('notificationChannel', row.id, { secret });
    res.json({ secret });
  });
  return router;
}
