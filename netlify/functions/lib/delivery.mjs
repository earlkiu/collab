/**
 * What happens to a collab application after Notion has it.
 *
 *   1. Render the submission as a PDF
 *   2. Email it to Earl with the PDF attached (Resend)
 *   3. Put the same PDF in Google Drive
 *
 * All three are best effort and run after the Notion writes. Nothing here is
 * allowed to cost the submission — the Notion row is the thing that must not
 * be lost, and the raw submission is in Netlify's Forms dashboard regardless.
 *
 * Step 3 is inert until GOOGLE_SERVICE_ACCOUNT_JSON and GDRIVE_FOLDER_ID are
 * set. It logs that it skipped rather than failing, so the email still goes.
 *
 * Environment:
 *   RESEND_API_KEY                — already set for booking-email
 *   APPLICATION_EMAIL_TO          — optional, defaults to itsme@earlkiu.com
 *   GOOGLE_SERVICE_ACCOUNT_JSON   — the whole service account key file, as JSON
 *   GDRIVE_FOLDER_ID              — the folder, shared with the service account
 */

import crypto from 'node:crypto';
import { buildPdf } from './pdf.mjs';

const TO = () => (process.env.APPLICATION_EMAIL_TO || 'itsme@earlkiu.com');
const FROM = 'Earl Kiu <hello@earlkiu.com>';

const t = (v) => (v == null ? '' : String(v).trim());

function fileUrl(v) {
  const raw = typeof v === 'string' ? v : (v && (v.url || v.href)) || '';
  const url = t(raw);
  return /^https?:\/\//i.test(url) ? url : '';
}

function prettyDate(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString('en-GB', {
    day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Kuala_Lumpur',
  });
}

export function measurementLine(d) {
  const parts = [
    ['Height', t(d.Height), 'cm'],
    ['Bust or chest', t(d['Bust or chest']), 'cm'],
    ['Waist', t(d.Waist), 'cm'],
    ['Hips', t(d.Hips), 'cm'],
    ['Dress or suit', t(d['Dress or suit size']), 'EU'],
    ['Shoe', t(d['Shoe size']), 'EU'],
  ].filter(([, v]) => v);
  return parts.map(([label, v, unit]) => `${label} ${v}${unit ? ' ' + unit : ''}`).join(' · ');
}

export function agencyLine(d) {
  const signed = t(d.Agency);
  if (!signed) return '';
  const name = t(d['Agency name']);
  if (signed !== 'Signed with an agency') return 'Not signed';
  return name ? `Signed — ${name}` : 'Signed — agency not named';
}

/* ---------- the document ---------- */

const FIELDS = [
  ['Email', (d) => t(d.Email)],
  ['Instagram', (d) => t(d.Instagram)],
  ['Based in', (d) => t(d['Based in'])],
  ['Date of birth', (d) => t(d['Date of birth'])],
  ['How they found it', (d) => t(d['How they found it'])],
  ['Referred by', (d) => t(d['Referred by'])],
  ['Who they are', (d) => t(d['Who they are'])],
  ['References', (d) => t(d.References)],
  ['Experience', (d) => t(d.Experience)],
  ['Agency', agencyLine],
  ['Measurements', measurementLine],
  ['Comfort level', (d) => t(d['Comfort level'])],
  ['Limits', (d) => t(d.Limits)],
];

const CONSENTS = [
  ['Usage consent', 'Usage consent'],
  ['Usage limits accepted', 'Usage limits accepted'],
  ['Age confirmation', 'Age confirmation'],
  ['Contact consent', 'Contact consent'],
];

export function applicationPdf(d, fullName, submitted) {
  const blocks = [
    { text: fullName, size: 17, bold: true, after: 4 },
    { text: `Collab application — ${prettyDate(submitted)}`, size: 9, after: 12 },
    { rule: true, after: 18 },
  ];

  for (const [label, get] of FIELDS) {
    const value = get(d);
    if (!value) continue;
    blocks.push({ text: label.toUpperCase(), size: 7.5, bold: true, after: 3 });
    blocks.push({ text: value, size: 10, after: 12 });
  }

  const photos = ['Photo 1', 'Photo 2', 'Photo 3'].map((k) => fileUrl(d[k])).filter(Boolean);
  if (photos.length) {
    blocks.push({ text: 'PHOTOGRAPHS', size: 7.5, bold: true, after: 3 });
    // The URLs go in as text on purpose. They are Netlify submission links and
    // they are the only copy of the files; a PDF that hides them behind an
    // annotation is a PDF you cannot read the link out of.
    blocks.push({ text: photos.join('\n'), size: 9, after: 12 });
  }

  blocks.push({ rule: true, before: 4, after: 14 });
  blocks.push({ text: 'CONFIRMED AT SUBMISSION', size: 7.5, bold: true, after: 4 });
  for (const [label, key] of CONSENTS) {
    const agreed = t(d[key]).toLowerCase() === 'agreed';
    blocks.push({ text: `${agreed ? '[x]' : '[ ]'}  ${label}`, size: 9.5, after: 2 });
  }

  return buildPdf(blocks);
}

export function fileName(fullName, submitted) {
  const slug = fullName.normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-').toLowerCase();
  return `collab-${slug || 'application'}-${submitted}.pdf`;
}

/* ---------- email ---------- */

function emailBody(d, fullName, submitted, notice) {
  const lines = [];
  if (notice) lines.push(notice, '');
  lines.push(`${fullName} — collab application, ${prettyDate(submitted)}`, '');
  for (const [label, get] of FIELDS) {
    const value = get(d);
    if (value) lines.push(`${label}: ${value}`);
  }
  const photos = ['Photo 1', 'Photo 2', 'Photo 3'].map((k) => fileUrl(d[k])).filter(Boolean);
  if (photos.length) lines.push('', 'Photographs:', ...photos);
  lines.push('', 'The same thing is attached as a PDF.');
  return lines.join('\n');
}

// `notice` is set only when something upstream failed — it goes at the top of the
// body and into the subject, because this email is now the only thing that tells
// Earl an application arrived. Netlify's own form notification was turned off on
// 29 Aug 2026.
export async function emailApplication(d, fullName, submitted, pdf, name, notice) {
  if (!process.env.RESEND_API_KEY) {
    console.log('application email skipped — no RESEND_API_KEY');
    return;
  }
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: FROM,
      to: [TO()],
      reply_to: t(d.Email) || undefined,
      subject: `${notice ? '[ACTION NEEDED] ' : ''}Collab application — ${fullName}`,
      text: emailBody(d, fullName, submitted, notice),
      attachments: [{ filename: name, content: pdf.toString('base64') }],
    }),
  });
  if (!res.ok) throw new Error(`Resend ${res.status}: ${await res.text()}`);
}

/* ---------- google drive ---------- */

const b64url = (buf) => Buffer.from(buf).toString('base64')
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function driveToken(sa) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = b64url(JSON.stringify({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/drive',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  }));
  const signature = b64url(
    crypto.createSign('RSA-SHA256').update(`${header}.${claim}`).sign(sa.private_key),
  );

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${header}.${claim}.${signature}`,
    }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`Google token ${res.status}: ${JSON.stringify(body)}`);
  return body.access_token;
}

export async function uploadToDrive(pdf, name) {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  const folder = process.env.GDRIVE_FOLDER_ID;
  if (!raw || !folder) {
    console.log('drive upload skipped — GOOGLE_SERVICE_ACCOUNT_JSON or GDRIVE_FOLDER_ID not set');
    return null;
  }

  const sa = JSON.parse(raw);
  const token = await driveToken(sa);

  const boundary = `collab${crypto.randomUUID()}`;
  const metadata = JSON.stringify({ name, parents: [folder], mimeType: 'application/pdf' });
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Type: application/pdf\r\n\r\n`),
    pdf,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);

  const res = await fetch(
    'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true&fields=id,webViewLink',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': `multipart/related; boundary=${boundary}`,
      },
      body,
    },
  );
  const out = await res.json();
  if (!res.ok) throw new Error(`Drive ${res.status}: ${JSON.stringify(out)}`);
  return out;
}
