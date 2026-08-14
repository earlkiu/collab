/**
 * eSignatures.com → Notion
 *
 * Webhook URL, set on the eSignatures.com API page once this is deployed:
 *   https://collab.earlkiu.com/.netlify/functions/esign-webhook
 *
 * On contract-signed:
 *   1. Verify the HMAC — anyone who finds this URL could otherwise write to Notion
 *   2. Mark the session as signed, using the Notion page id carried in `metadata`
 *   3. Write the details she entered into the session page body
 *   4. Confirm the pending Cal booking
 *
 * NOT YET WIRED: the signed PDF. `contract_pdf_url` expires in three days and
 * eSignatures.com only retains contracts for three years, while the release is
 * perpetual — so the Drive copy is the actual record. That needs a Google
 * service account with the target folder shared to it. Until then the URL is
 * logged and the Release property stays empty rather than holding a dead link.
 *
 * Environment variables:
 *   ESIGNATURES_TOKEN  — doubles as the HMAC key
 *   NOTION_TOKEN
 *   CAL_API_KEY
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

const NOTION_API = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28';

const notionHeaders = () => ({
  Authorization: `Bearer ${process.env.NOTION_TOKEN}`,
  'Notion-Version': NOTION_VERSION,
  'Content-Type': 'application/json',
});

async function notion(path, options = {}) {
  const res = await fetch(`${NOTION_API}${path}`, { ...options, headers: notionHeaders() });
  const body = await res.json();
  if (!res.ok) throw new Error(`Notion ${path} → ${res.status}: ${JSON.stringify(body)}`);
  return body;
}

function verify(raw, signature) {
  if (!signature) return false;
  const expected = createHmac('sha256', process.env.ESIGNATURES_TOKEN).update(raw).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(String(signature).trim());
  return a.length === b.length && timingSafeEqual(a, b);
}

const heading = (content) => ({
  object: 'block',
  type: 'heading_3',
  heading_3: { rich_text: [{ text: { content } }] },
});

const paragraph = (content) => ({
  object: 'block',
  type: 'paragraph',
  paragraph: { rich_text: [{ text: { content: String(content).slice(0, 2000) } }] },
});

// Which wardrobe level she selected, if Schedule 1 was attached.
function wardrobeLevel(f) {
  if (f.wardrobe_nude) return 'Full nudity';
  if (f.wardrobe_topless) return 'Topless';
  if (f.wardrobe_implied) return 'Implied — strategically covered';
  return '';
}

async function confirmBooking(uid) {
  if (!uid || !process.env.CAL_API_KEY) return;
  const res = await fetch(`https://api.cal.com/v2/bookings/${uid}/confirm`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.CAL_API_KEY}`, 'cal-api-version': '2024-08-13' },
  });
  if (!res.ok) console.warn(`cal confirm ${uid} → ${res.status}`);
}

/* ---------- handler ---------- */

export default async (req) => {
  const raw = await req.text();

  if (!verify(raw, req.headers.get('x-signature-sha256'))) {
    console.warn('esign webhook → bad signature, rejected');
    return new Response('Invalid signature', { status: 401 });
  }

  let event;
  try {
    event = JSON.parse(raw);
  } catch {
    return new Response('Bad payload', { status: 400 });
  }

  // Everything else — sent, viewed, reminders — is acknowledged and ignored.
  if (event.status !== 'contract-signed') {
    return new Response('Ignored', { status: 200 });
  }

  const contract = event.data?.contract || {};
  const sessionId = (contract.metadata || '').trim();
  const signer = contract.signers?.[0] || {};
  const f = signer.signer_field_values || {};

  if (!sessionId) {
    console.error(`contract ${contract.id} signed but carries no session id`);
    return new Response('OK', { status: 200 });
  }

  try {
    // Return 200 even if the row is already marked — eSignatures retries six
    // times, and a duplicate block append is worse than a no-op.
    const page = await notion(`/pages/${sessionId}`);
    if (page.properties['Release signed']?.checkbox === true) {
      console.log(`contract ${contract.id} already recorded, skipping`);
      return new Response('OK', { status: 200 });
    }

    await notion(`/pages/${sessionId}`, {
      method: 'PATCH',
      body: JSON.stringify({
        properties: { 'Release signed': { checkbox: true } },
      }),
    });

    const level = wardrobeLevel(f);
    const blocks = [
      heading('Agreement signed'),
      paragraph(`Contract ${contract.id}`),
      paragraph(`Name as per NRIC or passport: ${f.model_name || '—'}`),
      paragraph(`Date of birth: ${f.model_dob || '—'}`),
      paragraph(`Nationality: ${f.model_nationality || '—'}`),
      paragraph(`NRIC or passport: ${f.model_id || '—'}`),
      paragraph(`Mobile: ${f.model_mobile || '—'}`),
    ];
    if (level) blocks.push(paragraph(`Wardrobe level agreed: ${level}`));

    await notion(`/blocks/${sessionId}/children`, {
      method: 'PATCH',
      body: JSON.stringify({ children: blocks }),
    });

    await confirmBooking(page.properties['Booking UID'] ? undefined : undefined);

    // The PDF link is live for three days only. Logged so it is recoverable
    // by hand until the Drive copy is built.
    console.log(`contract ${contract.id} signed · session ${sessionId} · pdf ${contract.contract_pdf_url}`);

    return new Response('OK', { status: 200 });
  } catch (err) {
    console.error('esign webhook failed:', err.message);
    return new Response('Failed', { status: 500 });
  }
};
