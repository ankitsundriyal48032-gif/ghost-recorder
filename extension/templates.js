// Ghost Recorder — Note templates (Fathom-style).
// Each template is a markdown skeleton the AI fills. Loaded in the offscreen doc
// (for prompt building) and referenced by id in settings.

(function () {
  const TEMPLATES = {
    general: {
      label: 'General meeting',
      skeleton: `# Meeting Notes — {{title}}
**Date:** {{date}}  ·  **Duration:** {{duration}}  ·  **Platform:** {{platform}}
**Participants:** {{participants or "Unknown"}}

## TL;DR
{{2-3 sentence summary of why this meeting happened and the outcome}}

## Key Points
- {{point}}

## Decisions
- {{decision}}

## Action Items
- [ ] {{owner}} — {{task}} {{(due: date if stated)}}

## Open Questions / Parking Lot
- {{question}}`,
    },
    sales: {
      label: 'Sales / discovery call',
      skeleton: `# Sales Call — {{prospect_company}}
**Date:** {{date}}  ·  **Attendees:** {{names + titles}}  ·  **Stage:** {{discovery | demo | negotiation | unknown}}

## Summary
{{3-4 sentences}}

## Pain Points / Needs
- {{pain}}

## BANT / Qualification
- **Budget:** {{stated or "not discussed"}}
- **Authority (decision makers):** {{who}}
- **Need:** {{core need}}
- **Timeline:** {{when}}

## Objections Raised
- {{objection}} → {{response / resolution}}

## Competitors Mentioned
- {{competitor}}

## Next Steps
- [ ] {{owner}} — {{commitment}} {{(due: date)}}

## CRM-Ready Snippet
{{one paragraph the rep can paste into the deal note}}`,
    },
    one_on_one: {
      label: '1:1 / Standup',
      skeleton: `# {{"1:1" | "Standup"}} — {{names or team}}
**Date:** {{date}}

## Since Last Time
- {{progress item}}

## Today / Focus
- {{plan item}}

## Blockers
- {{blocker}} {{(needs: who/what)}}

## Discussion / Feedback
- {{topic}}

## Action Items
- [ ] {{owner}} — {{task}} {{(due: date)}}

## Follow-ups for Next Time
- {{item}}`,
    },
  };

  function systemPrompt(id, meta, opts) {
    const t = TEMPLATES[id] || TEMPLATES.general;
    const m = meta || {};
    const includeTranscript = !opts || opts.includeTranscript !== false;
    return `You are an expert meeting-notes assistant. Produce notes as GitHub-flavored Markdown that fills the EXACT skeleton below.

RULES:
- Preserve every heading verbatim. Omit a section only if there is genuinely NO content for it; never invent facts.
- Be concise, skimmable and action-oriented (Fathom-grade quality).
- Action items must use: "- [ ] Owner — task (due: date if stated)". Use a real owner name when known, else "Unassigned".
- Known context — Date: ${m.date || 'Unknown'} · Platform: ${m.platform || 'Unknown'} · Duration: ${m.duration || 'Unknown'}.
- Use REAL speaker names from the provided captions/speaker hints wherever possible.${includeTranscript ? `
- After the skeleton, add a "## Full Transcript" section. STRICT FORMAT — every line MUST be exactly: "[mm:ss] Speaker: text" (use [h:mm:ss] past one hour). No bold, no bullets, no extra prose.
- TIMESTAMP ACCURACY IS CRITICAL: [mm:ss] must be the actual position in the audio where that sentence STARTS (listeners click a line to jump the recording there). Never bunch timestamps or reset them; they must increase monotonically through the whole audio, ending near the meeting duration given above.
- SPEAKER ACCURACY: distinguish speakers by voice. Use real names from the captions/hints; when a voice has no name, label it consistently "Speaker 1", "Speaker 2", … for the entire transcript (never merge different voices into one label).
- Transcribe the ENTIRE audio start to finish — do not summarize, skip, or stop early.` : ''}
- If the audio/transcript is empty or silent, output only "# Meeting Notes — ${m.date || ''}" then "No spoken audio detected."

SKELETON:
${t.skeleton}`;
  }

  self.GhostTemplates = {
    list: Object.entries(TEMPLATES).map(([id, t]) => ({ id, label: t.label })),
    get: (id) => ({ id: TEMPLATES[id] ? id : 'general', skeleton: (TEMPLATES[id] || TEMPLATES.general).skeleton, systemPrompt: (meta, opts) => systemPrompt(id, meta, opts) }),
  };
})();
