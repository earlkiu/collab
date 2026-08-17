/**
 * Booking → eSignatures.com
 *
 * Called by /booking/contract once Cal has taken the booking.
 * Reads the Notion session row, builds the agreement, returns a sign URL.
 *
 * POST { s: <notion session page id>, uid: <cal booking uid> }
 *  → { signUrl }
 *
 * Environment variables (Netlify → Site configuration → Environment variables):
 *   ESIGNATURES_TOKEN  — Secret Token from the eSignatures.com API page
 *   CAL_API_KEY        — cal.com API key, never expires
 *   NOTION_TOKEN       — internal integration secret
 *   ESIGN_TEST_MODE    — optional; 'yes' sends free test contracts
 *
 * Both ids travel to eSignatures as `metadata` in the form "<session>|<uid>"
 * and come back on the contract-signed webhook. That is the join key between
 * the three systems, and it is why neither Notion nor Cal needs a new field.
 */

const ESIG = 'https://esignatures.com/api';
const NOTION_API = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28';

const AGREEMENT = 'd42be4d3-af77-41e0-82ad-2e11799e5332';
const SCHEDULE_1 = '597b12b4-7cb9-4e4a-bac8-d85b0e0996c1';

// Wardrobe levels that pull Schedule 1 into the packet. Anything else and the
// schedule is not in the document at all — a blank schedule must never be a
// thing that means something.
const NEEDS_SCHEDULE = new Set([
  'Implied — strategically covered',
  'Topless',
  'Full nudity',
]);

// Live by default. Real contracts cost $0.49 each, charged on send, not on
// signature — an abandoned booking still bills.
//
// To test: set ESIGN_TEST_MODE = 'yes' in Netlify, scoped to Deploy previews
// and Branch deploys, so production is never accidentally left in test mode.
// Env var changes only take effect on the next deploy.
const TEST_MODE = process.env.ESIGN_TEST_MODE === 'yes' ? 'yes' : 'no';

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

async function esig(path, body) {
  const auth = Buffer.from(`${process.env.ESIGNATURES_TOKEN}:`).toString('base64');
  const res = await fetch(`${ESIG}${path}`, {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`eSignatures ${path} → ${res.status}: ${JSON.stringify(json)}`);
  return json;
}

/* ---------- reading Notion properties ---------- */

const plain = (p) => {
  if (!p) return '';
  if (p.type === 'title') return (p.title[0]?.plain_text || '').trim();
  if (p.type === 'rich_text') return (p.rich_text.map((r) => r.plain_text).join('') || '').trim();
  if (p.type === 'select') return p.select?.name || '';
  if (p.type === 'email') return p.email || '';
  if (p.type === 'date') return p.date?.start || '';
  if (p.type === 'url') return p.url || '';
  return '';
};

// DD/MM/YYYY — the agreement's DOB field is a text input, so the format is ours
// to choose. See the 14 Aug decision doc: date fields cannot be prefilled.
function ddmmyyyy(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.slice(0, 10).split('-');
  return d && m && y ? `${d}/${m}/${y}` : '';
}

function prettyDate(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString('en-GB', {
    day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Kuala_Lumpur',
  });
}

/* ---------- cal ---------- */

async function calBooking(uid) {
  if (!uid) return null;
  const res = await fetch(`https://api.cal.com/v2/bookings/${uid}`, {
    headers: { Authorization: `Bearer ${process.env.CAL_API_KEY}`, 'cal-api-version': '2024-08-13' },
  });
  if (!res.ok) {
    console.warn(`cal booking ${uid} → ${res.status}`);
    return null;
  }
  const { data } = await res.json();
  return data || null;
}

/* ---------- handler ---------- */

export default async (req) => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  let s, uid;
  try {
    ({ s, uid } = await req.json());
  } catch {
    return new Response(JSON.stringify({ error: 'Bad request' }), { status: 400 });
  }

  if (!s) return new Response(JSON.stringify({ error: 'Missing session' }), { status: 400 });

  try {
    const session = await notion(`/pages/${s}`);
    const p = session.properties;

    // The person carries name, email and date of birth.
    const personId = p.Person?.relation?.[0]?.id;
    if (!personId) throw new Error('Session has no linked person');
    const person = await notion(`/pages/${personId}`);
    const pp = person.properties;

    const name = plain(pp.Name);
    const addr = plain(pp.Email);
    if (!addr) throw new Error('Person has no email');

    const comfort = plain(p['Comfort level']);
    const booking = await calBooking(uid);
    const shootISO = booking?.start || plain(p['Shoot date']);

    const placeholders = [
      { placeholder_key: 'model_email', replace_with_text: addr },
      { placeholder_key: 'model_instagram', replace_with_text: plain(pp.Instagram) || '—' },
      { placeholder_key: 'session_date', replace_with_text: prettyDate(shootISO) || 'To be confirmed' },
      { placeholder_key: 'session_location', replace_with_text: plain(p.Location) || 'Kuala Lumpur — confirmed before the session' },
      { placeholder_key: 'session_brief', replace_with_text: plain(p.Brief) || 'To be confirmed' },
      { placeholder_key: 'session_limits', replace_with_text: plain(p.Limits) || 'None stated' },
      NEEDS_SCHEDULE.has(comfort)
        ? { placeholder_key: 'wardrobe_schedule', replace_with_template: SCHEDULE_1 }
        : { placeholder_key: 'wardrobe_schedule', replace_with_text: '' },
    ];

    const contract = await esig('/contracts', {
      template_id: AGREEMENT,
      title: `Collaboration Agreement — ${name}`,
      metadata: `${s}|${uid || ''}`,
      test: TEST_MODE,
      locale: 'en-GB',
      expires_in_hours: '72',
      placeholder_fields: placeholders,
      signer_fields: [
        { signer_field_id: 'model_name', default_value: name },
        { signer_field_id: 'model_dob', default_value: ddmmyyyy(plain(pp.DOB)) },
      ],
      signers: [{
        name,
        email: addr,
        // Empty list suppresses the signature-request email — she is already
        // looking at the embedded page. She still receives the signed PDF.
        signature_request_delivery_methods: [],
        signed_document_delivery_method: 'email',
        redirect_url: 'https://collab.earlkiu.com/booking/confirmed',
      }],
    });

    const signer = contract.data?.contract?.signers?.[0];
    if (!signer?.sign_page_url) throw new Error('No sign page returned');

    // Record what we know now. Release signed is set by the webhook, not here.
    const updates = { Status: { select: { name: 'Scheduled' } } };
    if (shootISO) updates['Shoot date'] = { date: { start: shootISO } };

    await notion(`/pages/${s}`, {
      method: 'PATCH',
      body: JSON.stringify({ properties: updates }),
    });

    console.log(`contract ${contract.data.contract.id} → ${name} <${addr}> · schedule ${NEEDS_SCHEDULE.has(comfort) ? 'attached' : 'omitted'}${TEST_MODE === 'yes' ? ' · TEST' : ''}`);

    return new Response(JSON.stringify({ signUrl: signer.sign_page_url }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    console.error('create-contract failed:', err.message);
    return new Response(JSON.stringify({ error: 'Could not prepare the agreement' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
