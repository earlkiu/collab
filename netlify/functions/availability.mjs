/**
 * Read-only availability for the collab event type.
 *
 * GET ?from=YYYY-MM-DD&to=YYYY-MM-DD → { days: [{ date, slots: ["09:00", …] }] }
 *
 * Exists so the talent Earl works with can line up dates with other people
 * before anyone asks for a booking link. It only reads slots — nothing here can
 * create, hold or cancel a booking, and no name, email or existing booking is
 * ever returned. Booking still requires a link from Earl.
 *
 * Environment variables:
 *   CAL_API_KEY
 */

const EVENT_TYPE_ID = 6658293; // book-collab
const TZ = 'Asia/Kuala_Lumpur';

// Cal's own booking window is 60 days; asking beyond that returns nothing.
const MAX_DAYS_AHEAD = 60;
const DEFAULT_SPAN = 21;

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
  let to = isDate(q.get('to')) ? q.get('to') : addDays(from, DEFAULT_SPAN);

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

    // Cal returns { "2026-08-20": [{ start: "…" }, …] }. Reduce to clock times
    // so nothing beyond free/busy leaves this function.
    const days = Object.keys(raw)
      .sort()
      .map((date) => ({
        date,
        slots: (raw[date] || [])
          .map((s) => {
            const t = typeof s === 'string' ? s : s.start;
            if (!t) return null;
            return new Date(t).toLocaleTimeString('en-GB', {
              hour: '2-digit', minute: '2-digit', timeZone: TZ,
            });
          })
          .filter(Boolean),
      }))
      .filter((d) => d.slots.length);

    return json({ from, to, timeZone: TZ, days });
  } catch (err) {
    console.error('availability failed:', err.message);
    return json({ error: 'unavailable' }, 502);
  }
};
