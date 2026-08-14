/**
 * Read-only availability for the collab event type.
 *
 * GET ?from=YYYY-MM-DD&to=YYYY-MM-DD → { days: [{ date, clear }] }
 *
 * Exists so the talent Earl works with can line up dates with other people
 * before anyone asks for a booking link. Nothing here can create, hold or
 * cancel a booking, and no name, email, existing booking or clock time is ever
 * returned — only which dates could still take a session.
 *
 * What counts as available: a day where a full six-hour session still fits.
 * Cal already accounts for the two-hour buffers either side, so a day only
 * appears if the slots it offers are genuinely usable. Days marked `clear` are
 * untouched — nothing on the calendar at all.
 *
 * Environment variables:
 *   CAL_API_KEY
 */

const EVENT_TYPE_ID = 6658293; // book-collab
const TZ = 'Asia/Kuala_Lumpur';

// Cal's own booking window is 60 days; asking beyond that returns nothing.
const MAX_DAYS_AHEAD = 60;

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      // Slots move slowly. A short cache keeps repeated checks off the API.
      'Cache-Control': 'public, max-age=300',
    },
  });

function todayKL() {
  return new Date().toLocaleDateString('en-CA', { timeZone: TZ });
}

function addDays(iso, n) {
  const d = new Date(`${iso}T00:00:00+08:00`);
  d.setDate(d.getDate() + n);
  return d.toLocaleDateString('en-CA', { timeZone: TZ });
}

const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v || '');

export default async (req) => {
  if (!process.env.CAL_API_KEY) return json({ error: 'Not configured' }, 500);

  const q = new URL(req.url).searchParams;
  const today = todayKL();

  let from = isDate(q.get('from')) ? q.get('from') : today;
  let to = isDate(q.get('to')) ? q.get('to') : addDays(today, MAX_DAYS_AHEAD);

  // Never look backwards, never past Cal's own window.
  if (from < today) from = today;
  const ceiling = addDays(today, MAX_DAYS_AHEAD);
  if (to > ceiling) to = ceiling;
  if (to < from) to = from;

  try {
    const url = new URL('https://api.cal.com/v2/slots');
    url.searchParams.set('eventTypeId', String(EVENT_TYPE_ID));
    url.searchParams.set('start', from);
    url.searchParams.set('end', to);
    url.searchParams.set('timeZone', TZ);

    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${process.env.CAL_API_KEY}`,
        'cal-api-version': '2024-09-04',
      },
    });

    if (!res.ok) {
      console.error(`cal slots → ${res.status}`);
      return json({ error: 'unavailable' }, 502);
    }

    const body = await res.json();
    const raw = body.data || {};

    // Cal returns { "2026-08-20": [{ start: "…" }, …] }. Every slot Cal offers
    // is one a full session can start at, so any slot means the day is usable.
    // The widest span still open is the signal for whether anything is on the
    // calendar at all — a day with a booking loses most of its start times.
    const counts = Object.keys(raw).map((date) => ({
      date,
      n: (raw[date] || []).length,
    })).filter((d) => d.n > 0);

    // A completely free day offers the most start times of any day in the
    // window. Anything short of that has something on it.
    const busiest = counts.reduce((max, d) => (d.n > max ? d.n : max), 0);

    const days = counts
      .sort((a, b) => (a.date < b.date ? -1 : 1))
      .map((d) => ({ date: d.date, clear: d.n >= busiest }));

    return json({ from, to, timeZone: TZ, days });
  } catch (err) {
    console.error('availability failed:', err.message);
    return json({ error: 'unavailable' }, 502);
  }
};
