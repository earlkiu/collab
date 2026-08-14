/**
 * Session lookup for the booking page.
 *
 * GET ?s=<notion session page id> → { name, email }
 *
 * Two jobs:
 *   1. Gate the calendar. Without a valid session id, no Cal embed renders and
 *      nobody can take a slot. Before this existed, anyone who found /booking
 *      could book a real shoot — the contract would fail afterwards, but the
 *      slot was gone.
 *   2. Prefill Cal, so the email on the booking cannot diverge from the email
 *      on the contract.
 *
 * Only ever returns name and email, and only for an id someone already has.
 * The id is a random UUID and the link is sent privately.
 *
 * Environment variables:
 *   NOTION_TOKEN
 */

const NOTION_API = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28';

const notionHeaders = () => ({
  Authorization: `Bearer ${process.env.NOTION_TOKEN}`,
  'Notion-Version': NOTION_VERSION,
  'Content-Type': 'application/json',
});

async function notion(path) {
  const res = await fetch(`${NOTION_API}${path}`, { headers: notionHeaders() });
  const body = await res.json();
  if (!res.ok) throw new Error(`Notion ${path} → ${res.status}`);
  return body;
}

const plain = (p) => {
  if (!p) return '';
  if (p.type === 'title') return (p.title[0]?.plain_text || '').trim();
  if (p.type === 'email') return p.email || '';
  if (p.type === 'select') return p.select?.name || '';
  return '';
};

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

export default async (req) => {
  const s = new URL(req.url).searchParams.get('s') || '';

  // Anything that is not a Notion page id is rejected before a call is made.
  if (!/^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i.test(s)) {
    return json({ error: 'not_found' }, 404);
  }

  try {
    const session = await notion(`/pages/${s}`);
    const p = session.properties;

    // A session already signed should not be booked again.
    if (p['Release signed']?.checkbox === true) {
      return json({ error: 'already_signed' }, 409);
    }

    const status = plain(p.Status);
    if (status === 'Declined' || status === 'Archived') {
      return json({ error: 'closed' }, 409);
    }

    const personId = p.Person?.relation?.[0]?.id;
    if (!personId) return json({ error: 'not_found' }, 404);

    const person = await notion(`/pages/${personId}`);
    const name = plain(person.properties.Name);
    const email = plain(person.properties.Email);

    if (!email) return json({ error: 'not_found' }, 404);

    return json({ name, email });
  } catch (err) {
    console.error('session lookup failed:', err.message);
    return json({ error: 'not_found' }, 404);
  }
};
