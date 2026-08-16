/**
 * eSignatures.com → Notion
 *
 * Webhook URL, set on the eSignatures.com API page:
 *   https://collab.earlkiu.com/.netlify/functions/esign-webhook
 *
 * On contract-signed:
 *   1. Verify the HMAC — anyone who finds this URL could otherwise write to Notion
 *   2. Update the session, using the ids carried in `metadata`
 *   3. Write the details she entered into the session page body
 *   4. Confirm the pending Cal booking, if there is one
 *
 * `metadata` is "<notion session page id>|<cal booking uid>|<kind>". The uid may
 * be empty. `kind` is "agreement" or "schedule":
 *
 *   agreement — the main release. Marks Release signed and the date.
 *   schedule  — the standalone Schedule 1, signed mid-shoot when someone changes
 *               their mind about wardrobe. The agreement stays as signed; this
 *               only records the level agreed and updates Comfort level.
 *
 * The signed PDF is archived to Drive by the eSignatures.com Drive integration,
 * which is the permanent record. Notion holds the permalink only —
 * esignatures.com/contracts/<id>, which never expires, unlike
 * `contract_pdf_url` in the payload, which dies after three days.
 *
 * Environment variables:
 *   ESIGNATURES_TOKEN  — doubles as the HMAC key
 *   NOTION_TOKEN
 *   CAL_API_KEY
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

const NOTION_API = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28';

const contractUrl = (id) => `https://esignatures.com/contracts/${id}`;

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

// Which wardrobe level she selected, if a schedule was part of the document.
function wardrobeLevel(f) {
  if (f.wardrobe_nude) return 'Full nudity';
  if (f.wardrobe_topless) return 'Topless';
  if (f.wardrobe_implied) return 'Implied — strategically covered';
  return '';
}

function todayKL() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kuala_Lumpur' });
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
  const parts = String(contract.metadata || '').split('|');
  const sessionId = (parts[0] || '').trim();
  const bookingUid = (parts[1] || '').trim();
  const kind = (parts[2] || 'agreement').trim();

  const signer = contract.signers?.[0] || {};
  const f = signer.signer_field_values || {};
  const level = wardrobeLevel(f);
  const today = todayKL();

  if (!sessionId) {
    console.error(`contract ${contract.id} signed but carries no session id`);
    return new Response('OK', { status: 200 });
  }

  try {
    const page = await notion(`/pages/${sessionId}`);

    if (kind === 'schedule') {
      // A supplement. Never touches Release signed or Release — the original
      // agreement is what those refer to, and the link belongs to it.
      const blocks = [
        heading('Schedule 1 signed on set'),
        paragraph(`Contract ${contract.id} · ${today}`),
        paragraph(`Name as per NRIC or passport: ${f.model_name || '—'}`),
        paragraph(`NRIC or passport: ${f.model_id || '—'}`),
        paragraph(`Wardrobe level agreed: ${level || '—'}`),
        paragraph(contractUrl(contract.id)),
      ];

      await notion(`/blocks/${sessionId}/children`, {
        method: 'PATCH',
        body: JSON.stringify({ children: blocks }),
      });

      if (level) {
        await notion(`/pages/${sessionId}`, {
          method: 'PATCH',
          body: JSON.stringify({ properties: { 'Comfort level': { select: { name: level } } } }),
        });
      }

      console.log(`schedule ${contract.id} signed · session ${sessionId} · ${level}`);
      return new Response('OK', { status: 200 });
    }

    // The main agreement. eSignatures retries six times, so a second delivery
    // must not append the same block twice.
    if (page.properties['Release signed']?.checkbox === true) {
      console.log(`contract ${contract.id} already recorded, skipping`);
      return new Response('OK', { status: 200 });
    }

    await notion(`/pages/${sessionId}`, {
      method: 'PATCH',
      body: JSON.stringify({
        properties: {
          'Release signed': { checkbox: true },
          'Release signed on': { date: { start: today } },
          Release: { url: contractUrl(contract.id) },
        },
      }),
    });

    const blocks = [
      heading('Agreement signed'),
      paragraph(`Contract ${contract.id} · ${today}`),
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

    // The booking sits pending until this point. Signature is the confirmation.
    await confirmBooking(bookingUid);

    console.log(`contract ${contract.id} signed · session ${sessionId}`);

    return new Response('OK', { status: 200 });
  } catch (err) {
    console.error('esign webhook failed:', err.message);
    return new Response('Failed', { status: 500 });
  }
};
