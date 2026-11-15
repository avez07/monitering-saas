import nodemailer from 'nodemailer';
import { createHmac, randomBytes } from 'node:crypto';
import { isIP } from 'node:net';
import { config } from '../config.js';
import { assert } from '../lib/errors.js';
import { digest } from '../lib/crypto.js';
import { safeRequest, isPublicAddress } from './uptime.js';
import { entitlements } from './limits.js';

export const CONTACT_TYPES = ['email', 'telegram', 'slack', 'discord', 'webhook'];
export const FREE_CONTACT_TYPES = ['email', 'telegram'];
export const TELEGRAM_LINK_MINUTES = 15;

/** Which contact types a plan may use. Free is Email + Telegram; paid plans get everything. */
export async function allowedContactTypes(store, orgId) {
  const { plan } = await entitlements(store, orgId);
  return plan.id === 'free' ? FREE_CONTACT_TYPES : CONTACT_TYPES;
}

// ---- Outbound transports (replaceable in tests so nothing touches the network) ----------------------

const defaultEmail = async ({ to, subject, text }) => {
  if (config.EMAIL_PROVIDER !== 'smtp') return 'local';
  const smtp = nodemailer.createTransport({
    host: config.SMTP_HOST,
    port: config.SMTP_PORT,
    secure: config.SMTP_PORT === 465,
    ...(config.SMTP_USER ? { auth: { user: config.SMTP_USER, pass: config.SMTP_PASSWORD } } : {}),
  });
  await smtp.sendMail({ from: config.EMAIL_FROM, to, subject, text });
  return 'delivered';
};
/** JSON POST through the SSRF guard: public addresses only, no redirects. */
const defaultHttp = async ({ url, headers = {}, body }) => {
  const response = await safeRequest(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body,
    timeoutMs: 8000,
    maxBytes: 4096,
    maxRedirects: 0,
  });
  return { status: response.status, body: response.body };
};
export const transports = { email: defaultEmail, http: defaultHttp };
const originals = { ...transports };
/** Replace transports (tests). Call `resetTransports` afterwards. */
export function setTransports(overrides) {
  Object.assign(transports, overrides);
}
export function resetTransports() {
  Object.assign(transports, originals);
}

// ---- Validation and masking --------------------------------------------------------------------------

const SLACK_HOSTS = ['hooks.slack.com'];
const DISCORD_HOSTS = ['discord.com', 'discordapp.com', 'ptb.discord.com', 'canary.discord.com'];

/** Syntax-level check of a destination URL. DNS and address rules are enforced again at send time. */
export function validateContactUrl(type, value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    assert(false, 400, 'Enter a valid web address.');
  }
  assert(!url.username && !url.password, 400, 'Remove the username or password from the address.');
  if (type === 'slack') {
    assert(url.protocol === 'https:' && SLACK_HOSTS.includes(url.hostname), 400, 'Use a Slack incoming webhook address (https://hooks.slack.com/...).');
  } else if (type === 'discord') {
    assert(
      url.protocol === 'https:' && DISCORD_HOSTS.includes(url.hostname) && url.pathname.startsWith('/api/webhooks/'),
      400,
      'Use a Discord webhook address (https://discord.com/api/webhooks/...).',
    );
  } else {
    assert(['https:', 'http:'].includes(url.protocol), 400, 'Use an http or https address.');
    const host = url.hostname.replace(/^\[|\]$/g, '');
    assert(
      host !== 'localhost' && !host.endsWith('.local') && !(isIP(host) && !isPublicAddress(host)),
      400,
      'Webhooks must point to a publicly reachable address.',
    );
  }
  return url.toString();
}
export function maskUrl(value) {
  try {
    const url = new URL(value);
    return `${url.hostname}/…${value.slice(-4)}`;
  } catch {
    return '••••';
  }
}

export function contactToApi(channel) {
  const connected = channel.type !== 'telegram' || !!channel.address;
  let target;
  if (channel.type === 'email') target = channel.address;
  else if (channel.type === 'telegram') target = connected ? channel.meta?.chat || 'Telegram chat' : 'Not linked yet';
  else target = maskUrl(channel.address);
  return {
    id: channel.id,
    type: channel.type,
    name: channel.name,
    enabled: channel.enabled,
    status: connected ? 'connected' : 'pending',
    target,
    lastTest: channel.lastTestAt
      ? { at: channel.lastTestAt, ok: channel.lastTestOk, error: channel.lastTestError }
      : null,
    createdAt: channel.createdAt,
  };
}

// ---- Telegram link flow ------------------------------------------------------------------------------

export const telegramConfigured = () => !!(config.TELEGRAM_BOT_TOKEN && config.TELEGRAM_BOT_NAME);

/** Create a one-time code and the t.me deep link for it. */
export async function createTelegramLink(store, channel, now = Date.now()) {
  assert(telegramConfigured(), 503, 'Telegram is not set up on this server yet.');
  const code = randomBytes(18).toString('base64url');
  const expiresAt = new Date(now + TELEGRAM_LINK_MINUTES * 60000);
  await store.update('notificationChannel', channel.id, {
    linkCodeHash: digest(code),
    linkExpiresAt: expiresAt,
  });
  return { url: `https://t.me/${config.TELEGRAM_BOT_NAME}?start=${code}`, code, expiresAt };
}

async function telegramSend(chatId, text) {
  const response = await transports.http({
    url: `https://api.telegram.org/bot${config.TELEGRAM_BOT_TOKEN}/sendMessage`,
    body: JSON.stringify({ chat_id: chatId, text }),
  });
  assert(response.status >= 200 && response.status < 300, 502, `Telegram refused the message (${response.status}).`);
}

/** Handle one update from Telegram's webhook: "/start <code>" binds the chat to the contact. */
export async function handleTelegramUpdate(store, update, now = Date.now()) {
  const message = update?.message;
  const match = /^\/start(?:@\w+)?\s+([\w-]{10,64})\s*$/.exec(message?.text || '');
  const chatId = message?.chat?.id;
  if (!match || chatId == null) return { handled: false };
  const channel = await store.find('notificationChannel', { linkCodeHash: digest(match[1]) });
  if (!channel || !channel.linkExpiresAt || new Date(channel.linkExpiresAt).getTime() < now) {
    await telegramSend(chatId, 'This link has expired. Create a new one in YuktiOps under Alerts > Where to send alerts.').catch(() => {});
    return { handled: false };
  }
  const chat = message.chat.title || message.chat.username || message.from?.first_name || 'Telegram chat';
  await store.update('notificationChannel', channel.id, {
    address: String(chatId),
    meta: { chat },
    enabled: true,
    linkCodeHash: null,
    linkExpiresAt: null,
  });
  await telegramSend(chatId, `Connected. YuktiOps alerts for "${channel.name}" will arrive in this chat.`).catch(() => {});
  return { handled: true, channelId: channel.id };
}

// ---- Delivery ----------------------------------------------------------------------------------------

export const signWebhook = (secret, timestamp, body) =>
  `sha256=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`;

/**
 * Send one message to one contact. `payload` is the structured form used by webhooks.
 * Returns 'delivered' | 'local'; throws an Error with a plain message on failure.
 */
export async function sendToContact(channel, { subject, text, payload }) {
  switch (channel.type) {
    case 'email':
      return transports.email({ to: channel.address, subject, text });
    case 'telegram': {
      assert(channel.address, 400, 'This Telegram contact is not linked yet.');
      await telegramSend(channel.address, `${subject}\n\n${text}`);
      return 'delivered';
    }
    case 'slack':
    case 'discord': {
      const body = JSON.stringify(channel.type === 'slack' ? { text: `*${subject}*\n${text}` } : { content: `**${subject}**\n${text}` });
      const response = await transports.http({ url: channel.address, body });
      assert(response.status >= 200 && response.status < 300, 502, `${channel.type === 'slack' ? 'Slack' : 'Discord'} refused the message (${response.status}).`);
      return 'delivered';
    }
    case 'webhook': {
      const body = JSON.stringify(payload ?? { event: 'test', message: text });
      const timestamp = String(Math.floor(Date.now() / 1000));
      const response = await transports.http({
        url: channel.address,
        headers: {
          'x-yuktiops-timestamp': timestamp,
          'x-yuktiops-signature': signWebhook(channel.secret || '', timestamp, body),
        },
        body,
      });
      assert(response.status >= 200 && response.status < 300, 502, `The webhook answered with status ${response.status}.`);
      return 'delivered';
    }
    default:
      throw new Error('Unknown contact type.');
  }
}

const plainError = (error) =>
  /blocked|publicly routable/.test(error.message)
    ? 'That address is not allowed (it must be public).'
    : error.code === 'timeout' || /timeout/i.test(error.message)
      ? 'The destination did not answer in time.'
      : String(error.message).slice(0, 200);

/** The "Send test" button. Never throws; records the outcome on the contact. */
export async function testContact(store, channel) {
  let ok = true;
  let error = null;
  try {
    await sendToContact(channel, {
      subject: 'YuktiOps test message',
      text: 'This is a test alert from YuktiOps. If you can read this, alerts will reach you here.',
      payload: {
        event: 'test',
        sentAt: new Date().toISOString(),
        message: 'This is a test alert from YuktiOps.',
        url: `${config.APP_URL}/alerts`,
      },
    });
  } catch (e) {
    ok = false;
    error = plainError(e);
  }
  await store.update('notificationChannel', channel.id, { lastTestAt: new Date(), lastTestOk: ok, lastTestError: error });
  return ok ? { ok: true } : { ok: false, error };
}

/** Send every due, pending delivery. `now` is injectable for tests. */
export async function deliverNotifications(store, orgId, { now = Date.now() } = {}) {
  const pending = await store.client.notificationDelivery.findMany({
    where: { status: 'pending', nextAttemptAt: { lte: new Date(now) }, ...(orgId ? { orgId } : {}) },
    include: { channel: true },
    take: 500,
  });
  for (const delivery of pending) {
    try {
      const outcome = await sendToContact(delivery.channel, {
        subject: delivery.subject,
        text: delivery.body,
        payload: delivery.payload,
      });
      await store.update('notificationDelivery', delivery.id, {
        status: outcome === 'local' ? 'local' : 'delivered',
        attempts: delivery.attempts + 1,
        deliveredAt: new Date(now),
        error: null,
      });
    } catch (error) {
      const attempts = delivery.attempts + 1;
      await store.update('notificationDelivery', delivery.id, {
        attempts,
        status: attempts >= 5 ? 'failed' : 'pending',
        error: plainError(error),
        nextAttemptAt: new Date(now + Math.min(3600, 30 * 2 ** attempts) * 1000),
      });
    }
  }
}

/** Point Telegram at our webhook (best effort at worker start; needs a public https API address). */
export async function registerTelegramWebhook() {
  if (!telegramConfigured() || !config.TELEGRAM_WEBHOOK_SECRET || !config.API_PUBLIC_URL.startsWith('https://'))
    return false;
  const response = await transports.http({
    url: `https://api.telegram.org/bot${config.TELEGRAM_BOT_TOKEN}/setWebhook`,
    body: JSON.stringify({
      url: `${config.API_PUBLIC_URL}/api/contacts/telegram/webhook`,
      secret_token: config.TELEGRAM_WEBHOOK_SECRET,
      allowed_updates: ['message'],
    }),
  });
  return response.status === 200;
}
