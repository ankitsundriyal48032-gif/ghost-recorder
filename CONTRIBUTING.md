# Contributing to Ghost Recorder

Thanks for helping! This is a plain-JS Chrome MV3 extension — no build step, no framework.

## Dev loop
1. `chrome://extensions` → Developer mode → **Load unpacked** → `extension/`.
2. Edit files → click ↻ on the extension card → test in a real meeting (a second browser profile in the same Meet room works well).
3. Syntax check before a PR: `node --check extension/*.js`.
4. Debug consoles: service worker + offscreen document (both linked on the extension card), plus the page console for content-script/inject logs (`[Ghost Recorder]`).

## Code style
- Vanilla JS, 2-space indent, single quotes, semicolons. No dependencies in `extension/`.
- Comments only for constraints the code can't express (Chrome quirks, audio-graph invariants).
- Keep the recorder path (`offscreen.js` audio graph) conservative — a regression there silently ruins someone's meeting.

## High-value open items
- Zoom/Teams live-caption DOM selectors (they change often; ours are best-effort).
- VAD silence-trimming before AI upload (smaller/cheaper calls; fixes Groq 25MB cap on long meetings).
- Map-reduce summarization for 2h+ meetings.
- Per-chunk streaming recovery beyond the current 20s snapshots.

## PR checklist
- [ ] `node --check` passes on all touched JS
- [ ] Tested at least one real recording end-to-end (record → notes → playback → click-to-seek)
- [ ] No new permissions without discussion in an issue first
