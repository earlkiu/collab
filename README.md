# collab.earlkiu.com

Collaboration intake form for the Earl Kiu personal brand. Static HTML,
Netlify Forms, and a function that pushes each submission into Notion.

```
public/
  index.html    the form        (noindex, nofollow)
  thanks.html   confirmation    (noindex)
netlify/
  functions/
    submission-created.mjs   Netlify Forms -> Notion
netlify.toml
```

## Netlify settings

- Publish directory and functions directory are set in `netlify.toml` — leave the
  UI fields empty.
- Build command: none.
- Custom domain: `collab.earlkiu.com`.
- Forms -> Form notifications -> Email -> hello@earlkiu.com.

## Environment variables

Site configuration -> Environment variables:

| Key | Value |
|---|---|
| `NOTION_TOKEN` | Internal integration secret from notion.so/my-integrations |
| `NOTION_PEOPLE_DB` | People database ID |
| `NOTION_SESSIONS_DB` | Sessions database ID |

Both databases must be shared with the integration:
open the database -> ... -> Connections -> add the integration.

## How it works

1. Someone submits the form. Netlify stores the submission.
2. Netlify calls `submission-created`.
3. The function looks up the People database by email.
   Match -> reuse that person. No match -> create them.
4. It creates a Session row of type `Collab`, linked to that person, with the
   long-form answers written into the page body.

Emails are lowercased before matching and before creating, so the lookup stays
consistent. Keep manually entered emails lowercase too.

If the Notion write fails, the submission is still safe in the Netlify Forms
dashboard — check the function log under Logs -> Functions.
