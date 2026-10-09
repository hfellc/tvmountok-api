// Customer emails via SMTP (plain text). Disabled when SMTP_HOST is unset.
import nodemailer from 'nodemailer';

const env = process.env;
const FROM = env.MAIL_FROM || 'TV Mount OK <contact@tvmountok.com>';
const BCC = env.MAIL_BCC || '';
const TZ = env.BUSINESS_TZ || 'America/Chicago';
const PHONE = env.BUSINESS_PHONE || '';
export const mailEnabled = !!(env.SMTP_HOST && env.SMTP_USER && env.SMTP_PASS);

const transport = mailEnabled
  ? nodemailer.createTransport({
      host: env.SMTP_HOST, port: Number(env.SMTP_PORT || 465), secure: Number(env.SMTP_PORT || 465) === 465,
      auth: { user: env.SMTP_USER, pass: env.SMTP_PASS }, connectionTimeout: 15000, socketTimeout: 20000,
    })
  : null;

const when = (iso) => new Date(iso).toLocaleString('en-US', { timeZone: TZ, weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
const first = (n) => String(n).trim().split(/\s+/)[0] || 'there';
const sign = () => `\nTV Mount OK\ncontact@tvmountok.com${PHONE ? '\n' + PHONE : ''}\ntvmountok.com`;

export function ackEmail(l) {
  return {
    subject: 'We got your TV mounting request',
    text: `Hi ${first(l.name)},\n\nThanks for reaching out. We received your request${l.service ? ' for ' + l.service : ''} in ${l.town}.\n\nWe will review the details and reply with a price and available times. If you have photos of the wall or the TV, just reply to this email and attach them.\n${sign()}\n`,
  };
}

export function confirmEmail(l) {
  const lines = [`Hi ${first(l.name)},`, '', 'Your TV mounting appointment is confirmed.', '', `When: ${when(l.scheduled_start)}`];
  if (l.address) lines.push(`Where: ${l.address}`);
  if (l.service) lines.push(`Job: ${l.service}${l.size ? ' (' + l.size + ')' : ''}`);
  if (l.price != null) lines.push(`Price: $${l.price}`);
  lines.push('', 'Need to change the time or cancel? Just reply to this email.', sign(), '');
  return { subject: `Appointment confirmed: ${when(l.scheduled_start)}`, text: lines.join('\n') };
}

export async function sendMail(to, { subject, text }) {
  if (!transport) return { ok: false, error: 'email not configured' };
  try {
    await transport.sendMail({ from: FROM, to, bcc: BCC || undefined, replyTo: 'contact@tvmountok.com', subject, text });
    return { ok: true };
  } catch (e) { console.error('mail error', e.message); return { ok: false, error: e.message.slice(0, 120) }; }
}
