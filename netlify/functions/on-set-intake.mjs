/**
 * On-set intake — short form → Notion → agreement, in one pass.
 *
 * Used by /booking/new, which she opens by scanning a QR from Earl's phone when
 * she has not filled the full collab form. Deliberately minimal: only what the
 * agreement actually needs, plus the consents.
 *
 * POST { name, email, dob, instagram, comfort, brief, consents… }
 *   → { signUrl }
 *
 * Creates or matches the person, creates the session, creates the contract.
 * The session is marked Source "Direct" so on-set intakes are distinguishable
 * from the ones that came through the collab form.
 *
 * Environment variables:
 *   ESIGNATURES_TOKEN
 *   NOTION_TOKEN
 *   NOTION_PEOPLE_DB
 *   NOTION_SESSIONS_DB
 */

const ESIG = 'https://esignatures.com/api';
const NOTION_API = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28';

const AGREEMENT = 'd42be4d3-af77-41e0-82ad-2e11799e5332';
const SCHEDULE_1_EMBEDDED = '597b12b4-7cb9-4e4a-bac8-d85b0e0996c1';

const NEEDS_SCHEDULE = new Set([
  'Implied — strategically covered',
  'Topless',
  'Full nudity',
]);

const VALID_COMFORT = new Set([
  'Fully clothed',
  'Styled — sheer or revealing',
  'Implied — strategically covered',
  'Topless',
  'Full nudity',
]);

const TEST_MODE = 'no';

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
  const out = await res.json();
  if (!res.ok) throw new Error(`eSignatures ${path} → ${res.status}: ${JSON.stringify(out)}`);
  return out;
}

const text = (v) => (v == null ? '' : String(v).trim());

function todayKL() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kuala_Lumpur' });
}

function prettyDate(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString('en-GB', {
    day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Kuala_Lumpur',
  });
}

// The form sends DD/MM/YYYY. Notion wants ISO.
function toISO(ddmmyyyy) {
  const m = text(ddmmyyyy).match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : '';
}

function isAdult(iso) {
  if (!iso) return false;
  const dob = new Date(iso);
  if (Number.isNaN(dob.getTime())) return false;
  const cutoff = new Date();
  cutoff.setFullYear(cutoff.getFullYear() - 18);
  return dob <= cutoff;
}

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

async function findPersonByEmail(addr) {
  const res = await notion(`/databases/${process.env.NOTION_PEOPLE_DB}/query`, {
    method: 'POST',
    body: JSON.stringify({
      page_size: 1,
      filter: { property: 'Email', email: { equals: addr } },
    }),
  });
  return res.results?.[0]?.id ?? null;
}

/* ---------- handler ---------- */

export default async (req) => {
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  let d;
  try {
    d = await req.json();
  } catch {
    return json({ error: 'Bad request' }, 400);
  }

  const name = text(d.name);
  const addr = text(d.email).toLowerCase();
  const dobISO = toISO(d.dob);
  const comfort = VALID_COMFORT.has(text(d.comfort)) ? text(d.comfort) : '';

  if (!name || !addr || !dobISO || !comfort) {
    return json({ error: 'Missing details' }, 400);
  }
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(addr)) {
    return json({ error: 'That email does not look right' }, 400);
  }
  // Checked here as well as in the browser — the browser check is a courtesy,
  // this one is the rule.
  if (!isAdult(dobISO)) {
    return json({ error: 'age' }, 400);
  }
  if (!d.consentUsage || !d.consentLimits || !d.consentAge || !d.consentContact) {
    return json({ error: 'Missing consent' }, 400);
  }

  const today = todayKL();

  try {
    let personId = await findPersonByEmail(addr);
    if (!personId) {
      const person = await notion('/pages', {
        method: 'POST',
        body: JSON.stringify({
          parent: { database_id: process.env.NOTION_PEOPLE_DB },
          properties: {
            Name: { title: [{ text: { content: name.slice(0, 200) } }] },
            Email: { email: addr },
            DOB: { date: { start: dobISO } },
            ...(text(d.instagram)
              ? { Instagram: { rich_text: [{ text: { content: text(d.instagram) } }] } }
              : {}),
          },
        }),
      });
      personId = person.id;
    }

    const session = await notion('/pages', {
      method: 'POST',
      body: JSON.stringify({
        parent: { database_id: process.env.NOTION_SESSIONS_DB },
        properties: {
          Name: { title: [{ text: { content: `${name} · Collab · ${today.slice(0, 7)}` } }] },
          Person: { relation: [{ id: personId }] },
          Type: { select: { name: 'Collab' } },
          Status: { select: { name: 'Scheduled' } },
          Source: { select: { name: 'Direct' } },
          Submitted: { date: { start: today } },
          'Shoot date': { date: { start: today } },
          'Comfort level': { select: { name: comfort } },
          'Consent — usage': { checkbox: true },
          'Consent — limits': { checkbox: true },
          'Consent — age': { checkbox: true },
          'Consent — contact': { checkbox: true },
          ...(text(d.brief)
            ? { Brief: { rich_text: [{ text: { content: text(d.brief).slice(0, 2000) } }] } }
            : {}),
          ...(text(d.limits)
            ? { Limits: { rich_text: [{ text: { content: text(d.limits).slice(0, 2000) } }] } }
            : {}),
        },
        children: [{
          object: 'block',
          type: 'paragraph',
          paragraph: {
            rich_text: [{ text: { content: 'Signed up on set. Short intake form, not the full collab form — no photographs, references or self-description were collected.' } }],
          },
        }],
      }),
    });

    const contract = await esig('/contracts', {
      template_id: AGREEMENT,
      title: `Collaboration Agreement — ${name}`,
      metadata: `${session.id}||agreement`,
      test: TEST_MODE,
      locale: 'en-GB',
      expires_in_hours: '24',
      placeholder_fields: [
        { placeholder_key: 'model_email', replace_with_text: addr },
        { placeholder_key: 'model_instagram', replace_with_text: text(d.instagram) || '—' },
        { placeholder_key: 'session_date', replace_with_text: prettyDate(today) },
        { placeholder_key: 'session_location', replace_with_text: text(d.location) || 'Kuala Lumpur' },
        { placeholder_key: 'session_brief', replace_with_text: text(d.brief) || 'To be confirmed' },
        { placeholder_key: 'session_limits', replace_with_text: text(d.limits) || 'None stated' },
        NEEDS_SCHEDULE.has(comfort)
          ? { placeholder_key: 'wardrobe_schedule', replace_with_template: SCHEDULE_1_EMBEDDED }
          : { placeholder_key: 'wardrobe_schedule', replace_with_text: '' },
      ],
      signer_fields: [
        { signer_field_id: 'model_name', default_value: name },
        { signer_field_id: 'model_dob', default_value: text(d.dob) },
      ],
      signers: [{
        name,
        email: addr,
        signature_request_delivery_methods: [],
        signed_document_delivery_method: 'email',
      }],
    });

    const signer = contract.data?.contract?.signers?.[0];
    if (!signer?.sign_page_url) throw new Error('No sign page returned');

    console.log(`on-set intake → ${name} <${addr}> · ${comfort} · session ${session.id}`);

    return json({ signUrl: signer.sign_page_url });
  } catch (err) {
    console.error('on-set intake failed:', err.message);
    return json({ error: 'Could not set this up' }, 500);
  }
};
