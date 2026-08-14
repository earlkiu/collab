/**
 * Session lookup for the booking page.
 *
 * GET ?s=<notion session page id> → { name, email }
 *
 * Three jobs:
 *   1. Gate the calendar. Without a valid, open, unexpired session, no Cal
 *      embed renders and nobody can take a slot. Before this existed, anyone
 *      who found /booking could book a real shoot — the contract would fail
 *      afterwards, but the slot was gone.
 *   2. Expire the link. The window runs from `Booking link sent`, not from when
 *      the row was created, so a link that goes quiet dies rather than turning
 *      into a surprise booking months later. Reopening it is setting that date
 *      to today again — the URL itself never changes, so she can reuse the one
 *      she already has.
 *   3. Prefill Cal, so the email on the booking cannot diverge from the email
 *      on the contract.
 *
 * Only ever returns name and email, and only for an id someone already has.
 *
 * Environment variables:
 *   NOTION_TOKEN
 */

const NOTION_API = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28';

// Days the booking link stays open after Earl sends it.
const WINDOW_DAYS = 5;

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
  if (p.type === 'date') return p.date?.start || '';
  return '';
};

// Whole days elapsed, counted in Kuala Lumpur rather than wherever this runs.
function daysSince(iso) {
  if (!iso) return null;
  const sent = new Date(`${iso.slice(0, 10)}T00:00:00+08:00`);
  if (Number.isNaN(sent.getTime())) return null;
  const today = new Date(`${new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kuala_Lumpur' })}T00:00:00+08:00`);
  return Math.round((today - sent) / 86400000);
}

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

    // Already signed — nothing left to book.
    if (p['Release signed']?.checkbox === true) {
      return json({ error: 'already_signed' }, 409);
    }

    const status = plain(p.Status);
    if (status === 'Declined' || status === 'Archived') {
      return json({ error: 'closed' }, 409);
    }

    // Never sent. The Notion formula hides the URL until this is set, so a link
    // reaching here without it was built by hand or leaked.
    const sent = plain(p['Booking link sent']);
    if (!sent) return json({ error: 'not_found' }, 404);

    const age = daysSince(sent);
    if (age === null) return json({ error: 'not_found' }, 404);

    // Dated in the future — treat as not yet open rather than valid forever.
    if (age < 0) return json({ error: 'expired' }, 410);
    if (age > WINDOW_DAYS) return json({ error: 'expired' }, 410);

    const personId = p.Person?.relation?.[0]?.id;
    if (!personId) return json({ error: 'not_found' }, 404);

    const person = await notion(`/pages/${personId}`);
    const name = plain(person.properties.Name);
    const email = plain(person.properties.Email);

    if (!email) return json({ error: 'not_found' }, 404);

    return json({ name, email, daysLeft: WINDOW_DAYS - age });
  } catch (err) {
    console.error('session lookup failed:', err.message);
    return json({ error: 'not_found' }, 404);
  }
};
