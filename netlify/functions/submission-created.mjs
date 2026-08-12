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
 *   4. Write the long-form answers into the session page body
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

const multiSelect = (v) => {
  const values = Array.isArray(v) ? v : text(v).split(',');
  const names = values.map((s) => text(s)).filter(Boolean);
  return names.length ? { multi_select: names.map((name) => ({ name: name.slice(0, 100) })) } : undefined;
};

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

function section(label, value) {
  if (!text(value)) return [];
  return [heading(label), paragraph(text(value))];
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

    // 3 — the session
    const sessionTitle = `${fullName} · Collab · ${submitted.slice(0, 7)}`;

    const body = [
      ...section('Who they are', d['Who they are']),
      ...section('Has a photograph ever felt like them', d['Ever felt seen']),
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
          Status: { status: { name: 'New' } },
          Source: select('Collab form'),
          Submitted: date(submitted),
          'Comfort level': select(d['Comfort level']),
          Availability: multiSelect(d.Availability),
          Experience: select(d.Experience),
          'Heard via': select(d['How they found it']),
          'Consent — usage': checkbox(d['Usage consent']),
          'Consent — limits': checkbox(d['Usage limits accepted']),
          'Consent — age': checkbox(d['Age confirmation']),
          'Consent — contact': checkbox(d['Contact consent']),
        }),
        children: body.length ? body : undefined,
      }),
    });

    console.log(`collab → ${fullName} <${addr}> — person ${isNew ? 'created' : 'matched'}`);
    return new Response('OK', { status: 200 });
  } catch (err) {
    // Log loudly. The submission is still safe in Netlify's Forms dashboard.
    console.error('collab → Notion failed:', err.message);
    return new Response('Notion write failed', { status: 500 });
  }
};
