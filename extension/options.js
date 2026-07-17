// Ghost Recorder — Settings logic. Settings in chrome.storage.local under "settings".
const DEFAULTS = {
  provider: 'gemini',
  keys: { gemini: '', groq: '', openrouter: '', custom: '' },
  models: { gemini: 'gemini-3.1-flash-lite', groq: 'llama-3.3-70b-versatile', openrouter: 'google/gemini-2.5-flash', custom: '' },
  modelHistory: { gemini: [], groq: [], openrouter: [], custom: [] },
  groqWhisper: 'whisper-large-v3-turbo',
  customBaseUrl: '',
  saveFolder: 'Ghost Recordings',
  template: 'general',
  email: '',
  emailVia: 'gmail',
  autoEmail: false,
  videoEnabled: true,
  autoSuggest: true,
  consentNote: true,
};
const PROVIDER_NAMES = { gemini: 'Gemini', groq: 'Groq', openrouter: 'OpenRouter', custom: 'Custom' };
const PROVIDER_INFO = {
  gemini: { key: 'Get a free key at <a href="https://aistudio.google.com/apikey" target="_blank">aistudio.google.com/apikey</a>', model: 'e.g. gemini-3.1-flash-lite (default — free & generous) · gemini-2.5-flash · gemini-2.5-pro' },
  groq: { key: 'Get a free key at <a href="https://console.groq.com/keys" target="_blank">console.groq.com/keys</a>', model: 'e.g. llama-3.3-70b-versatile · openai/gpt-oss-120b' },
  openrouter: { key: 'Get a key at <a href="https://openrouter.ai/keys" target="_blank">openrouter.ai/keys</a>', model: 'any OpenRouter id, e.g. google/gemini-2.5-flash · openai/gpt-4o-mini' },
  custom: { key: 'Your OpenAI-compatible endpoint key.', model: 'the model id your endpoint expects' },
};
const $ = (id) => document.getElementById(id);
let state = JSON.parse(JSON.stringify(DEFAULTS));

// Well-known model ids offered alongside whatever the user has used before.
const MODEL_SUGGESTIONS = {
  gemini: ['gemini-3.1-flash-lite', 'gemini-3.1-flash', 'gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-2.5-pro'],
  groq: ['llama-3.3-70b-versatile', 'openai/gpt-oss-120b', 'llama-3.1-8b-instant'],
  openrouter: ['google/gemini-2.5-flash', 'google/gemini-3.1-flash-lite', 'openai/gpt-4o-mini'],
  custom: [],
};

function applyProviderView() {
  const p = $('provider').value;
  $('baseUrlField').classList.toggle('hidden', p !== 'custom');
  $('keyHint').innerHTML = PROVIDER_INFO[p].key;
  $('modelHint').textContent = PROVIDER_INFO[p].model;
  $('apiKey').value = state.keys[p] || '';
  $('model').value = state.models[p] || DEFAULTS.models[p] || '';
  $('baseUrl').value = state.customBaseUrl || '';
  // Model picker: previously-used models (remembered) first, then known ids.
  const dl = $('modelList');
  if (dl) {
    const hist = (state.modelHistory && state.modelHistory[p]) || [];
    const opts = hist.concat(MODEL_SUGGESTIONS[p].filter((x) => !hist.includes(x)));
    dl.innerHTML = opts.map((x) => `<option value="${x}">`).join('');
  }
}

function load() {
  // template list from templates.js
  const sel = $('template');
  self.GhostTemplates.list.forEach((t) => { const o = document.createElement('option'); o.value = t.id; o.textContent = t.label; sel.appendChild(o); });
  chrome.storage.local.get('settings', ({ settings }) => {
    const s = settings || {};
    state = Object.assign({}, DEFAULTS, s, {
      keys: Object.assign({}, DEFAULTS.keys, s.keys || {}),
      models: Object.assign({}, DEFAULTS.models, s.models || {}),
      modelHistory: Object.assign({}, DEFAULTS.modelHistory, s.modelHistory || {}),
    });
    $('provider').value = state.provider;
    $('template').value = state.template;
    $('email').value = state.email;
    $('saveFolder').value = state.saveFolder || 'Ghost Recordings';
    $('emailVia').value = state.emailVia || 'gmail';
    $('videoEnabled').checked = !!state.videoEnabled;
    $('autoSuggest').checked = state.autoSuggest !== false;
    $('autoEmail').checked = !!state.autoEmail;
    $('consentNote').checked = state.consentNote !== false;
    applyProviderView();
    renderConfigured();
  });
}

function renderConfigured() {
  const have = Object.keys(PROVIDER_NAMES).filter((k) => (state.keys[k] || '').trim());
  $('configuredHint').textContent = have.length ? 'Saved keys: ' + have.map((k) => PROVIDER_NAMES[k] + ' ✓').join(', ') : 'No keys saved yet.';
}

$('revealBtn').addEventListener('click', () => { const i = $('apiKey'); i.type = i.type === 'password' ? 'text' : 'password'; });

$('testBtn').addEventListener('click', async () => {
  const p = $('provider').value, key = $('apiKey').value.trim(), base = $('baseUrl').value.trim(), r = $('testResult');
  r.textContent = 'Testing…'; r.style.color = '#94a3b8';
  if (!key) { r.textContent = '✗ Enter a key first'; r.style.color = '#fca5a5'; return; }
  let url, headers;
  if (p === 'gemini') { url = 'https://generativelanguage.googleapis.com/v1beta/models'; headers = { 'x-goog-api-key': key }; }
  else if (p === 'groq') { url = 'https://api.groq.com/openai/v1/models'; headers = { Authorization: 'Bearer ' + key }; }
  else if (p === 'openrouter') { url = 'https://openrouter.ai/api/v1/models'; headers = { Authorization: 'Bearer ' + key }; }
  else { if (!base) { r.textContent = '✗ Enter a Base URL'; r.style.color = '#fca5a5'; return; } url = base.replace(/\/$/, '') + '/models'; headers = { Authorization: 'Bearer ' + key }; }
  try {
    const resp = await fetch(url, { headers });
    if (resp.ok) { save(); r.textContent = '✓ Key works — saved'; r.style.color = '#34d399'; }
    else { r.textContent = '✗ ' + resp.status + ' — key rejected'; r.style.color = '#fca5a5'; }
  } catch (e) { r.textContent = '✗ ' + e.message; r.style.color = '#fca5a5'; }
});

$('provider').addEventListener('change', () => {
  // stash current field edits before switching
  const prev = state.provider; state.keys[prev] = $('apiKey').value.trim(); state.models[prev] = $('model').value.trim(); state.customBaseUrl = $('baseUrl').value.trim();
  state.provider = $('provider').value; applyProviderView();
});

function save() {
  const p = $('provider').value;
  state.provider = p;
  state.keys[p] = $('apiKey').value.trim();
  state.models[p] = $('model').value.trim() || DEFAULTS.models[p];
  // Remember every model the user has saved, so it's one click to reuse later.
  if (!state.modelHistory) state.modelHistory = { gemini: [], groq: [], openrouter: [], custom: [] };
  const mh = state.modelHistory[p] || (state.modelHistory[p] = []);
  if (state.models[p] && !mh.includes(state.models[p])) { mh.unshift(state.models[p]); if (mh.length > 10) mh.pop(); }
  state.customBaseUrl = $('baseUrl').value.trim();
  state.template = $('template').value;
  state.email = $('email').value.trim();
  state.saveFolder = $('saveFolder').value.trim() || 'Ghost Recordings';
  state.emailVia = $('emailVia').value;
  state.videoEnabled = $('videoEnabled').checked;
  state.autoSuggest = $('autoSuggest').checked;
  state.autoEmail = $('autoEmail').checked;
  state.consentNote = $('consentNote').checked;
  chrome.storage.local.set({ settings: state }, () => { const t = $('saved'); t.classList.add('show'); setTimeout(() => t.classList.remove('show'), 1500); renderConfigured(); });
}
$('save').addEventListener('click', save);

// ---- meeting-history backup: move meetings between installs -----------------
$('exportBtn').addEventListener('click', () => {
  chrome.storage.local.get('meetings', ({ meetings }) => {
    const payload = { app: 'ghost-recorder', kind: 'meeting-history', exported: new Date().toISOString(), meetings: meetings || [] };
    const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 1)], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url; a.download = 'ghost-recorder-meetings.json'; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    $('backupMsg').textContent = '✓ Exported ' + (meetings || []).length + ' meetings to your Downloads.';
  });
});
$('importBtn').addEventListener('click', () => $('importFile').click());
$('importFile').addEventListener('change', () => {
  const f = $('importFile').files[0];
  if (!f) return;
  const rd = new FileReader();
  rd.onload = () => {
    try {
      const data = JSON.parse(rd.result);
      const incoming = Array.isArray(data) ? data : (data.meetings || []);
      if (!incoming.length) { $('backupMsg').textContent = '✗ No meetings found in that file.'; return; }
      chrome.storage.local.get('meetings', ({ meetings }) => {
        const cur = meetings || [];
        const have = new Set(cur.map((m) => m.id));
        const added = incoming.filter((m) => m && m.id && !have.has(m.id));
        const merged = cur.concat(added).sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));
        chrome.storage.local.set({ meetings: merged }, () => {
          $('backupMsg').textContent = `✓ Imported ${added.length} new meetings (${incoming.length - added.length} were already here).`;
        });
      });
    } catch (e) { $('backupMsg').textContent = '✗ Could not read that file: ' + e.message; }
  };
  rd.readAsText(f);
  $('importFile').value = '';
});

$('micBtn').addEventListener('click', async () => {
  $('micMsg').textContent = 'Requesting…'; $('micMsg').style.color = '#94a3b8';
  try { const s = await navigator.mediaDevices.getUserMedia({ audio: true }); s.getTracks().forEach((t) => t.stop()); $('micMsg').textContent = '✓ Microphone enabled — your voice will be recorded.'; $('micMsg').style.color = '#34d399'; }
  catch (e) { $('micMsg').textContent = '✗ Mic blocked: ' + e.message + '. Recordings will capture remote audio only.'; $('micMsg').style.color = '#fca5a5'; }
});

document.addEventListener('DOMContentLoaded', load);
