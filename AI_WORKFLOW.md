# AI workflow note

> ✏️ **Before submitting:** this note describes how the build actually went. Edit it so it is in your own voice, and add anything from your own review and testing (for example, bugs you found when you clicked through it yourself). Reviewers will ask about it in the walkthrough.

## Tools used

- **Claude (Anthropic), agentic coding session.** I used it to plan the scope, generate the first draft of the server, frontend, importers and tests, run the test suite and a headless-browser walkthrough, and draft the docs.
- **Playwright (headless Chromium).** Used to click through the real UI and capture the screenshots in `docs/screenshots/`.
- **Node's built-in test runner** for the automated tests.

## Where AI materially sped things up

- **Boilerplate I'd otherwise type by hand:** the router, SQL schema, CRUD handlers and the CSS for the doc list, editor and share dialog. Roughly an hour saved.
- **The `.docx` importer.** Reading the ZIP central directory and mapping WordprocessingML (`w:p`, `w:r`, `w:pStyle`, `w:numPr`, `numbering.xml`) to HTML would have meant a lot of spec-reading. AI produced a working draft quickly, and I verified it against a real Word file generated with the `docx` library.
- **Test scaffolding.** It drafted a multi-user test client (one cookie jar per simulated user) and the permission matrix, so I could spend the time deciding *which* cases mattered.

## What I changed or rejected

- **Rejected the default stack suggestion (React + TipTap + an ORM).** The workspace couldn't install packages, and I also wanted reviewers to run the app with zero setup. I chose a dependency-free build (`node:sqlite`, `node:test`, `contenteditable`) and wrote down the TipTap upgrade path as a tradeoff in `ARCHITECTURE.md` instead.
- **The test command didn't run.** The first `npm test` script (`node --test test/`) failed because Node 22 treats the folder as a module path. I changed it to an explicit glob (`"test/*.test.js"`).
- **An empty-paragraph bug from browser testing.** Blank lines were saved as `<p></p>`, which collapse to zero height after a reload, so the layout shifted. I added a sanitizer step that stores them as `<p><br></p>`.
- **The editor header scrolled away.** Screenshots showed the title, save status and Share button disappearing in long documents. I made the header and toolbar a single sticky block.
- **Removed speculative code.** The generated `.docx` heading matcher included a localized ("Überschrift") style-name hack. I removed it as untested scope.
- **Tightened security defaults** beyond the first draft:
  - inaccessible documents return 404 instead of 403
  - writes require `Content-Type: application/json` as a CSRF guard
  - a zip-bomb output cap on `.docx` decompression
  - paste is plain-text only

## How I verified correctness, UX and reliability

1. **Automated tests (14, `npm test`):** the API tests run against the real server and a throwaway SQLite file and cover:
   - permissions for owner, editor, viewer and stranger, including revoking access
   - 409 on stale saves
   - XSS payloads stripped
   - validation errors
   - Markdown and `.docx` import fidelity
2. **Scripted browser walkthrough (`scripts/e2e-smoke.js`):** three real browser sessions (Alice, Bob, Carol) that:
   - create and format a document, reload it, and check the HTML survived
   - share it, and confirm Bob's editor is read-only
   - trigger a real edit conflict between Carol and Alice
   - import a `.docx`
   - try an unsupported file and an inaccessible URL

   The run also checks for zero JavaScript errors.
3. **Looking at the screenshots** of each state (list, editor, share dialog, viewer, conflict, import). This is how the sticky-header issue was caught.
4. **Reading the security-relevant code myself:** `requireRole`, the sanitizer, cookie flags and the SQL. AI output in these areas was checked line by line rather than trusted.
