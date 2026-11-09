# Architecture note

## Shape of the system

```
Browser (vanilla JS SPA)                     Node.js 22 (no npm dependencies)
┌────────────────────────────┐   JSON/HTTP   ┌──────────────────────────────────────┐
│ login → doc list → editor  │ ────────────▶ │ node:http router  (src/server.js)    │
│ contenteditable + toolbar  │   cookie      │  ├─ auth: scrypt + session tokens    │
│ autosave w/ baseVersion    │ ◀──────────── │  ├─ access control: owner/editor/viewer│
│ share dialog, file import  │               │  ├─ sanitize HTML (allowlist)        │
└────────────────────────────┘               │  └─ importers: txt / md / docx       │
                                             │ node:sqlite  (src/db.js)             │
                                             │  users · sessions · documents · shares│
                                             └──────────────────────────────────────┘
```

## What I prioritized, and why

1. **A coherent core loop over a wide feature list.** The flow create → write with formatting → autosave → reopen → share → collaborator sees it works fully, with error states, rather than many half-built features.
2. **Access control that's actually enforced.** Every document route resolves the caller's role (`owner`, `editor`, `viewer`, or none) in one SQL query (`roleFor`) and checks it against an explicit allowlist (`requireRole`).
   - Documents you can't access return **404, not 403**, so document IDs can't be probed.
   - Only owners can share, change roles, revoke or delete. Viewers can read but not write.
3. **Safety of shared content.** Documents are HTML written in one user's browser and rendered in another's, which makes stored XSS the main real risk.
   - On every save and import, the server runs an **allowlist sanitizer**: about 13 formatting tags, *all* attributes stripped, `script`/`style`/`iframe`/`svg`… dropped with their contents.
   - A strict **CSP** (`script-src 'self'`) is a second layer.
   - Paste is inserted as plain text so foreign markup never enters a document.
4. **Not losing people's work.** Each document has a `version` column. Every save sends `baseVersion`, and the update is `WHERE id = ? AND version = ?`. A stale save gets **409** plus the latest document, and the UI offers "Copy my version" / "Load latest version". This is the minimum responsible behaviour once more than one person can edit, without building real-time sync.
5. **A build reviewers can run in seconds.** There are no dependencies: SQLite comes from Node itself (`node:sqlite`), tests use `node:test`, and the `.docx` importer uses a ~60-line ZIP reader over `zlib`. `npm start` works on a fresh clone, and deployment is one Render blueprint.

## Key decisions and tradeoffs

| Decision | Why | Cost / what I'd revisit |
|---|---|---|
| **`contenteditable` + `execCommand`** instead of TipTap/ProseMirror/Lexical | Zero build step and no dependencies. Covers every required format, and browsers produce consistent semantic tags (`<b>`, `<ul>`, `<h1>`). | `execCommand` is deprecated, and edge cases (nested lists, pasting) are less polished. For a real product I'd switch to **TipTap**: a structured JSON doc model, schema-enforced content, and Yjs for real-time collaboration. |
| **Store sanitized HTML** (not a JSON doc model) | Simple, preserves structure, renders directly, easy to export later. | Harder to diff or merge than a structured model, and no per-node history. |
| **SQLite** via `node:sqlite` | Real relational constraints (FKs, `CHECK` on role, composite PK on shares) with nothing to install. | Single-node only. On Render's free tier the disk is ephemeral, so data resets on restart; move to Postgres or a persistent disk for real use. The SQL is portable. |
| **Seeded users + real login** (scrypt, HttpOnly SameSite cookie) | Demonstrates genuine sessions and per-user access while keeping sign-up out of scope. | No sign-up or password reset. Sharing works only with existing accounts, and the error message says so. |
| **Import creates a new document** (vs. attachments) | It's the most product-relevant use of upload for a doc editor, and it exercises parsing and formatting preservation. | No attachments or images. `.docx` import keeps paragraphs, headings, B/I/U and lists, not tables or images. |
| **Optimistic concurrency** (409) instead of real-time co-editing | Prevents silent data loss at a fraction of the cost of CRDT/OT. | Two editors can't type at the same moment; the second one has to reload. |
| **Role-based sharing (viewer/editor)** | This was the one stretch item I took on, because it falls naturally out of the access-control design and makes sharing meaningfully more realistic. | No link sharing, groups or transfer of ownership. |

## Deliberately out of scope

- Real-time co-editing and presence
- Comments and suggestions
- Version history
- Export
- Images and tables
- Sign-up and password reset
- Link sharing
- Pagination of the document list
- Mobile-optimized toolbar

Where it was cheap, the architecture leaves room for these: `version` already exists for history, and sanitized HTML is easy to export.

## What I'd build next with another 2–4 hours

1. **Version history**: a `document_versions` table written on each save (throttled), plus a "restore" view. The version counter is already there.
2. **Export to Markdown/PDF**: HTML → Markdown is small given the constrained tag set; PDF via the browser's print stylesheet.
3. **Persistent hosting**: Postgres (e.g. Neon/Supabase free tier) behind the same queries, so demo data survives restarts.
4. **Presence indicators**: show "Bob is viewing" by polling a lightweight heartbeat endpoint, as a cheap step toward real-time collaboration.
5. **Editor upgrade path**: TipTap with the same sanitized-HTML storage format, so existing documents keep working.

## Validation and error handling (summary)

- JSON-only write endpoints (`415` otherwise), body size cap (4 MB), title 1–200 chars, content ≤ 1 MB, upload ≤ 2 MB with an extension allowlist, and a zip-bomb cap on `.docx` decompression.
- Consistent JSON errors `{ error }` with correct status codes (400/401/403/404/409/413/415/422/500). Unexpected errors are logged and return a generic 500.
- The client shows errors inline (login, share dialog, import) or as banners in the editor. Autosave retries on network errors and keeps unsaved edits, and the browser warns before closing with unsaved changes.
