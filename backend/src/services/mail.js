import nodemailer from 'nodemailer';
import { config } from '../config.js';

let transport = null;
/** Messages captured by the in-memory transport (tests read mail from here). */
export const outbox = [];

/** Replace the transport (tests use a stub). Pass null to go back to SMTP. */
export function setMailTransport(next) {
  transport = next;
}
/** Capture every message in `outbox` instead of sending it. */
export function useMemoryMail() {
  outbox.length = 0;
  transport = { sendMail: async (message) => void outbox.push(message) };
}

function smtp() {
  return nodemailer.createTransport({
    host: config.SMTP_HOST,
    port: config.SMTP_PORT,
    secure: config.SMTP_PORT === 465,
    connectionTimeout: 5000,
    greetingTimeout: 5000,
    socketTimeout: 10000,
    ...(config.SMTP_USER ? { auth: { user: config.SMTP_USER, pass: config.SMTP_PASSWORD } } : {}),
  });
}

/**
 * Send one email. Never throws: a mail outage must not break registration or invites, so failures
 * are logged and reported as `false`. In development the SMTP target is Mailpit (localhost:1025).
 */
export async function sendMail({ to, subject, text }) {
  try {
    transport ||= smtp();
    await transport.sendMail({ from: config.EMAIL_FROM, to, subject, text });
    return true;
  } catch (error) {
    console.error(`[mail] could not send "${subject}": ${error.message}`);
    return false;
  }
}

const link = (path) => `${config.APP_URL.replace(/\/$/, '')}${path}`;

export const inviteLink = (token) => link(`/invite/${token}`);

export function sendInviteEmail({ to, token, organizationName, inviterName, role }) {
  return sendMail({
    to,
    subject: `${inviterName} invited you to ${organizationName} on YuktiOps`,
    text: [
      `${inviterName} invited you to join ${organizationName} on YuktiOps as ${role === 'admin' ? 'an admin' : 'a viewer'}.`,
      '',
      `Accept the invitation: ${inviteLink(token)}`,
      '',
      'This link works once and expires in 7 days. If you were not expecting it, ignore this email.',
    ].join('\n'),
  });
}
export function sendVerificationEmail({ to, name, token }) {
  return sendMail({
    to,
    subject: 'Confirm your YuktiOps email',
    text: [
      `Hi ${name},`,
      '',
      `Confirm your email address: ${link(`/verify-email?token=${token}`)}`,
      '',
      'The link works once and expires in 3 days.',
    ].join('\n'),
  });
}
export function sendPasswordResetEmail({ to, name, token }) {
  return sendMail({
    to,
    subject: 'Reset your YuktiOps password',
    text: [
      `Hi ${name},`,
      '',
      `Choose a new password: ${link(`/reset-password?token=${token}`)}`,
      '',
      'The link works once and expires in 1 hour. If you did not ask for this, ignore this email; your password has not changed.',
    ].join('\n'),
  });
}
