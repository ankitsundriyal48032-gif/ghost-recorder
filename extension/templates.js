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
    customer_discovery: {
      label: 'Customer discovery / user interview',
      skeleton: `# Discovery Interview — {{person / company}}
**Date:** {{date}}  ·  **Interviewee:** {{name, role}}  ·  **Interviewer:** {{name}}

## Their World (context)
{{2-3 sentences on who they are and their situation}}

## Problems & Pain Points
- {{pain}} — {{severity/frequency if stated}}

## Current Solution / Workarounds
- {{how they solve it today}}

## Memorable Quotes
> {{verbatim quote}}

## Feature Requests / Reactions
- {{request or reaction to what was shown}}

## Willingness to Pay / Buying Signals
- {{signal or "not discussed"}}

## Action Items
- [ ] {{owner}} — {{task}} {{(due: date)}}`,
    },
    job_interview: {
      label: 'Job interview / screening',
      skeleton: `# Interview — {{candidate}} for {{role}}
**Date:** {{date}}  ·  **Interviewers:** {{names}}  ·  **Stage:** {{screen | technical | final | unknown}}

## Candidate Snapshot
{{2-3 sentences: background, current role, headline strengths}}

## Experience & Skills Discussed
- {{skill/experience}} — {{evidence given}}

## Strengths Observed
- {{strength}}

## Concerns / Gaps
- {{concern}}

## Candidate's Questions & Motivations
- {{what they asked / what they want}}

## Logistics
- **Notice period / availability:** {{stated or "not discussed"}}
- **Compensation expectations:** {{stated or "not discussed"}}

## Action Items
- [ ] {{owner}} — {{task}} {{(due: date)}}`,
    },
    team_meeting: {
      label: 'Team meeting / project sync',
      skeleton: `# Team Sync — {{team / project}}
**Date:** {{date}}  ·  **Attendees:** {{names}}

## TL;DR
{{2-3 sentences}}

## Status by Topic / Workstream
### {{topic}}
- {{update}} — {{on track | at risk | blocked}}

## Risks & Blockers
- {{risk/blocker}} — {{owner / needs}}

## Decisions
- {{decision}}

## Action Items
- [ ] {{owner}} — {{task}} {{(due: date)}}`,
    },
    brainstorm: {
      label: 'Brainstorm / workshop',
      skeleton: `# Brainstorm — {{topic}}
**Date:** {{date}}  ·  **Participants:** {{names}}

## Goal / Prompt
{{what the group was trying to solve}}

## Ideas Raised
- **{{idea}}** — {{one-line description; who proposed it if clear}}

## Standout Ideas (most discussed / best received)
- {{idea}} — {{why it stood out}}

## Concerns / Constraints Raised
- {{concern}}

## Next Steps
- [ ] {{owner}} — {{task}} {{(due: date)}}`,
    },
    lecture: {
      label: 'Lecture / webinar / training',
      skeleton: `# Notes — {{session title}}
**Date:** {{date}}  ·  **Speaker:** {{name}}  ·  **Duration:** {{duration}}

## One-Paragraph Summary
{{what this session taught}}

## Key Concepts
### {{concept}}
{{2-3 line explanation as taught}}

## Examples / Case Studies Used
- {{example}}

## Practical Takeaways
- {{something the listener can apply}}

## Q&A Highlights
- **Q:** {{question}} → **A:** {{answer}}

## Resources Mentioned
- {{book / link / tool}}`,
    },
    customer_success: {
      label: 'Client check-in / customer success',
      skeleton: `# Client Check-in — {{client}}
**Date:** {{date}}  ·  **Attendees:** {{names + roles}}  ·  **Health:** {{green | yellow | red — judge from tone}}

## Summary
{{2-3 sentences}}

## Wins Since Last Check-in
- {{win}}

## Issues / Complaints
- {{issue}} — {{impact; how upset are they}}

## Requests
- {{feature/support request}}

## Renewal / Expansion Signals
- {{signal: growth, churn risk, upsell opening — or "none"}}

## Commitments Made to the Client
- [ ] {{owner}} — {{commitment}} {{(due: date)}}

## Internal Follow-ups
- [ ] {{owner}} — {{task}}`,
    },
    leadership: {
      label: 'Leadership / board review',
      skeleton: `# Leadership Review — {{meeting name}}
**Date:** {{date}}  ·  **Attendees:** {{names + roles}}

## Executive Summary
{{3-4 sentences: state of the business/project as presented}}

## Metrics & Results Reported
- {{metric}}: {{value / trend}}

## Strategic Discussion
- {{topic}} — {{positions taken, by whom}}

## Decisions
- {{decision}} — {{decided by}}

## Asks & Approvals
- {{who asked for what}} → {{approved | denied | deferred}}

## Action Items
- [ ] {{owner}} — {{task}} {{(due: date)}}`,
    },
    retro: {
      label: 'Sprint retrospective',
      skeleton: `# Retro — {{team / sprint}}
**Date:** {{date}}  ·  **Participants:** {{names}}

## What Went Well
- {{item}}

## What Didn't Go Well
- {{item}}

## Root Causes Discussed
- {{cause behind the biggest pain}}

## Ideas / Experiments to Try
- {{improvement}}

## Action Items (committed changes)
- [ ] {{owner}} — {{task}} {{(due: date)}}

## Kudos
- {{shout-out}}`,
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
