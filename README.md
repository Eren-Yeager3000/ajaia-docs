# Ajaia Docs

A lightweight collaborative document editor inspired by Google Docs, built for the Ajaia AI-Native Full Stack Developer assignment.

**Live demo:** `https://ajaia-docs-o6es.onrender.com/#/` (free tier; the first request after idling can take ~50 s to wake up)

## What it does

| Area | What works |
|---|---|
| **Documents** | Create, rename (click the title), edit in the browser, autosave (~0.8 s after you stop typing, or Ctrl/Cmd+S), reopen. Delete (owner only). |
| **Rich text** | Bold, italic, underline, strikethrough, Heading 1–3, bulleted and numbered lists, undo/redo, clear formatting. |
| **File upload** | **Import `.txt`, `.md` or `.docx` (max 2 MB)** → becomes a new editable document you own. Headings, bold/italic/underline and lists carry over from Markdown and Word. Other file types are rejected with a clear message. |
| **Sharing** | The owner shares by email as **Can edit** or **Can view**, can change roles, and can revoke access. The home page separates **My documents** from **Shared with me**, with role badges. Viewers get a read-only editor. |
| **Persistence** | SQLite. Documents, formatting (stored as sanitized HTML), sharing and sessions survive refreshes and restarts. |
| **Safety** | Server-side HTML sanitizing (allowlist), a strict Content-Security-Policy, scrypt password hashes, HttpOnly session cookies, and stale-edit detection (HTTP 409) so two editors can't silently overwrite each other. |

## Demo accounts

All passwords are **`demo1234`**. The login screen has one-click buttons for each account.

| User | Email | Seeded data |
|---|---|---|
| Alice | `alice@ajaia.test` | Owns "Q3 Planning Notes" (shared with Bob as editor and Carol as viewer) |
| Bob | `bob@ajaia.test` | Owns "Bob's private draft"; sees Q3 Planning Notes under *Shared with me* |
| Carol | `carol@ajaia.test` | Sees Q3 Planning Notes as *View only* |

**Suggested review path (≈3 min):**
1. Sign in as Alice → **+ New document** → rename it → type and format some text.
2. **Share** → add `bob@ajaia.test` as *Can view*.
3. **Import file…** → pick `samples/weekly-sync.md` or `samples/launch-brief.docx`.
4. Sign out, then sign in as Bob → the document appears under **Shared with me** with a *View only* badge, and the editor is read-only.
5. Optional conflict demo: open the same doc as an editor in two browsers (e.g. Alice in one, Bob in a private window on "Q3 Planning Notes"), edit in both. The second save shows a "newer version" banner instead of overwriting.

## Run locally

**Requirements:** Node.js **22.13 or newer** (uses the built-in `node:sqlite` module). There are **no npm dependencies**.

```bash
git clone <repo-url> ajaia-docs
cd ajaia-docs
npm start            # → http://localhost:3000
```

- Data is stored in `data/app.db` (created and seeded on first run). Delete that file to reset to the seed data.
- Optional environment variables: `PORT` (default `3000`) and `DB_PATH` (default `./data/app.db`).
- `npm run dev` restarts the server on file changes.

## Tests

```bash
npm test
```

There are 14 tests using Node's built-in test runner. The API tests boot the real server on a random port with a throwaway database and cover:
- auth
- create/rename/edit/reopen with formatting preserved
- owner/editor/viewer/stranger permissions, including revoking access
- share validation
- stale-edit 409 conflicts
- XSS sanitizing
- validation errors
- Markdown import

The unit tests cover the `.docx`/`.txt`/`.md` importers and the sanitizer.

There is also an optional browser smoke test (`scripts/e2e-smoke.js`, needs Playwright). It walks through every main flow and writes the screenshots in `docs/screenshots/`.

## Deploy (Render, free)

1. Push this repo to GitHub.
2. In Render: **New → Blueprint**, pick the repo (it reads `render.yaml`), and deploy. Alternatively: **New → Web Service**, with build command `npm install` and start command `npm start`.
3. Health check: `GET /api/health`.

A `Dockerfile` is included for any container host.

> **Note on the free tier:** Render's free web services have an ephemeral disk. The SQLite file resets to the seed data when the service restarts or redeploys. That's fine for review; for real use, attach a persistent disk or move to Postgres (see `ARCHITECTURE.md`).

## Supported upload formats

`.txt`, `.md` / `.markdown` and `.docx`, up to 2 MB. Images, tables and comments inside `.docx` files are not imported; their text paragraphs are. `.doc` (legacy Word), PDF and other formats are rejected. This is stated in the UI next to the Import button.

## Project layout

```
src/server.js      HTTP server, routing, access control, validation
src/db.js          SQLite schema + seed users/documents
src/auth.js        scrypt password hashing, session tokens, cookies
src/sanitize.js    allowlist HTML sanitizer
src/importers.js   .txt / .md / .docx → HTML (tiny built-in ZIP reader for .docx)
public/            index.html, app.js, styles.css: the single-page frontend
test/              node:test suites + a .docx fixture
scripts/           optional Playwright smoke test
samples/           example files to try the import feature
docs/screenshots/  screenshots of every main flow
```

See **ARCHITECTURE.md** for design decisions and **AI_WORKFLOW.md** for how AI tools were used.
