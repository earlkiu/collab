/**
 * Netlify → Notion
 *
 * Fires automatically on every verified submission of the `collab` form.
 * Netlify looks for a function named exactly `submission-created`.
 *
 * Behaviour:
 *   1. Match the submitter against the People database by email
 *   2. Create the person if there is no match, reuse them if there is
 *   3. Create a Session row of type "Collab", linked to that person
 *   4. Append who-she-is and her photographs to the PERSON page body
 *   5. Write shoot-facing answers into the session page body
 *
 * Where the long answers go, and why:
 *   The application describes the person, not the shoot. It belongs on the
 *   person, appended under a dated heading each time she applies — never
 *   overwritten, because the change between applications is the interesting
 *   part. The session page body is left for the moodboard, references and
 *   shoot notes.
 *
 * `Limits` is written to the PROPERTY as well as the body. create-contract
 * reads the property for `session_limits` on the agreement; before this it
 * only ever existed in the body, so every contract said "None stated".
 *
 * Required environment variables (Netlify → Site configuration → Environment variables):
 *   NOTION_TOKEN        — internal integration secret from notion.so/my-integrations
 *   NOTION_PEOPLE_DB    — People database ID
 *   NOTION_SESSIONS_DB  — Sessions database ID
 *
 * Both databases must be shared with the integration
 * (open database → ⋯ → Connections → add the integration).
 */

const NOTION_API = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28';

const headers = () => ({
  Authorization: `Bearer ${process.env.NOTION_TOKEN}`,
  'Notion-Version': NOTION_VERSION,
  'Content-Type': 'application/json',
});

async function notion(path, options = {}) {
  const res = await fetch(`${NOTION_API}${path}`, { ...options, headers: headers() });
  const body = await res.json();
  if (!res.ok) {
    throw new Error(`Notion ${path} → ${res.status}: ${JSON.stringify(body)}`);
  }
  return body;
}

/* ---------- helpers ---------- */

const text = (v) => (v == null ? '' : String(v).trim());

const richText = (v) => (text(v) ? { rich_text: [{ text: { content: text(v).slice(0, 2000) } }] } : undefined);
const title = (v) => ({ title: [{ text: { content: text(v).slice(0, 200) || 'Untitled' } }] });
const email = (v) => (text(v) ? { email: text(v) } : undefined);
const select = (v) => (text(v) ? { select: { name: text(v).slice(0, 100) } } : undefined);
const date = (v) => (text(v) ? { date: { start: text(v) } } : undefined);
const checkbox = (v) => ({ checkbox: text(v).toLowerCase() === 'agreed' });

// Drop undefined values so Notion never sees a null property.
const clean = (obj) => Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));

const paragraph = (content) => ({
  object: 'block',
  type: 'paragraph',
  paragraph: { rich_text: [{ text: { content: content.slice(0, 2000) } }] },
});

const heading = (content) => ({
  object: 'block',
  type: 'heading_3',
  heading_3: { rich_text: [{ text: { content } }] },
});

const divider = () => ({ object: 'block', type: 'divider', divider: {} });

const stamp = (content) => ({
  object: 'block',
  type: 'heading_2',
  heading_2: { rich_text: [{ text: { content } }] },
});

function section(label, value) {
  if (!text(value)) return [];
  return [heading(label), paragraph(text(value))];
}

function prettyDate(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString('en-GB', {
    day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Kuala_Lumpur',
  });
}

// File fields arrive either as a URL string or as an object carrying the URL.
// Anything that is not an absolute http(s) URL is dropped — Notion rejects the
// whole page create if a single link is malformed.
function fileUrl(v) {
  const raw = typeof v === 'string' ? v : (v && (v.url || v.href)) || '';
  const url = String(raw).trim();
  return /^https?:\/\//i.test(url) ? url : '';
}

function photoSection(d) {
  const urls = ['Photo 1', 'Photo 2', 'Photo 3'].map((k) => fileUrl(d[k])).filter(Boolean);
  if (!urls.length) return [];
  return [heading('Photographs she sent')].concat(
    urls.map((url, i) => ({
      object: 'block',
      type: 'paragraph',
      paragraph: {
        rich_text: [{
          type: 'text',
          text: { content: `Photo ${i + 1}`, link: { url } },
        }],
      },
    })),
  );
}

/* ---------- person lookup ---------- */

async function findPersonByEmail(addr) {
  if (!addr) return null;
  const res = await notion(`/databases/${process.env.NOTION_PEOPLE_DB}/query`, {
    method: 'POST',
    body: JSON.stringify({
      page_size: 1,
      filter: { property: 'Email', email: { equals: addr } },
    }),
  });
  return res.results?.[0]?.id ?? null;
}

async function createPerson(d, fullName) {
  const page = await notion('/pages', {
    method: 'POST',
    body: JSON.stringify({
      parent: { database_id: process.env.NOTION_PEOPLE_DB },
      properties: clean({
        Name: title(fullName),
        Email: email(d.Email),
        Instagram: richText(d.Instagram),
        'Based In': richText(d['Based in']),
        DOB: date(d['Date of birth']),
        Source: select(d['How they found it']),
      }),
    }),
  });
  return page.id;
}

// Append, never overwrite. A second application a year later is a second entry;
// the difference between them is the point.
async function appendToPerson(personId, blocks) {
  if (!blocks.length) return;
  await notion(`/blocks/${personId}/children`, {
    method: 'PATCH',
    body: JSON.stringify({ children: blocks.slice(0, 100) }),
  });
}

/* ---------- handler ---------- */

export default async (req) => {
  let payload;
  try {
    ({ payload } = await req.json());
  } catch {
    return new Response('Bad payload', { status: 400 });
  }

  if (!payload || payload.form_name !== 'collab') {
    return new Response('Ignored', { status: 200 });
  }

  const d = payload.data || {};
  const fullName = [text(d['First name']), text(d['Last name'])].filter(Boolean).join(' ') || 'Unnamed';
  const addr = text(d.Email).toLowerCase();
  const submitted = (payload.created_at || new Date().toISOString()).slice(0, 10);

  try {
    // 1 + 2 — match on email, create if new
    let personId = await findPersonByEmail(addr);
    const isNew = !personId;
    if (!personId) personId = await createPerson({ ...d, Email: addr }, fullName);

    // 3 — the session. Shoot-facing answers only.
    const sessionTitle = `${fullName} · Collab · ${submitted.slice(0, 7)}`;

    const sessionBody = [
      ...section('References', d.References),
      ...section('Limits', d.Limits),
    ];

    await notion('/pages', {
      method: 'POST',
      body: JSON.stringify({
        parent: { database_id: process.env.NOTION_SESSIONS_DB },
        properties: clean({
          Name: title(sessionTitle),
          Person: { relation: [{ id: personId }] },
          Type: select('Collab'),
          Status: select('New'),
          Source: select('Collab form'),
          Submitted: date(submitted),
          // create-contract reads this property for `session_limits` on the
          // agreement. Body text alone left every contract saying "None stated".
          Limits: richText(d.Limits),
          'Comfort level': select(d['Comfort level']),
          Experience: select(d.Experience),
          'Heard via': select(d['How they found it']),
          'Referred by': richText(d['Referred by']),
          'Consent — usage': checkbox(d['Usage consent']),
          'Consent — limits': checkbox(d['Usage limits accepted']),
          'Consent — age': checkbox(d['Age confirmation']),
          'Consent — contact': checkbox(d['Contact consent']),
        }),
        children: sessionBody.length ? sessionBody : undefined,
      }),
    });

    // 4 — the application itself goes on the person, appended and dated.
    // Best effort, and last: the session row is the thing that must not be lost,
    // so a failure here leaves everything before it intact.
    try {
      const application = [
        ...section('Who they are', d['Who they are']),
        ...photoSection(d),
      ];
      if (application.length) {
        await appendToPerson(personId, [
          divider(),
          stamp(`Application — ${prettyDate(submitted)}`),
          ...application,
        ]);
      }
    } catch (err) {
      console.error(`person body append failed for ${addr}:`, err.message);
    }

    console.log(`collab → ${fullName} <${addr}> — person ${isNew ? 'created' : 'matched'}`);
    return new Response('OK', { status: 200 });
  } catch (err) {
    // Log loudly. The submission is still safe in Netlify's Forms dashboard.
    console.error('collab → Notion failed:', err.message);
    return new Response('Notion write failed', { status: 500 });
  }
};
