/**
 * On-set signing — list sessions, create a contract, hand back a sign URL.
 *
 * Used by /booking/schedule, which Earl opens on his phone during a shoot.
 * Two jobs, decided per session rather than per request:
 *
 *   No agreement signed yet   → the full Collaboration Agreement
 *                               (walk-up shoot: she fills the collab form on her
 *                                phone, the row appears here seconds later)
 *   Agreement already signed  → the standalone Schedule 1 supplement
 *                               (she agreed to clothed, changed her mind on set)
 *
 * GET  ?k=<key>            → { sessions: […] }
 * POST { k, s }            → { signUrl, kind, name }
 *
 * The key is a shared secret in the URL. Without it this endpoint would list
 * client names to anyone who found it.
 *
 * Environment variables:
 *   ON_SET_KEY         — any long random string; lives in Earl's bookmarked URL
 *   ESIGNATURES_TOKEN
 *   NOTION_TOKEN
 *   NOTION_SESSIONS_DB
 */

const ESIG = 'https://esignatures.com/api';
const NOTION_API = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28';

const AGREEMENT = 'd42be4d3-af77-41e0-82ad-2e11799e5332';
const SCHEDULE_1_EMBEDDED = '597b12b4-7cb9-4e4a-bac8-d85b0e0996c1';
const SCHEDULE_1_STANDALONE = 'f9574239-e102-40bf-982c-1f33b649e23b';

const NEEDS_SCHEDULE = new Set([
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
  const json = await res.json();
  if (!res.ok) throw new Error(`eSignatures ${path} → ${res.status}: ${JSON.stringify(json)}`);
  return json;
}

const plain = (p) => {
  if (!p) return '';
  if (p.type === 'title') return (p.title[0]?.plain_text || '').trim();
  if (p.type === 'rich_text') return (p.rich_text.map((r) => r.plain_text).join('') || '').trim();
  if (p.type === 'select') return p.select?.name || '';
  if (p.type === 'email') return p.email || '';
  if (p.type === 'date') return p.date?.start || '';
  return '';
};

// Today in Kuala Lumpur, not in whatever region the function happens to run in.
function todayKL() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kuala_Lumpur' });
}

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

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/* ---------- handler ---------- */

export default async (req) => {
  const url = new URL(req.url);
  const secret = process.env.ON_SET_KEY;

  if (!secret) return json({ error: 'Not configured' }, 500);

  /* ----- list ----- */

  if (req.method === 'GET') {
    if (url.searchParams.get('k') !== secret) return json({ error: 'Not found' }, 404);

    try {
      const res = await notion(`/databases/${process.env.NOTION_SESSIONS_DB}/query`, {
        method: 'POST',
        body: JSON.stringify({
          page_size: 15,
          sorts: [{ timestamp: 'created_time', direction: 'descending' }],
        }),
      });

      const sessions = res.results.map((r) => ({
        id: r.id,
        name: plain(r.properties.Name) || 'Untitled',
        signed: r.properties['Release signed']?.checkbox === true,
        shoot: plain(r.properties['Shoot date']),
        comfort: plain(r.properties['Comfort level']),
      }));

      return json({ sessions });
    } catch (err) {
      console.error('on-set list failed:', err.message);
      return json({ error: 'Could not load sessions' }, 500);
    }
  }

  /* ----- create ----- */

  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  let k, s;
  try {
    ({ k, s } = await req.json());
  } catch {
    return json({ error: 'Bad request' }, 400);
  }

  if (k !== secret) return json({ error: 'Not found' }, 404);
  if (!s) return json({ error: 'Missing session' }, 400);

  try {
    const session = await notion(`/pages/${s}`);
    const p = session.properties;

    const personId = p.Person?.relation?.[0]?.id;
    if (!personId) throw new Error('Session has no linked person');
    const person = await notion(`/pages/${personId}`);
    const pp = person.properties;

    const name = plain(pp.Name);
    const addr = plain(pp.Email);
    if (!addr) throw new Error('Person has no email');

    const alreadySigned = p['Release signed']?.checkbox === true;
    const today = todayKL();
    const shootISO = plain(p['Shoot date']) || today;
    const comfort = plain(p['Comfort level']);

    let payload;

    if (alreadySigned) {
      // Supplement. The original stands; this adds the wardrobe level to it.
      const signedOn = plain(p['Release signed on']) || today;
      payload = {
        template_id: SCHEDULE_1_STANDALONE,
        title: `Schedule 1 — ${name}`,
        metadata: `${s}||schedule`,
        placeholder_fields: [
          { placeholder_key: 'original_date', replace_with_text: prettyDate(signedOn) },
          { placeholder_key: 'session_date', replace_with_text: prettyDate(shootISO) },
        ],
        signer_fields: [{ signer_field_id: 'model_name', default_value: name }],
      };
    } else {
      // No agreement yet — walk-up shoot. Full agreement, dated today.
      payload = {
        template_id: AGREEMENT,
        title: `Collaboration Agreement — ${name}`,
        metadata: `${s}||agreement`,
        placeholder_fields: [
          { placeholder_key: 'model_email', replace_with_text: addr },
          { placeholder_key: 'model_instagram', replace_with_text: plain(pp.Instagram) || '—' },
          { placeholder_key: 'session_date', replace_with_text: prettyDate(shootISO) },
          { placeholder_key: 'session_location', replace_with_text: plain(p.Location) || 'Kuala Lumpur' },
          { placeholder_key: 'session_brief', replace_with_text: plain(p.Brief) || 'To be confirmed' },
          { placeholder_key: 'session_limits', replace_with_text: plain(p.Limits) || 'None stated' },
          NEEDS_SCHEDULE.has(comfort)
            ? { placeholder_key: 'wardrobe_schedule', replace_with_template: SCHEDULE_1_EMBEDDED }
            : { placeholder_key: 'wardrobe_schedule', replace_with_text: '' },
        ],
        signer_fields: [
          { signer_field_id: 'model_name', default_value: name },
          { signer_field_id: 'model_dob', default_value: ddmmyyyy(plain(pp.DOB)) },
        ],
      };
    }

    const contract = await esig('/contracts', {
      ...payload,
      test: TEST_MODE,
      locale: 'en-GB',
      expires_in_hours: '24',
      signers: [{
        name,
        email: addr,
        signature_request_delivery_methods: [],
        signed_document_delivery_method: 'email',
      }],
    });

    const signer = contract.data?.contract?.signers?.[0];
    if (!signer?.sign_page_url) throw new Error('No sign page returned');

    console.log(`on-set ${alreadySigned ? 'schedule' : 'agreement'} → ${name} · ${contract.data.contract.id}`);

    return json({
      signUrl: signer.sign_page_url,
      kind: alreadySigned ? 'schedule' : 'agreement',
      name,
    });
  } catch (err) {
    console.error('on-set create failed:', err.message);
    return json({ error: 'Could not prepare the document' }, 500);
  }
};
