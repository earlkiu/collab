# CLAUDE.md

Working notes for `collab.earlkiu.com`. Build-facing only — architecture,
functions, env vars, and the traps that have already cost time. Business context
(legal review, stamp duty, why decisions were made) lives outside this repo.

**If you change a function, change this file in the same commit.** The previous
reference doc went stale because the code moved and the doc didn't.

---

## What this is

Booking and signing for unpaid photography collaborations. Someone applies, Earl
qualifies them personally, they pick a date and sign a model release, and the
signed contract writes itself back into Notion.

Three systems, joined by one string: **Notion** (records) · **Cal.com**
(scheduling) · **eSignatures.com** (contracts).

Static HTML on Netlify. No framework, no build step, no dependencies.

```
public/
  index.html               the collab form            (noindex, nofollow)
  thanks.html              confirmation               (noindex)
  booking/
    index.html             Cal date -> agreement, same page
    new.html               short on-set intake -> agreement
    schedule.html          Earl's phone: session list -> QR
    availability.html      public month grid, read-only
    contract.html          manual fallback
    confirmed.html         end screen
netlify/
  functions/
    submission-created.mjs   Netlify Forms -> Notion, then the application PDF
    session-lookup.mjs       gates /booking on the 5-day window
    create-contract.mjs      planned flow: Notion + Cal -> contract
    on-set.mjs               Earl's on-set list + contract creation
    on-set-intake.mjs        walk-up: form -> Notion -> contract, one pass
    esign-webhook.mjs        signed -> Notion, confirm Cal booking
    availability.mjs         Cal slots -> public grid
    booking-email.mjs        booking link + one nudge, hourly schedule
    lib/
      pdf.mjs                hand-rolled text-only PDF writer
      delivery.mjs           application PDF -> email (Resend) -> Google Drive
netlify.toml
```

Publish and functions directories are set in `netlify.toml` — **leave the
Netlify UI fields empty.** No build command.

**`lib/` is not a function.** A subdirectory of the functions folder only becomes
a function if it contains a file named after the folder (`lib/lib.mjs`). It does
not, so `lib/` is the one place a shared module can live — see *Conventions*.

---

## Deploy

`dev` for staging, PR to `main` to deploy. Test on the live site after merge —
it conserves build credits.

Netlify site `rainbow-bienenstitch-3b1b0e`, custom domain `collab.earlkiu.com`.

Env var changes only take effect on the next deploy.

---

## The three flows

**Planned.** Collab form → Notion row → Earl qualifies → sets **Booking link
sent** → sends **Booking link** → `session-lookup` checks the 5-day window →
Cal date → `create-contract` → she signs → `esign-webhook` marks the row and
confirms the Cal booking.

**Walk-up.** `/booking/schedule` → *Someone new* → QR → `/booking/new` → six
fields → `on-set-intake` creates person, session and contract in one request →
she signs. `Source: Direct`, shoot date today.

**Change of mind mid-shoot.** `/booking/schedule` → tap her name → `on-set` sees
`Release signed` is already true → builds the **standalone Schedule 1** → QR →
she signs. The original agreement is untouched.

---

## The collab form

`public/index.html`. Netlify Forms, `enctype="multipart/form-data"`, one file per
field — `multiple` silently drops everything after the first.

**Every `<option>` must carry an explicit `value`.** Without one the submitted
value is the visible text, and Chrome's page translation rewrites text nodes, so
a translated page posts a translated value and Notion auto-creates an option for
it. It also breaks any JS comparing `select.value` against an English string.
`toggleReferred()` and `toggleAgency()` both compare against the value. Fixed
20 Aug in `553468a`; radios were always safe.

Field names are the Notion-facing keys and must match `submission-created`
exactly. Added 28 Aug: `Agency`, `Agency name`, and six optional measurement
fields — `Height`, `Bust or chest`, `Waist`, `Hips`, `Dress or suit size`,
`Shoe size`. All six are `type="text"` with `inputmode="numeric"` so they keep
the shared input styling.

The page resizes images in the browser before submitting — 1600px long edge,
JPEG 0.82 — because Netlify caps the whole submission at 8 MB and times uploads
out at 30 seconds.

---

## Environment variables

Scoped to Functions.

| Key | Notes |
|---|---|
| `NOTION_TOKEN` | Internal integration secret |
| `NOTION_PEOPLE_DB` | People database ID |
| `NOTION_SESSIONS_DB` | Sessions database ID |
| `ESIGNATURES_TOKEN` | API auth **and** the HMAC key for webhook verification |
| `CAL_API_KEY` | Never expires |
| `RESEND_API_KEY` | Used by `booking-email.mjs` and the application email. Without it the hourly run throws and no booking link or nudge goes out; the application email logs that it skipped |
| `ON_SET_KEY` | Invented random string. The only thing protecting `/booking/schedule`, which lists client names |
| `ESIGN_TEST_EMAILS` | Optional, comma-separated. Extra addresses that always send free |
| `ESIGN_TEST_MODE` | Optional. `yes` forces every contract free. **Never set on Production** |
| `APPLICATION_EMAIL_TO` | Optional. Where the application PDF is emailed. Defaults to `itsme@earlkiu.com` |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | Optional. The whole service account key file, as JSON. **Not set** — the Drive upload is inert without it |
| `GDRIVE_FOLDER_ID` | Optional. Destination folder, shared with that service account as Editor. **Not set** |

Both Notion databases must be shared with the integration:
database → ⋯ → Connections → add the integration.

---

## The application PDF

`submission-created.mjs` ends by rendering the whole submission as a PDF,
emailing it to `APPLICATION_EMAIL_TO` with the PDF attached, and filing the same
PDF in Google Drive. Code in `lib/delivery.mjs`, writer in `lib/pdf.mjs`.

**All three legs are best effort and run after the Notion writes**, each in its
own try/catch. A Drive outage never costs the email, and nothing here can fail
the submission — the Notion row is what must not be lost.

**The PDF writer is hand-rolled on purpose.** The repo has no `package.json`, and
adding one would put an `npm install` in front of a build that has none, for one
text document a week. Base-14 Helvetica is built into every reader, so nothing is
embedded.

**Latin-1 only.** Typographic punctuation is folded to ASCII on the way in and
anything still outside Latin-1 becomes `?`. A name in a non-Latin script will not
survive into the PDF; the email body and the Notion row carry it intact.

**Drive is inert until the two Google variables are set.** It logs that it
skipped and the email still goes. Auth is a service-account JWT signed with
`node:crypto` — no library. Scope `https://www.googleapis.com/auth/drive`, which
sees only what has been shared with the service account.

Photograph URLs go into the PDF as **plain text**, not annotations — they are
Netlify submission links and the only copy of the files, so a link you cannot
read out of the page is useless. Treat the PDF as being as shareable as they are.

**Netlify's own form notification still sends**, without an attachment, and
duplicates this email. Turn it off in the Netlify UI if it annoys; nothing here
controls it.

---

## Templates

| Template | ID |
|---|---|
| Collaboration Agreement and Model Release | `d42be4d3-af77-41e0-82ad-2e11799e5332` |
| Schedule 1 — Wardrobe and Scope *(embedded)* | `597b12b4-7cb9-4e4a-bac8-d85b0e0996c1` |
| Schedule 1 — Wardrobe and Scope *(standalone)* | `f9574239-e102-40bf-982c-1f33b649e23b` |

The embedded schedule is injected with `replace_with_template`, and **only** when
`Comfort level` is in `NEEDS_SCHEDULE` — implied, topless, full nudity. For any
other level the placeholder is filled with an empty string, so the schedule is
not in the document at all. A blank schedule must never be a thing that means
something.

`NEEDS_SCHEDULE` is duplicated in `create-contract`, `on-set` and
`on-set-intake`. **Change it in all three or none.**

The em dash in `'Implied — strategically covered'` is an em dash, not a hyphen.
It must match the Notion select option exactly or the schedule silently never
attaches.

**The contract title is set per contract and overrides the template's own.**
eSignatures prints it as the heading on page one, names the signed PDF with it,
and puts it in the subject of her email. `DOCUMENT_TITLE` —
`Collaboration Agreement and Model Release` — is a constant in
`create-contract`, `on-set` and `on-set-intake`, **the third thing duplicated
three ways**. Schedule 1 keeps its own title.

**The agreement is thirteen clauses**, renumbered 28 Aug. The reschedule
carve-out — *except a change of date or location, which may be agreed by email or
message* — is now in **clause 12**, not clause 9. Both Schedule 1 templates cite
clauses 3 and 6, which have never moved; check those two if a clause is ever
inserted before 12. The wording itself is not in this repo.

---

## The join key

No Notion property holds the contract id or the Cal booking uid. eSignatures'
`metadata` carries them:

```
"<notion session page id>|<cal booking uid>|<kind>"
```

`kind` is `agreement` or `schedule`; absent defaults to `agreement`. It comes
back on the webhook and is the only link between the three systems.

`Release` stores the stable permalink `https://esignatures.com/contracts/<id>`,
never `contract_pdf_url` — that expires in 3 days.

---

## Test mode

Decided **per contract, by signer email** — not by a global constant.

```js
const testMode = (email) =>
  (FORCE_TEST || TEST_EMAILS.has(String(email || '').trim().toLowerCase()) ? 'yes' : 'no');
```

A contract addressed to `itsme@earlkiu.com` or `hello@earlkiu.com` sends free. A
real model is never one of them, so there is no switch to leave on by accident.
To test the flow end to end on production, book as yourself.

Live contracts cost **$0.49 each, charged on send, not on signature** — an
abandoned booking still bills.

Verified 17 Aug: test contracts fire the webhook normally, and a contract
addressed to the account owner is accepted. The webhook payload carries
`contract.test` if a handler ever needs to tell them apart.

**Notion, Cal and People/Sessions writes are real in test mode.** Only the
contract is free. Test runs leave real rows and real pending bookings.

**`booking-email.mjs` and the application email have no test mode.** Both mail a
real address every time.

---

## Cal.com

Event type `book-collab`, id **6658293**. Six hours, free, hidden. Advance
booking capped at 60 days.

`confirmationPolicy: always` — bookings arrive **pending**, and the webhook
confirms them once she signs. That pending window is the hold.

**Do not set `successRedirectUrl`.** It is a paid feature. The embed's
client-side `bookingSuccessful` event fires free in the browser, and `/booking`
uses it to swap the calendar for the agreement in place. `/booking/contract`
survives only as a manual fallback.

`availability.mjs` was built against `cal-api-version: 2024-09-04`. If the grid
comes up empty on a day known to be free, the response shape changed — that is
the first thing to check.

**Nothing reads a cancellation.** The agreement's clause 11 gives Earl a
seventy-two-hour cancellation window, and no function computes it or hears about
a Cal cancellation. It is a term invoked by hand, not a gate.

---

## The signature

One canonical block, ending every outbound email. It reads exactly:

```
Earl Kiu
Editorial · Fashion · Portrait Photographer
earlkiu.com · +60 17-311 0017
```

`booking-email.mjs` holds it as the `SIGNATURE` constant, shared by the booking
link and the nudge. **That constant is the source of truth.**

Two other copies exist and **cannot be merged into it**, because neither lives
in this repo:

1. **Gmail's signature setting.** It is inserted by the Gmail compose window in
   the browser and never travels — anything sent through the Gmail API, sent or
   drafted, goes out with exactly the body supplied and no signature at all
2. **Anything sent on Earl's behalf** by an assistant or connector, which must
   paste the block above verbatim

Changing one does not change the others. Change all three or none, and copy from
this file rather than from memory. The middle dots are `·` (U+00B7), not periods;
the number carries `+60` and a space after `311`.

**Emails are plain text.** Resend is called with `text` only, never `html`.
There is no stylesheet and no brand font, and that is deliberate — Artifex Hand
CF is an Adobe font and cannot be embedded in email, Gmail strips `@font-face`
regardless, and an HTML body costs deliverability for nothing. Any new outbound
email keeps the plain-text form and ends with `SIGNATURE`.

The application email is the one exception to the signature rule: it goes to
Earl, not to talent, so it carries none.

`FROM` is `Earl Kiu <hello@earlkiu.com>` with `reply_to` set to the same
address. Replies land in the inbox Earl actually reads, not `itsme@`. The
application email sets `reply_to` to the applicant instead, so replying to it
answers her.

---

## Traps

**Text that must survive exactly**

- **A non-ASCII character can be flattened between an editor and this repo.** A
  non-breaking space in `lib/pdf.mjs` arrived as an ordinary space twice — once
  as a literal, once as a ` ` escape — leaving a rule that replaced a space
  with a space. It is now built with `String.fromCharCode(160)`, which is plain
  ASCII on disk. **Do the same for anything that must survive byte for byte**
- **Read the committed file back through the API, not the raw CDN.**
  `raw.githubusercontent.com` serves a stale copy for minutes after a push and
  will make a good commit look like a failed one

**eSignatures API**

- It **rewrites JSON config key order on save**. `update_template_content`
  matches literally — always `query_template_content` first and match exactly
  what comes back
- **No-op edits are rejected** (`no-content-updated`), and `dry_run` cannot
  preview an unchanged file
- **`&` in a title HTML-escapes** to `&amp;`. The Schedule 1 bodies use `&`
  safely — the trap is titles only
- **`default_value` does not work on `date` line-type fields.** Prefill or
  picker, not both. DOB is a `text-input` for this reason
- **Signer fields cannot be interpolated into prose.** They render as input
  lines, so no sentence in the document can contain her name — that is why the
  agreement opens "the person named below"
- **Radio buttons group by adjacency** — directly consecutive lines, no blank
  line or paragraph between them — and `input_required` on the first is
  inherited by the rest of the group
- **`contract_pdf_url` expires in 3 days** and is JSON-encoded — decode before
  fetching
- **Webhooks retry six times.** Agreement handling is guarded on
  `Release signed`; the schedule branch is **not**, so a retry there would
  double-append
- Two names appear on a contract: `signers[].name` is fixed at creation, the
  `model_name` signer field is hers to correct. They can differ

**Notion**

- MCP writes need explicit approval and **fail silently** — fetch the page
  immediately after to verify
- Emails are lowercased before matching and before creating. Keep manually
  entered ones lowercase
- `submission-created` refreshes `Measurements`, `Agency` and `Agency name` on a
  returning applicant. The patch is built through the same `clean()` that drops
  undefined values, **so a blank answer never wipes an earlier one** — keep it
  that way

**GitHub connector**

- Content must be **raw**. An HTML-escaped payload commits `&lt;` literally
- `create_or_update_file` needs a **fresh SHA** — fetch immediately before
  writing, and verify on `main` after a merge
- `push_files` has timed out mid-call leaving nothing committed. **Re-read before
  assuming a push landed**
- Desktop only

**Timezone.** The eSignatures account is in **ap-southeast-2 (Sydney)** and
rendered US Pacific out of the box, putting contracts on the wrong *date*. Fixed
in settings, but it applies to **new contracts only**, and the audit trail still
carries no timezone label. All date formatting in the functions pins
`timeZone: 'Asia/Kuala_Lumpur'` — keep it that way.

---

## Conventions

- Every top-level `.mjs` in `netlify/functions/` is treated as a function, so
  **a shared helper module there is a trap.** `notion`, `esig`, `plain`,
  `prettyDate`, `SIGNATURE`, `NEEDS_SCHEDULE`, `DOCUMENT_TITLE` and the
  test-mode block are duplicated on purpose
- **`lib/` is the way out of that**, because a subdirectory is only a function if
  it holds a file named after the folder. Nothing has been moved there yet; the
  duplication above stands until someone does it deliberately, in one commit,
  with all copies removed
- Failures return a plain message to the browser and log the detail. The real
  error is in Netlify → Logs → Functions, never on screen
- `/booking` is a link Earl sends. It is never linked from the form or the
  thanks page — booking comes after qualification
- If a Notion write fails, the submission is still in the Netlify Forms
  dashboard

---

## Known gaps

- **Nothing on the collab form fills `Brief`.** "What we are making" is
  `session_brief`, read from the Notion `Brief` property, typed by hand before
  `Booking link sent`. Blank prints *To be confirmed*, and the line that bounds
  the session bounds nothing. `/booking/new` is the only path where she supplies
  it
- **Cal `BOOKING_RESCHEDULED` webhook is not built.** A client-side reschedule
  leaves `Shoot date` stale with nothing to signal it. The agreement itself
  survives a reschedule — the template says so in the Session block and in
  clause 12 — so this is a data-freshness gap, not a legal one
- **Drive archive built, not wired up.** `lib/delivery.mjs` uploads the
  application PDF once `GOOGLE_SERVICE_ACCOUNT_JSON` and `GDRIVE_FOLDER_ID` are
  set; neither is. **Signed contract PDFs are still not archived at all** —
  eSignatures retention is 3 years, the release is perpetual, and the webhook
  only logs the URL
- **The 28 Aug work is untested.** Measurements, agency, the Person-property
  refresh, the application PDF and its email have not been exercised by a real
  submission
- **`create-contract` and the Cal leg have not been tested end to end.** The
  17 Aug run covered `on-set-intake` only
- **Schedule 1 injection** — a free test contract was sent 28 Aug with metadata
  `schedule-1-injection-test`. Result not yet recorded here
- `/booking/schedule` lists 15 rows — crowded at ~30 sessions
- `README.md` describes only the original form and one function. It predates
  everything above
