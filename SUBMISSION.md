# Submission: Ajaia Docs

**Live product URL:** `https://ajaia-docs-o6es.onrender.com/#/`
**Walkthrough video:** see `VIDEO_URL.txt`
**Source repository:** `<OPTIONAL: GitHub URL>`

## Test accounts

All passwords are `demo1234`. The login page has one-click buttons for each account.

- `alice@ajaia.test`: owns "Q3 Planning Notes", shared with Bob (edit) and Carol (view)
- `bob@ajaia.test`: owns "Bob's private draft"
- `carol@ajaia.test`: view-only collaborator

## What's included

| Item | Location |
|---|---|
| Source code | `src/` (server), `public/` (frontend), `test/`, `scripts/` |
| Setup & run instructions | `README.md` |
| Architecture note | `ARCHITECTURE.md` |
| AI workflow note | `AI_WORKFLOW.md` |
| This file | `SUBMISSION.md` |
| Walkthrough video link | `VIDEO_URL.txt` |
| Screenshots of every main flow | `docs/screenshots/` (01–09) |
| Sample files for the upload feature | `samples/` (`.md`, `.txt`, `.docx`) |
| Automated tests | `test/api.test.js`, `test/importers.test.js` (`npm test`, 14 passing) |
| Deployment config | `render.yaml`, `Dockerfile` |

## Status

**Working end to end**
- Create, rename, edit, autosave and reopen documents, with bold/italic/underline/strikethrough, H1–H3, bulleted and numbered lists, and undo/redo
- Import `.txt` / `.md` / `.docx` (≤ 2 MB) as a new document, keeping formatting
- Sharing by email with **Can edit / Can view** roles, role changes and revoking access; separate "My documents" and "Shared with me" lists; read-only mode for viewers
- SQLite persistence; server-side sanitizing; stale-edit (409) conflict handling; validation and error states

**Partial or intentionally incomplete**
- No real-time co-editing. Concurrent edits are detected and blocked (409), not merged.
- `.docx` import skips images, tables and comments; legacy `.doc` and PDF are not supported.
- No sign-up or password reset (seeded accounts only).
- On Render's free tier, data resets to the seed state when the service restarts or redeploys (ephemeral disk).

**Next 2–4 hours:** version history (restore previous saves), export to Markdown/PDF, Postgres for durable hosted data, and simple presence indicators. Details are in `ARCHITECTURE.md`.
