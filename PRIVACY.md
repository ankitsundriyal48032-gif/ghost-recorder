# Privacy Policy — Ghost Recorder

_Last updated: 2026-07-05_

Ghost Recorder is a **local-first, bring-your-own-key** meeting recorder. There is no Ghost Recorder server, no account, no analytics, and no telemetry.

## What the extension stores — on your device only
- **Recordings** (video/audio) — saved to your Downloads folder and kept temporarily in the browser's local IndexedDB (newest 12) for in-app playback, retry, and crash recovery.
- **Notes, transcripts, meeting history, settings, and your API keys** — in `chrome.storage.local` on your machine.

## What leaves your device — and only when you generate notes
- The meeting **audio** (and captions, if any) is sent **directly** to the AI provider whose API key **you** configured — Google Gemini, Groq, OpenRouter, or your own custom OpenAI-compatible endpoint. That request goes from your browser to that provider; no intermediary receives it.
- Their handling of that data is governed by the provider's own privacy policy and your agreement with them.

## What we collect
Nothing. We cannot see your recordings, notes, keys, questions, or usage. There is no backend.

## Permissions, in plain words
| Permission | Why |
|---|---|
| `tabCapture`, `offscreen` | Record the meeting tab's audio/video without a bot joining |
| `downloads` (+shelf/ui/open) | Save recordings/notes into a tidy per-meeting folder, quietly |
| `storage`, `unlimitedStorage` | Keep settings, meeting history, and local copies of recordings |
| `notifications` | Tell you when notes are ready or something failed |
| `tabs`, `scripting`, `activeTab`, host access | Detect meetings, show the record overlay/captions, pin call audio so it's recordable (Teams) |

## Recording consent
Laws about recording conversations vary (some places require all-party consent). Ghost Recorder adds a "recorded by an AI notetaker" line to notes by default, but **you are responsible for informing participants and complying with the laws that apply to you**.

## Contact
Open an issue on the GitHub repository.
