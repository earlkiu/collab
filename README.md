# collab.earlkiu.com

Booking and signing for unpaid photography collaborations. Someone applies, Earl
qualifies them personally, they pick a date and sign a model release, and the
signed contract writes itself back into Notion.

Three systems, joined by one string: **Notion** (records) · **Cal.com**
(scheduling) · **eSignatures.com** (contracts).

Static HTML on Netlify. No framework, no build step, no dependencies.

> **Working on this?** Read [`CLAUDE.md`](CLAUDE.md) — architecture, environment
> variables, template IDs, and the traps that have already cost time.

---

## Layout

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
    submission-created.mjs   Netlify Forms -> Notion
    session-lookup.mjs       gates /booking on the 5-day window
    create-contract.mjs      planned flow: Notion + Cal -> contract
    on-set.mjs               Earl's on-set list + contract creation
    on-set-intake.mjs        walk-up: form -> Notion -> contract, one pass
    esign-webhook.mjs        signed -> Notion, confirm Cal booking
    availability.mjs         Cal slots -> public grid
netlify.toml
```

## The three flows

**Planned.** Collab form → Notion row → Earl qualifies → sends the booking link
→ she picks a date → agreement loads on the same page → she signs → the webhook
marks the row and confirms the pending Cal booking.

**Walk-up.** Earl opens `/booking/schedule` on set and shows a QR. She fills six
fields, the agreement loads on her phone, she signs. Person, session and contract
are created in one request.

**Change of mind mid-shoot.** Same page, tap her name. It sees the agreement is
already signed and builds the standalone Schedule 1 instead. The original is
untouched.

## Deploy

`dev` for staging, PR to `main` to deploy. Netlify site
`rainbow-bienenstitch-3b1b0e`, domain `collab.earlkiu.com`.

Publish and functions directories are set in `netlify.toml` — leave the Netlify
UI fields empty. No build command.

Environment variables are listed in [`CLAUDE.md`](CLAUDE.md). Both Notion
databases must be shared with the integration: database → ⋯ → Connections.

## When something breaks

The browser only ever shows a plain message. **The real error is in Netlify →
Logs → Functions.**

If a Notion write fails, the form submission is still safe in the Netlify Forms
dashboard.
