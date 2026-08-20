/**
 * Booking email — scheduled, hourly.
 *
 * Two sends live here, one query, one run.
 *
 * 1. The booking link, once, when Earl sets `Booking link sent` on a session
 *    row and the `Booking email sent` checkbox is still false.
 * 2. A single nudge, three days after that first email actually went out, if
 *    she still hasn't signed and the link hasn't lapsed.
 *
 * The checkboxes are the guards, not the dates. `Booking link sent` gets
 * edited — typos corrected, and reopening a lapsed window means setting it to
 * today again. Firing on a date alone would put a live email in front of a
 * client on every one of those edits. To deliberately re-send either: clear
 * its checkbox.
 *
 * The email is a durable record, not a substitute for the DM. A message
 * gets read and forgotten; the email is what she can find again on Thursday.
 * Both going out is the intended behaviour, so do not tick the checkbox by
 * hand when pasting the link into a DM.
 *
 * One nudge, not two. Six days is not long enough to chase twice, and she
 * already has the expiry date in the first email. If she still hasn't moved
 * on the last live day, that is a DM, not a third email.
 *
 * Environment variables:
 *   NOTION_TOKEN  NOTION_SESSIONS_DB  RESEND_API_KEY
 */

const NOTION_API = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28';

// Must match WINDOW_DAYS in session-lookup.mjs. The date stated in the email
// is computed from this, so if the two diverge the email promises a day the
// gate will not honour. Netlify treats every top-level .mjs in this directory
// as a function, so this cannot be shared from a module here — same reason
// TEST_EMAILS is duplicated across create-contract, on-set and on-set-intake.
const WINDOW_DAYS = 5;

// Days after the first email — not after `Booking link sent`. The two differ
// whenever the link date is backdated or the first send is delayed, and what
// she experiences is the gap since the last thing that landed in her inbox.
const NUDGE_AFTER_DAYS = 3;

const FROM = 'Earl Kiu <hello@earlkiu.com>';
const BOOKING_BASE = 'https://collab.earlkiu.com/booking';

// Rows past this point have already moved on. Declined and Archived are
// closed; Scheduled and later mean she has booked and signed, and the
// webhook has moved the row on without this function's help.
const DONE = new Set(['Declined', 'Archived', 'Scheduled', 'Shot', 'Delivered']);

const notionHeaders = () => ({
  Authorization: `Bearer ${process.env.NOTION_TOKEN}`,
  'Notion-Version': NOTION_VERSION,
  'Content-Type': 'application/json',
});

async function notion(path, method = 'GET', body) {
  const res = await fetch(`${NOTION_API}${path}`, {
    method,
    headers: notionHeaders(),
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`Notion ${path} -> ${res.status} ${json.message || ''}`);
  return json;
}

const plain = (p) => {
  if (!p) return '';
  if (p.type === 'title') return (p.title[0]?.plain_text || '').trim();
  if (p.type === 'email') return p.email || '';
  if (p.type === 'select') return p.select?.name || '';
  if (p.type === 'date') return p.date?.start || '';
  return '';
};

const checked = (p) => Boolean(p && p.type === 'checkbox' && p.checkbox);

// Kuala Lumpur, not wherever this runs. Netlify is UTC, and anything after
// 8am MYT would otherwise be dated to the previous day.
const kl = (d) => d.toLocaleDateString('en-CA', { timeZone: 'Asia/Kuala_Lumpur' });

// Whole days elapsed since a KL date. Same arithmetic as session-lookup,
// deliberately.
function daysSince(iso) {
  const from = new Date(`${iso.slice(0, 10)}T00:00:00+08:00`);
  if (Number.isNaN(from.getTime())) return null;
  const today = new Date(`${kl(new Date())}T00:00:00+08:00`);
  return Math.round((today - from) / 86400000);
}

// KL today, shifted back by n days, as YYYY-MM-DD. Used to bound the query.
function klDaysAgo(n) {
  const today = new Date(`${kl(new Date())}T00:00:00+08:00`);
  return kl(new Date(today.getTime() - n * 86400000));
}

// The gate expires on age > WINDOW_DAYS, so the last valid day is the sent
// date plus WINDOW_DAYS, valid through the end of that day.
function expiryDate(sentIso) {
  const sent = new Date(`${sentIso.slice(0, 10)}T00:00:00+08:00`);
  return new Date(sent.getTime() + WINDOW_DAYS * 86400000);
}

const longDate = (d) =>
  d.toLocaleDateString('en-GB', {
    timeZone: 'Asia/Kuala_Lumpur',
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  });

const firstName = (full) => (full || '').trim().split(/\s+/)[0] || 'there';

const SIGNATURE = `Earl Kiu
Editorial · Fashion · Portrait Photographer
earlkiu.com · +60 17-311 0017
`;

function body(name, link, until) {
  return `Hi ${firstName(name)},

Here's the link to pick a date for our session:

${link}

Choose a time that suits you, and the agreement loads on the same page right after — read it properly, then sign. A few minutes, start to finish.

The link is open through ${until}. If it lapses before you get to it, reply here and I'll reopen it.

${SIGNATURE}`;
}

// Same subject as the first email, deliberately. It threads visually in her
// inbox without a real In-Reply-To, and it is the phrase she would search for.
// "Reminder" and "Following up" both announce themselves as automated.
function nudgeBody(name, link, until) {
  return `Hi ${firstName(name)},

Your booking link is still open through ${until}:

${link}

If the timing isn't right, tell me — we'll find another date and I'll reopen it.

${SIGNATURE}`;
}

async function send(to, subject, text) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: FROM,
      to: [to],
      reply_to: 'hello@earlkiu.com',
      subject,
      text,
    }),
  });
  if (!res.ok) throw new Error(`Resend -> ${res.status} ${await res.text()}`);
}

// The guard gets its own PATCH, with nothing else in it to fail on. It used
// to share one with the sent-on date, so a rejected date took the checkbox
// down with it — and a validation error is deterministic, so that is not one
// duplicate but an email every hour until the age gate closes the window.
//
// The sent-on date follows as a separate best-effort write. Nothing reads it
// as a guard, so a failure there must not re-arm the send. A row carrying the
// checkbox with the date blank is the correct direction.
async function markSent(pageId, guardProp, dateProp) {
  await notion(`/pages/${pageId}`, 'PATCH', {
    properties: { [guardProp]: { checkbox: true } },
  });

  try {
    await notion(`/pages/${pageId}`, 'PATCH', {
      properties: { [dateProp]: { date: { start: kl(new Date()) } } },
    });
  } catch (err) {
    console.error(`${dateProp} write failed for ${pageId}:`, err.message);
  }
}

// One query covers both sends. A row is interesting if either checkbox is
// still false — the per-row logic decides which, if any, applies.
//
// The `on_or_after` bound is what keeps this from growing without limit. A
// row that lapsed unsigned used to come back every hour forever, dropped only
// by the per-row age gate; at a few hundred abandoned rows they would have
// crowded live ones out of the page. Notion filters the date, so a lapsed row
// is never fetched at all and the working set stays at whatever was sent in
// the last WINDOW_DAYS days. Pagination below covers the rest.
async function fetchRows() {
  const out = [];
  let cursor;

  do {
    const page = await notion(`/databases/${process.env.NOTION_SESSIONS_DB}/query`, 'POST', {
      filter: {
        and: [
          { property: 'Booking link sent', date: { on_or_after: klDaysAgo(WINDOW_DAYS) } },
          { property: 'Release signed', checkbox: { equals: false } },
          {
            or: [
              { property: 'Booking email sent', checkbox: { equals: false } },
              { property: 'Nudge sent', checkbox: { equals: false } },
            ],
          },
        ],
      },
      page_size: 100,
      start_cursor: cursor,
    });

    out.push(...page.results);
    cursor = page.has_more ? page.next_cursor : undefined;
  } while (cursor);

  return out;
}

export default async () => {
  let sent = 0;
  let nudged = 0;
  let skipped = 0;

  const rows = await fetchRows();

  for (const row of rows) {
    const p = row.properties;

    try {
      if (DONE.has(plain(p.Status))) { skipped++; continue; }

      const linkSent = plain(p['Booking link sent']);
      const age = daysSince(linkSent);

      // Dated into the future, or unparseable. The on_or_after filter already
      // caught anything backdated past the window; this is the belt to that
      // braces, and it is what the expiry date in the email is computed from.
      if (age === null || age < 0 || age > WINDOW_DAYS) { skipped++; continue; }

      const firstDone = checked(p['Booking email sent']);
      const nudgeDone = checked(p['Nudge sent']);

      let isNudge = false;

      if (firstDone) {
        if (nudgeDone) { skipped++; continue; }

        // Measured from the first email, not from `Booking link sent`.
        //
        // `Booking email sent on` is a best-effort write and can legitimately
        // be blank while the checkbox is set — that is documented as the
        // correct failure direction, and it means this date cannot be the
        // only thing the nudge depends on. Falling back to the link date
        // makes a blank cost a slightly early nudge rather than no nudge.
        const firstSent = plain(p['Booking email sent on']) || linkSent;
        const sinceFirst = daysSince(firstSent);
        if (sinceFirst === null || sinceFirst < NUDGE_AFTER_DAYS) { skipped++; continue; }

        isNudge = true;
      }

      const personId = p.Person?.relation?.[0]?.id;
      if (!personId) { skipped++; continue; }

      const person = await notion(`/pages/${personId}`);
      const email = plain(person.properties.Email);
      const name = plain(person.properties.Name);
      if (!email) { skipped++; continue; }

      const link = `${BOOKING_BASE}?s=${row.id}`;
      const until = longDate(expiryDate(linkSent));

      if (!isNudge) {
        // First email. The sign-during-run race is left open here: rows are
        // read at the top and worked through in order, so someone who signs
        // mid-run still gets this. Harmless — session-lookup returns
        // already_signed and the page is dead.
        await send(email, 'Your booking link', body(name, link, until));
        await markSent(row.id, 'Booking email sent', 'Booking email sent on');
        sent++;
        continue;
      }

      // Nudge. Here the race is not harmless — a reminder landing an hour
      // after she signed reads as not having noticed. Re-read the row
      // immediately before sending. One extra call, only on nudge sends.
      const fresh = await notion(`/pages/${row.id}`);
      if (checked(fresh.properties['Release signed'])
        || DONE.has(plain(fresh.properties.Status))
        || checked(fresh.properties['Nudge sent'])) {
        skipped++;
        continue;
      }

      await send(email, 'Your booking link', nudgeBody(name, link, until));
      await markSent(row.id, 'Nudge sent', 'Nudge sent on');
      nudged++;
    } catch (err) {
      console.error(`booking email failed for ${row.id}:`, err.message);
    }
  }

  console.log(`booking-email: sent ${sent}, nudged ${nudged}, skipped ${skipped}`);
  return new Response('ok');
};

export const config = { schedule: '@hourly' };
