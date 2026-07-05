// Ghost Recorder — multi-provider BYOK AI layer (runs in the offscreen document).
// Turns the recorded audio (+ scraped captions) into templated markdown notes.
// Providers: Gemini (native audio), Groq (Whisper -> chat), OpenRouter / custom
// OpenAI-compatible (STT -> chat). No server; keys come from settings.

(function () {
  const GEMINI_BASE = 'https://generativelanguage.googleapis.com';
  const GEMINI_INLINE_MAX = 14 * 1024 * 1024;
  const GROQ_STT_MAX = 24 * 1024 * 1024; // 25MB free-tier cap, keep margin
  const GEMINI_FALLBACKS = ['gemini-3.1-flash-lite', 'gemini-3.1-flash', 'gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-2.0-flash', 'gemini-1.5-flash'];

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function blobToBase64(blob) {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let bin = ''; const step = 0x8000;
    for (let i = 0; i < bytes.length; i += step) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + step));
    return btoa(bin);
  }

  // ---- WebM/opus -> 16kHz mono WAV (fallback for providers that reject webm) ----
  function encodeWav(samples, rate) {
    const buf = new ArrayBuffer(44 + samples.length * 2);
    const v = new DataView(buf);
    const wr = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    wr(0, 'RIFF'); v.setUint32(4, 36 + samples.length * 2, true); wr(8, 'WAVE');
    wr(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
    wr(36, 'data'); v.setUint32(40, samples.length * 2, true);
    let o = 44;
    for (let i = 0; i < samples.length; i++) { const s = Math.max(-1, Math.min(1, samples[i])); v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7FFF, true); o += 2; }
    return buf;
  }
  async function webmToWav(blob) {
    const AC = self.AudioContext || self.webkitAudioContext;
    const tmp = new AC();
    const decoded = await tmp.decodeAudioData(await blob.arrayBuffer());
    tmp.close();
    const rate = 16000;
    const off = new OfflineAudioContext(1, Math.max(1, Math.round(decoded.duration * rate)), rate);
    const src = off.createBufferSource(); src.buffer = decoded; src.connect(off.destination); src.start();
    const rendered = await off.startRendering();
    return new Blob([encodeWav(rendered.getChannelData(0), rate)], { type: 'audio/wav' });
  }

  // ---- Shared OpenAI-compatible chat (Groq / OpenRouter / custom) ----
  async function chatComplete(baseUrl, apiKey, model, messages, extraHeaders, maxTokens) {
    const resp = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` }, extraHeaders || {}),
      body: JSON.stringify({ model, messages, temperature: 0.3, max_tokens: maxTokens || 8192 }),
    });
    if (!resp.ok) throw new Error(`Chat ${resp.status}: ${(await resp.text()).slice(0, 300)}`);
    const data = await resp.json();
    const text = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    if (!text) throw new Error('Chat returned no text');
    return text.trim();
  }

  // ---- Groq Whisper ----
  async function groqTranscribe(blob, apiKey, model) {
    const form = new FormData();
    form.append('file', blob, 'meeting.webm');
    form.append('model', model || 'whisper-large-v3-turbo');
    form.append('response_format', 'json');
    form.append('language', 'en');
    const resp = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
      method: 'POST', headers: { Authorization: `Bearer ${apiKey}` }, body: form,
    });
    if (!resp.ok) throw new Error(`Groq STT ${resp.status}: ${(await resp.text()).slice(0, 300)}`);
    return (await resp.json()).text || '';
  }

  // ---- OpenRouter dedicated STT ----
  async function openrouterTranscribe(blob, apiKey) {
    const resp = await fetch('https://openrouter.ai/api/v1/audio/transcriptions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model: 'openai/whisper-1', input_audio: { data: await blobToBase64(blob), format: 'webm' } }),
    });
    if (!resp.ok) throw new Error(`OpenRouter STT ${resp.status}: ${(await resp.text()).slice(0, 300)}`);
    return (await resp.json()).text || '';
  }

  // ---- Gemini native (audio -> templated notes in one call) ----
  async function geminiGenerate(model, apiKey, contents) {
    // Notes INCLUDE the full transcript, so long meetings need a big output
    // budget — 8192 tokens cut transcripts off around the 20-minute mark.
    // Gemini 1.5 caps output at 8192; 2.x/3.x accept far more.
    const outCap = /gemini-1\.5/.test(model) ? 8192 : 65536;
    const resp = await fetch(`${GEMINI_BASE}/v1beta/models/${model}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({
        contents,
        generationConfig: { temperature: 0.2, maxOutputTokens: outCap },
        safetySettings: [
          { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
          { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
          { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
          { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
        ],
      }),
    });
    if (!resp.ok) {
      const body = await resp.text();
      const err = new Error(`Gemini ${resp.status}: ${body.slice(0, 300)}`);
      err.status = resp.status; err.body = body;
      throw err;
    }
    const data = await resp.json();
    const cand = data.candidates && data.candidates[0];
    const ps = cand && cand.content && cand.content.parts;
    const text = ps && ps.map((p) => p.text || '').join('').trim();
    if (!text) {
      const reason = (data.promptFeedback && data.promptFeedback.blockReason) || (cand && cand.finishReason) || 'empty';
      throw new Error('Gemini returned no text (' + reason + ')');
    }
    return { text, truncated: cand && cand.finishReason === 'MAX_TOKENS' };
  }
  async function geminiUploadFile(blob, mime, apiKey) {
    const start = await fetch(`${GEMINI_BASE}/upload/v1beta/files`, {
      method: 'POST',
      headers: {
        'x-goog-api-key': apiKey, 'X-Goog-Upload-Protocol': 'resumable', 'X-Goog-Upload-Command': 'start',
        'X-Goog-Upload-Header-Content-Length': String(blob.size), 'X-Goog-Upload-Header-Content-Type': mime, 'Content-Type': 'application/json',
      },
      body: JSON.stringify({ file: { display_name: 'meeting-audio' } }),
    });
    const url = start.headers.get('x-goog-upload-url');
    if (!url) throw new Error('Files API: no upload URL');
    const up = await fetch(url, { method: 'POST', headers: { 'x-goog-api-key': apiKey, 'X-Goog-Upload-Offset': '0', 'X-Goog-Upload-Command': 'upload, finalize' }, body: blob });
    let file = (await up.json()).file;
    for (let i = 0; i < 20 && file && file.state === 'PROCESSING'; i++) {
      await sleep(1500);
      file = await (await fetch(`${GEMINI_BASE}/v1beta/${file.name}`, { headers: { 'x-goog-api-key': apiKey } })).json();
    }
    if (!file || file.state !== 'ACTIVE') throw new Error('Files API: not ACTIVE');
    return file.uri;
  }

  async function buildAudioParts(audioBlob, apiKey, mime) {
    if (audioBlob.size <= GEMINI_INLINE_MAX) return [{ inline_data: { mime_type: mime, data: await blobToBase64(audioBlob) } }];
    return [{ file_data: { mime_type: mime, file_uri: await geminiUploadFile(audioBlob, mime, apiKey) } }];
  }

  // ---- transcript coverage helpers ----
  // Long audio has TWO failure modes: (a) output-token cap (finishReason
  // MAX_TOKENS) and (b) the model just STOPS transcribing early with a normal
  // finish. (a) is detectable from the API; (b) only shows up as the last
  // [mm:ss] falling short of the real recording length — so we check coverage.
  function parseDurSec(s) {
    if (!s || typeof s !== 'string') return 0;
    const m = s.match(/(?:(\d+)\s*h)?\s*(?:(\d+)\s*m)?\s*(?:(\d+)\s*s)?/i);
    return m ? (+(m[1] || 0)) * 3600 + (+(m[2] || 0)) * 60 + (+(m[3] || 0)) : 0;
  }
  function lastTsSec(text) {
    const all = text.match(/\[(\d{1,2}):(\d{2})(?::(\d{2}))?\]/g);
    if (!all || !all.length) return 0;
    const m = all[all.length - 1].match(/\[(\d{1,2}):(\d{2})(?::(\d{2}))?\]/);
    return m[3] !== undefined ? (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]) : (+m[1]) * 60 + (+m[2]);
  }
  const fmtTs = (sec) => {
    sec = Math.max(0, Math.round(sec));
    const h = Math.floor(sec / 3600), mn = Math.floor((sec % 3600) / 60), s = sec % 60;
    return (h ? h + ':' + String(mn).padStart(2, '0') : mn) + ':' + String(s).padStart(2, '0');
  };
  async function audioDurationSec(blob, meta) {
    const fromMeta = parseDurSec(meta && meta.duration);
    if (fromMeta) return fromMeta;
    try { // offscreen.js (same page) exposes measureDurationMs
      if (typeof measureDurationMs === 'function') return (await measureDurationMs(blob, 0)) / 1000;
    } catch (e) { /* best effort */ }
    return 0;
  }

  async function geminiRun(audioBlob, captions, settings, tmpl, meta) {
    const apiKey = (settings.keys && settings.keys.gemini || '').trim();
    if (!apiKey) throw new Error('No Gemini API key set — open Settings.');
    const preferred = (settings.models && settings.models.gemini) || 'gemini-3.1-flash-lite';
    const chain = [preferred].concat(GEMINI_FALLBACKS).filter((m, i, a) => a.indexOf(m) === i);

    const promptText = tmpl.systemPrompt(meta, { includeTranscript: true }) +
      (captions ? '\n\nSPEAKER CAPTIONS (real names + timestamps — may cover only PART of the meeting if CC was turned off; the AUDIO is the complete record, use captions only to attribute who spoke):\n' + captions : '');

    // Primary: send webm (works in practice). Fallback: transcode to wav on mime errors.
    let audioParts, mime = 'audio/webm';
    try { audioParts = await buildAudioParts(audioBlob, apiKey, mime); }
    catch (e) { audioParts = await buildAudioParts(await webmToWav(audioBlob), apiKey, (mime = 'audio/wav')); }

    const makeParts = () => [{ text: promptText }].concat(audioParts);
    let wavTried = mime === 'audio/wav';
    let lastErr;
    for (const model of chain) {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const durSec = await audioDurationSec(audioBlob, meta);
          const contents = [{ role: 'user', parts: makeParts() }];
          let g = await geminiGenerate(model, apiKey, contents);
          let full = g.text;
          const warnings = [];
          // Keep the SAME audio in context (1M window) and force continuation
          // until the transcript actually reaches the end of the recording —
          // whether the model hit its output cap OR just stopped early.
          const gapSec = () => (durSec > 240 ? (durSec - 100) - lastTsSec(full) : -1);
          for (let round = 0; (g.truncated || gapSec() > 0) && round < 8; round++) {
            const at = lastTsSec(full);
            const ask = g.truncated
              ? 'You ran out of output space. CONTINUE exactly where you stopped — no preamble, no repetition of anything already written, keep the same strict "[mm:ss] Speaker: text" format until the very end of the audio.'
              : `Your transcript stops at [${fmtTs(at)}] but the recording is ${fmtTs(durSec)} long — you stopped too early. Listen to the REMAINING audio and CONTINUE the Full Transcript from [${fmtTs(at)}] all the way to the end. Same strict "[mm:ss] Speaker: text" format, timestamps must keep increasing past [${fmtTs(at)}]; do not repeat lines already written; no preamble, transcript lines only.`;
            try {
              contents.push({ role: 'model', parts: [{ text: g.text }] });
              contents.push({ role: 'user', parts: [{ text: ask }] });
              g = await geminiGenerate(model, apiKey, contents);
              full += (full.endsWith('\n') || g.text.startsWith('\n') ? '' : '\n') + g.text;
              if (!g.truncated && lastTsSec(full) <= at) break; // no forward progress — stop looping
            } catch (contErr) {
              warnings.push('Transcript continuation failed partway (' + contErr.message.slice(0, 120) + ') — the end of the meeting may be missing. Regenerate to try again.');
              break;
            }
          }
          if (gapSec() > 0 && !warnings.length) warnings.push(`The transcript covers about ${fmtTs(lastTsSec(full))} of a ${fmtTs(durSec)} recording even after ${'auto-continuation'} — if the last part is missing, regenerate; if it keeps stopping at the same point, the audio itself may go silent there (check by playing the recording near ${fmtTs(lastTsSec(full))}).`);
          return { notes: full, model, provider: 'gemini', warnings };
        } catch (err) {
          lastErr = err;
          const s = err.status;
          // mime rejected -> transcode to wav once and retry this model
          if (!wavTried && /INVALID_ARGUMENT|mime|unsupported/i.test(err.message)) {
            wavTried = true; mime = 'audio/wav';
            audioParts = await buildAudioParts(await webmToWav(audioBlob), apiKey, mime);
            continue;
          }
          if (s === 404 || s === 429 || s === 500 || s === 502 || s === 503 || !s) break; // next model
          throw err; // 400/403 etc
        }
      }
    }
    throw lastErr || new Error('Gemini failed');
  }

  async function chatProviderRun(audioBlob, captions, settings, tmpl, meta) {
    const provider = settings.provider;
    let baseUrl, apiKey, model, extraHeaders = {};
    if (provider === 'groq') {
      baseUrl = 'https://api.groq.com/openai/v1';
      apiKey = (settings.keys.groq || '').trim();
      model = (settings.models && settings.models.groq) || 'llama-3.3-70b-versatile';
    } else if (provider === 'openrouter') {
      baseUrl = 'https://openrouter.ai/api/v1';
      apiKey = (settings.keys.openrouter || '').trim();
      model = (settings.models && settings.models.openrouter) || 'google/gemini-2.5-flash';
      extraHeaders = { 'HTTP-Referer': 'https://ghost-recorder.app', 'X-Title': 'Ghost Recorder' };
    } else { // custom OpenAI-compatible
      baseUrl = (settings.customBaseUrl || '').trim();
      apiKey = (settings.keys.custom || '').trim();
      model = (settings.models && settings.models.custom) || '';
      if (!baseUrl || !model) throw new Error('Custom provider needs a Base URL and Model in Settings.');
    }
    if (!apiKey) throw new Error(`No API key set for ${provider} — open Settings.`);

    const warnings = [];
    const sysText = (inc) => tmpl.systemPrompt(meta, { includeTranscript: inc });
    // Captions are a PARTIAL name-attribution aid (they stop the moment CC is turned
    // off); the recorded audio is the complete record and always drives the transcript.
    const captionHint = captions ? `\n\nSPEAKER CAPTIONS (real names + timestamps — may cover only part of the meeting; use ONLY to attribute who spoke):\n${captions}` : '';
    const userText = (transcript) => (transcript ? `MEETING TRANSCRIPT (speech-to-text, the complete record):\n${transcript}` : '') + captionHint;
    const fullSection = (transcript) => { const full = transcript || captions; return full ? `\n\n## Full Transcript\n\n${full}` : ''; };
    const captionsOnlyNotes = async () => {
      warnings.push('Notes were generated from Meet captions only — captions stop when CC is turned off, so parts of the meeting may be missing.');
      const n = await chatComplete(baseUrl, apiKey, model, [{ role: 'system', content: sysText(false) }, { role: 'user', content: userText('') }], extraHeaders);
      return n + fullSection('');
    };

    let notes, transcript = '';
    if (provider === 'groq') {
      try {
        if (audioBlob.size <= GROQ_STT_MAX) transcript = await groqTranscribe(audioBlob, apiKey, settings.groqWhisper);
        else warnings.push('Audio exceeded Groq 25MB — transcribed from captions only.');
      } catch (e) { warnings.push('Groq speech-to-text failed (' + e.message + ').'); }
      if (!transcript && !captions) throw new Error('No transcript: Groq STT failed and no captions. Turn on Meet CC or use Gemini.');
      notes = await chatComplete(baseUrl, apiKey, model, [{ role: 'system', content: sysText(false) }, { role: 'user', content: userText(transcript) }], extraHeaders);
      notes += fullSection(transcript);
    } else if (provider === 'openrouter') {
      // Audio first (complete record) via input_audio WAV; captions only as a fallback.
      try {
        const b64 = await blobToBase64(await webmToWav(audioBlob));
        notes = await chatComplete(baseUrl, apiKey, model, [
          { role: 'system', content: sysText(true) },
          { role: 'user', content: [{ type: 'text', text: 'Transcribe and produce the notes from this meeting audio.' + captionHint }, { type: 'input_audio', input_audio: { data: b64, format: 'wav' } }] },
        ], extraHeaders, 32768); // response carries the full transcript — needs a big output budget
      } catch (e) {
        if (!captions) throw new Error('OpenRouter audio failed (' + e.message.slice(0, 200) + '). Pick an audio-capable model (e.g. google/gemini-2.5-flash) or turn on Meet CC.');
        warnings.push('OpenRouter audio model failed (' + e.message.slice(0, 120) + ').');
        notes = await captionsOnlyNotes();
      }
    } else if (captions) {
      notes = await captionsOnlyNotes(); // custom endpoints can't take audio — captions are all we have
    } else {
      throw new Error('Custom provider needs a transcript: turn on Google Meet captions/CC, or use Gemini/Groq for audio.');
    }
    return { notes, model, provider, warnings, transcript };
  }

  function injectConsent(notes) {
    const line = '> _This meeting was recorded and summarized by an AI notetaker (Ghost Recorder)._';
    const nl = notes.indexOf('\n');
    return nl === -1 ? notes + '\n\n' + line : notes.slice(0, nl + 1) + line + '\n' + notes.slice(nl + 1);
  }
  async function run(audioBlob, captions, settings, meta) {
    const tmpl = self.GhostTemplates.get((settings && settings.template) || 'general');
    const provider = (settings && settings.provider) || 'gemini';
    const res = provider === 'gemini'
      ? await geminiRun(audioBlob, captions, settings, tmpl, meta)
      : await chatProviderRun(audioBlob, captions, settings, tmpl, meta);
    if (settings && settings.consentNote !== false && res && res.notes) res.notes = injectConsent(res.notes);
    return res;
  }

  self.GhostProviders = { run };
})();
