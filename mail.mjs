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

// ---- HTML layout: table-based, inline styles, web-safe fonts so Outlook (Word engine) renders it like Gmail/Apple Mail ----
const FONT = 'Arial, Helvetica, sans-serif';
const esc = (v) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const telHref = PHONE.replace(/[^\d+]/g, '').replace(/^(\d{10})$/, '+1$1');

const para = (t) => `<p style="margin:0 0 16px 0;font-family:${FONT};font-size:16px;line-height:24px;color:#2b2b33;">${t}</p>`;

const detailsTable = (rows) => `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#f4f6fb" style="background-color:#f4f6fb;border-left:4px solid #2a4bff;margin:0 0 20px 0;"><tr><td style="padding:14px 18px;">
${rows.map(([k, v]) => `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"><tr><td width="80" valign="top" style="font-family:${FONT};font-size:13px;line-height:22px;color:#6b7080;text-transform:uppercase;letter-spacing:0.5px;">${k}</td><td valign="top" style="font-family:${FONT};font-size:16px;line-height:22px;color:#0b0b10;font-weight:bold;">${v}</td></tr></table>`).join('\n')}
</td></tr></table>`;

const signature = () => `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin-top:28px;"><tr><td style="border-top:2px solid #2a4bff;padding-top:18px;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
<td valign="top" style="padding-right:20px;"><img src="cid:tvmok-logo" width="200" alt="TV Mount OK" style="display:block;width:200px;height:auto;border:0;outline:none;"></td>
<td valign="top" style="border-left:1px solid #d7dbe6;padding-left:20px;font-family:${FONT};font-size:14px;line-height:22px;color:#2b2b33;">
<b style="font-size:15px;color:#0b0b10;">TV Mount OK</b><br>
<span style="color:#6b7080;">TV mounting &middot; Sapulpa, Tulsa &amp; 50 miles</span><br>
${PHONE ? `<a href="tel:${esc(telHref)}" style="color:#2a4bff;text-decoration:none;">${esc(PHONE)}</a><br>` : ''}
<a href="mailto:contact@tvmountok.com" style="color:#2a4bff;text-decoration:none;">contact@tvmountok.com</a><br>
<a href="https://tvmountok.com" style="color:#2a4bff;text-decoration:none;">tvmountok.com</a>
</td></tr></table>
</td></tr></table>`;

function wrap(preheader, body) {
  return `<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><meta name="supported-color-schemes" content="light">
<!--[if mso]><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml><![endif]-->
<title>TV Mount OK</title></head>
<body style="margin:0;padding:0;background-color:#eef0f5;">
<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;line-height:1px;color:#eef0f5;">${esc(preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#eef0f5" style="background-color:#eef0f5;"><tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" bgcolor="#ffffff" style="width:100%;max-width:600px;background-color:#ffffff;">
<tr><td height="6" bgcolor="#2a4bff" style="background-color:#2a4bff;font-size:0;line-height:0;">&nbsp;</td></tr>
<tr><td style="padding:32px 36px 28px 36px;">${body}${signature()}</td></tr>
</table>
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;"><tr><td align="center" style="padding:16px 12px;font-family:${FONT};font-size:12px;line-height:18px;color:#8a8fa0;">TV Mount OK LLC &middot; Sapulpa, Oklahoma<br>You are receiving this because you requested a TV mounting quote.</td></tr></table>
</td></tr></table>
</body></html>`;
}

const logoAttachment = { filename: 'tv-mount-ok.png', path: new URL('./assets/email-logo.png', import.meta.url).pathname, cid: 'tvmok-logo', contentDisposition: 'inline' };

export function ackEmail(l) {
  const text = `Hi ${first(l.name)},\n\nThanks for reaching out. We received your request${l.service ? ' for ' + l.service : ''} in ${l.town}.\n\nWe will review the details and reply with a price and available times. If you have photos of the wall or the TV, just reply to this email and attach them.\n${sign()}\n`;
  const html = wrap('We received your request and will reply with a price and times.',
    para(`Hi ${esc(first(l.name))},`) +
    para(`Thanks for reaching out. We received your request${l.service ? ' for <b>' + esc(l.service) + '</b>' : ''} in ${esc(l.town)}.`) +
    para('We will review the details and reply with a price and available times. If you have photos of the wall or the TV, just reply to this email and attach them.'));
  return { subject: 'We got your TV mounting request', text, html };
}

export function confirmEmail(l) {
  const lines = [`Hi ${first(l.name)},`, '', 'Your TV mounting appointment is confirmed.', '', `When: ${when(l.scheduled_start)}`];
  const rows = [['When', esc(when(l.scheduled_start))]];
  if (l.address) { lines.push(`Where: ${l.address}`); rows.push(['Where', esc(l.address)]); }
  if (l.service) { const j = `${l.service}${l.size ? ' (' + l.size + ')' : ''}`; lines.push(`Job: ${j}`); rows.push(['Job', esc(j)]); }
  if (l.price != null) { lines.push(`Price: $${l.price}`); rows.push(['Price', '$' + esc(l.price)]); }
  lines.push('', 'Need to change the time or cancel? Just reply to this email.', sign(), '');
  const html = wrap(`Confirmed: ${when(l.scheduled_start)}`,
    para(`Hi ${esc(first(l.name))},`) + para('Your TV mounting appointment is <b>confirmed</b>.') + detailsTable(rows) +
    para('Need to change the time or cancel? Just reply to this email.'));
  return { subject: `Appointment confirmed: ${when(l.scheduled_start)}`, text: lines.join('\n'), html };
}

export async function sendMail(to, { subject, text, html }) {
  if (!transport) return { ok: false, error: 'email not configured' };
  try {
    await transport.sendMail({ from: FROM, to, bcc: BCC || undefined, replyTo: 'contact@tvmountok.com', subject, text, html, attachments: html ? [logoAttachment] : undefined });
    return { ok: true };
  } catch (e) { console.error('mail error', e.message); return { ok: false, error: e.message.slice(0, 120) }; }
}
