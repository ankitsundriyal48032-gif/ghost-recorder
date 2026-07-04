// Ghost Recorder — "Ask AI" (Fathom-style chat) for the dashboard.
// Answers questions grounded ONLY in meeting notes/transcripts, via the user's
// own BYOK provider (Gemini native, or any OpenAI-compatible chat endpoint).
(function () {
  const DEF = {
    provider: 'gemini', keys: {}, customBaseUrl: '',
    models: { gemini: 'gemini-2.5-flash', groq: 'llama-3.3-70b-versatile', openrouter: 'google/gemini-2.5-flash', custom: '' },
  };
  function getSettings() {
    return new Promise((r) => chrome.storage.local.get('settings', ({ settings }) => {
      const s = settings || {};
      r(Object.assign({}, DEF, s, { keys: Object.assign({}, s.keys || {}), models: Object.assign({}, DEF.models, s.models || {}) }));
    }));
  }

  const SYS = `You are Ask Ghost — the AI assistant inside the Ghost Recorder meeting app.
Answer the user's questions using ONLY the meeting context provided. Rules:
- Be concise and specific. Use markdown bullets/bold where it helps scanning.
- Cite speaker names, and [mm:ss] timestamps when referring to a moment.
- For action items use "- [ ] Owner — task".
- If the context does not contain the answer, say plainly that it wasn't discussed — never invent facts.`;

  async function askGemini(s, question, history, context) {
    const key = (s.keys.gemini || '').trim();
    if (!key) throw new Error('Add your Gemini key in Settings.');
    const contents = [
      { role: 'user', parts: [{ text: SYS + '\n\nMEETING CONTEXT:\n' + context }] },
      { role: 'model', parts: [{ text: 'Understood — ask me anything about these meetings.' }] },
    ];
    (history || []).forEach((h) => contents.push({ role: h.role === 'user' ? 'user' : 'model', parts: [{ text: h.text }] }));
    contents.push({ role: 'user', parts: [{ text: question }] });
    const chain = [s.models.gemini || 'gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-2.5-flash-lite'].filter((m, i, a) => a.indexOf(m) === i);
    let lastErr;
    for (const model of chain) {
      const resp = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify({ contents, generationConfig: { temperature: 0.3, maxOutputTokens: 2048 } }),
      });
      if (!resp.ok) { lastErr = new Error('Gemini ' + resp.status + ': ' + (await resp.text()).slice(0, 200)); if ([404, 429, 500, 502, 503].includes(resp.status)) continue; throw lastErr; }
      const d = await resp.json();
      const t = d.candidates && d.candidates[0] && d.candidates[0].content && d.candidates[0].content.parts;
      const text = t && t.map((p) => p.text || '').join('').trim();
      if (text) return text;
      lastErr = new Error('AI returned no answer — try again.');
    }
    throw lastErr || new Error('Gemini failed');
  }

  async function askOpenAI(s, question, history, context) {
    let base, key, model, extra = {};
    if (s.provider === 'groq') { base = 'https://api.groq.com/openai/v1'; key = s.keys.groq; model = s.models.groq; }
    else if (s.provider === 'openrouter') { base = 'https://openrouter.ai/api/v1'; key = s.keys.openrouter; model = s.models.openrouter; extra = { 'HTTP-Referer': 'https://ghost-recorder.app', 'X-Title': 'Ghost Recorder' }; }
    else { base = (s.customBaseUrl || '').trim(); key = s.keys.custom; model = s.models.custom; if (!base || !model) throw new Error('Custom provider needs a Base URL + model in Settings.'); }
    if (!(key || '').trim()) throw new Error('Add your ' + s.provider + ' key in Settings.');
    const messages = [
      { role: 'system', content: SYS },
      { role: 'user', content: 'MEETING CONTEXT:\n' + context },
      { role: 'assistant', content: 'Understood — ask me anything about these meetings.' },
    ];
    (history || []).forEach((h) => messages.push({ role: h.role === 'user' ? 'user' : 'assistant', content: h.text }));
    messages.push({ role: 'user', content: question });
    const resp = await fetch(base.replace(/\/$/, '') + '/chat/completions', {
      method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json', Authorization: 'Bearer ' + key.trim() }, extra),
      body: JSON.stringify({ model, messages, temperature: 0.3, max_tokens: 2048 }),
    });
    if (!resp.ok) throw new Error('Ask ' + resp.status + ': ' + (await resp.text()).slice(0, 200));
    const t = (await resp.json()).choices?.[0]?.message?.content;
    if (!t) throw new Error('AI returned no answer.');
    return t.trim();
  }

  async function ask(question, history, context) {
    const s = await getSettings();
    return (s.provider || 'gemini') === 'gemini' ? askGemini(s, question, history, context) : askOpenAI(s, question, history, context);
  }

  self.GhostAsk = { ask };
})();
