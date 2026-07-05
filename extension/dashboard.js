// Ghost Recorder — Meetings app (Fathom-style): history + search, built-in player,
// SUMMARY / TRANSCRIPT / ASK-AI tabs, note regeneration. Recordings play from
// IndexedDB (written by the recorder), so playback works even if Downloads failed.

let meetings = [];
let selectedId = null;
let mediaUrl = null;       // active blob: URL (revoked on selection change)
let currentTab = 'summary';
let searchQ = '';
const chats = {};          // chat history per scope key (meeting id or '::all')
let askBusy = false;

// ---- IndexedDB (shared with offscreen.js: db "ghost", store "pending") ----
function idb() { return new Promise((res, rej) => { const r = indexedDB.open('ghost', 1); r.onupgradeneeded = () => r.result.createObjectStore('pending', { keyPath: 'id' }); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); }
async function idbGet(id) { const db = await idb(); return new Promise((res) => { const rq = db.transaction('pending', 'readonly').objectStore('pending').get(id); rq.onsuccess = () => res(rq.result); rq.onerror = () => res(null); }); }
async function idbPut(v) { const db = await idb(); return new Promise((res, rej) => { const tx = db.transaction('pending', 'readwrite'); tx.objectStore('pending').put(v); tx.oncomplete = res; tx.onerror = () => rej(tx.error); }); }

function load() {
  chrome.storage.local.get('meetings', ({ meetings: m }) => {
    meetings = m || [];
    if (!selectedId && meetings.length) selectedId = meetings[0].id;
    render();
  });
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Minimal markdown renderer (headings, bold, bullets, numbered, links, pipe tables).
function renderMarkdown(md) {
  const lines = (md || '').split('\n');
  let html = '', i = 0;
  const inline = (t) => esc(t)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|\s)_([^_]+)_(?=\s|[.,;:!?]|$)/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  while (i < lines.length) {
    const line = lines[i];
    if (/^>\s?/.test(line)) {
      let q = '';
      while (i < lines.length && /^>\s?/.test(lines[i])) { q += (q ? '<br>' : '') + inline(lines[i].replace(/^>\s?/, '')); i++; }
      html += `<blockquote>${q}</blockquote>`; continue;
    }
    if (/^###\s+/.test(line)) { html += `<h3>${inline(line.replace(/^###\s+/, ''))}</h3>`; i++; continue; }
    if (/^##\s+/.test(line)) { html += `<h2>${inline(line.replace(/^##\s+/, ''))}</h2>`; i++; continue; }
    if (/^#\s+/.test(line)) { html += `<h2>${inline(line.replace(/^#\s+/, ''))}</h2>`; i++; continue; }
    if (/^\s*\|.*\|\s*$/.test(line)) {
      const rows = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) { rows.push(lines[i]); i++; }
      const cells = (r) => r.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
      let t = '<table>';
      rows.forEach((r, ri) => {
        if (/^\s*\|[\s:|-]+\|\s*$/.test(r)) return;
        const tag = ri === 0 ? 'th' : 'td';
        t += '<tr>' + cells(r).map((c) => `<${tag}>${inline(c)}</${tag}>`).join('') + '</tr>';
      });
      html += t + '</table>';
      continue;
    }
    if (/^\s*\d+\.\s+/.test(line)) {
      let li = '';
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) { li += `<li>${inline(lines[i].replace(/^\s*\d+\.\s+/, ''))}</li>`; i++; }
      html += `<ol>${li}</ol>`; continue;
    }
    if (/^\s*[-*]\s+/.test(line)) {
      let li = '';
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) { li += `<li>${inline(lines[i].replace(/^\s*[-*]\s+/, ''))}</li>`; i++; }
      html += `<ul>${li}</ul>`; continue;
    }
    if (line.trim() === '') { i++; continue; }
    html += `<p>${inline(line)}</p>`;
    i++;
  }
  return html;
}

// ---- transcript helpers ----
const TS_RE = /^\s*(?:\*\*)?\[?(\d{1,2}):(\d{2})(?::(\d{2}))?\]?(?:\*\*)?\s*(?:(?:\*\*)?([^:*]{1,40}?)(?:\*\*)?\s*:)?\s*(.*)$/;
function splitNotes(notes) {
  const parts = (notes || '').split(/(?=##\s*Full Transcript)/i);
  return { summary: parts[0] || '', transcript: parts.slice(1).join('').replace(/^##\s*Full Transcript\s*/i, '').trim() };
}
function renderTranscript(text) {
  return (text || '').split('\n').map((line) => {
    if (!line.trim()) return '';
    const m = TS_RE.exec(line);
    if (m && (m[4] || m[5])) {
      const secs = m[3] != null ? (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]) : (+m[1]) * 60 + (+m[2]);
      const stamp = m[3] != null ? `${m[1]}:${m[2]}:${m[3]}` : `${m[1]}:${m[2]}`;
      return `<div class="tl" data-t="${secs}" title="Jump to ${stamp}"><span class="tstamp">${stamp}</span>${m[4] ? `<span class="spk">${esc(m[4].trim())}</span>` : ''}<span class="ttext">${esc(m[5] || '')}</span></div>`;
    }
    return `<div class="tl plain">${esc(line)}</div>`;
  }).join('');
}
function attendeesOf(notes) {
  const { transcript } = splitNotes(notes);
  const names = new Set();
  transcript.split('\n').forEach((l) => { const m = TS_RE.exec(l); if (m && m[4]) names.add(m[4].trim().replace(/\*\*/g, '')); });
  return [...names].slice(0, 12);
}

function badge(state) {
  const s = state || 'unknown';
  const label = { recording: 'RECORDING', processing: 'PROCESSING…', done: 'READY', error: 'FAILED' }[s] || s.toUpperCase();
  return `<span class="tag tag-${s}">${label}</span>`;
}
function localDate(iso) {
  try { return new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' }); }
  catch (e) { return (iso || '').replace('T', ' ').slice(0, 16); }
}
function friendlyError(err) {
  const e = String(err || 'AI processing failed.');
  let fix = '';
  if (/RECOVERED/i.test(e)) fix = '';
  else if (/401|403|API key|unauthorized|invalid.*key|permission/i.test(e)) fix = 'Your API key was rejected — open Settings, re-paste the key and press Test.';
  else if (/429|rate|quota|overloaded|exhausted/i.test(e)) fix = 'The AI provider is busy or rate-limited — wait a minute, then press Retry.';
  else if (/413|too large|exceed|payload/i.test(e)) fix = 'The recording is too large for this provider — switch to Gemini in Settings, then Retry.';
  else if (/network|fetch|failed to fetch|timeout/i.test(e)) fix = 'Network problem reaching the AI provider — check your connection, then Retry.';
  return { fix, raw: e };
}

// =============================================================== render
function render() {
  const list = document.getElementById('list');
  const visible = meetings.filter((m) => {
    if (!searchQ) return true;
    const q = searchQ.toLowerCase();
    return (m.title || '').toLowerCase().includes(q) || (m.notes || '').toLowerCase().includes(q) || (m.platform || '').toLowerCase().includes(q);
  });
  if (!meetings.length) {
    list.innerHTML = '<div class="empty">No meetings yet.<br>Join a meeting and press Record — everything shows up here.</div>';
    document.getElementById('detail').innerHTML = '<div class="empty">Your meetings, recordings and AI notes will live here.</div>';
    return;
  }
  list.innerHTML = (visible.length ? visible : []).map((m) => `
    <div class="item ${m.id === selectedId ? 'sel' : ''}" data-id="${esc(m.id)}">
      ${m.thumb ? `<img class="thumb" src="${m.thumb}" alt="">` : ''}
      <div class="t">${esc(m.title || m.id)}</div>
      <div class="d">${esc(localDate(m.date))}${m.duration && m.duration !== 'Unknown' ? ' · ' + esc(m.duration) : ''}</div>
      ${badge(m.state)}
    </div>`).join('') || '<div class="empty">No meetings match your search.</div>';
  list.querySelectorAll('.item').forEach((el) => el.onclick = () => { selectedId = el.dataset.id; currentTab = 'summary'; render(); });

  const m = meetings.find((x) => x.id === selectedId);
  const detail = document.getElementById('detail');
  detail.classList.toggle('fixed', !live && !!m); // meeting view: only #tabc scrolls
  if (live) { renderLive(detail); return; }   // in-person recording owns the screen
  if (!m) { renderHome(detail); return; }

  const metaLine = [localDate(m.date), m.duration && m.duration !== 'Unknown' ? m.duration : '', m.platform || '', m.model ? `notes by ${m.model}` : '']
    .filter(Boolean).join(' · ');
  detail.innerHTML = `
    <div class="mv-left">
      <h2 class="title">${esc(m.title || m.id)} ${badge(m.state)}
        <button class="btn ghost mini" id="renameBtn" title="Rename">✎</button>
        <button class="btn ghost mini" id="deleteBtn" title="Delete from this list">🗑</button></h2>
      <div class="muted" style="margin:-4px 0 12px">${esc(metaLine)}</div>
      <div id="player"></div>
    </div>
    <div class="mv-right">
      <div class="tabs">
        <button class="tab ${currentTab === 'summary' ? 'on' : ''}" data-tab="summary">SUMMARY</button>
        <button class="tab ${currentTab === 'transcript' ? 'on' : ''}" data-tab="transcript">TRANSCRIPT</button>
        <button class="tab ${currentTab === 'ask' ? 'on' : ''}" data-tab="ask">✨ ASK AI</button>
      </div>
      <div id="tabc" class="${currentTab === 'ask' ? 'askpane' : ''}"></div>
    </div>`;
  detail.querySelectorAll('.tab').forEach((b) => b.onclick = () => { currentTab = b.dataset.tab; render(); });
  document.getElementById('renameBtn').onclick = () => {
    const t = prompt('Meeting name:', m.title || '');
    if (t && t.trim()) chrome.runtime.sendMessage({ action: 'RENAME_MEETING', meetingId: m.id, title: t.trim() });
  };
  document.getElementById('deleteBtn').onclick = () => {
    if (confirm('Remove this meeting from the list?\n(Files already saved in Downloads are kept.)')) {
      chrome.runtime.sendMessage({ action: 'DELETE_MEETING', meetingId: m.id });
      selectedId = null;
    }
  };

  renderTab(m);
  attachMedia(m);
}

// Home view: quick stats + in-person recorder + Ask AI across ALL meetings.
function renderHome(detail) {
  const done = meetings.filter((x) => x.state === 'done').length;
  const week = meetings.filter((x) => Date.now() - new Date(x.date).getTime() < 7 * 864e5).length;
  detail.innerHTML = `
    <h2 class="title">🏠 Home</h2>
    <div class="homegrid">
      <div class="stat"><div class="n">${meetings.length}</div><div class="l">meetings recorded</div></div>
      <div class="stat"><div class="n">${done}</div><div class="l">with AI notes</div></div>
      <div class="stat"><div class="n">${week}</div><div class="l">in the last 7 days</div></div>
    </div>
    <div class="livecard">
      <div>
        <div style="font-weight:700">🎙 In-person meeting</div>
        <div class="muted" style="margin-top:3px">Record the room through your mic — live transcript while you talk, AI notes at the end. No setup.</div>
      </div>
      <button class="btn" id="offlineBtn" style="background:#dc2626">● Start recording</button>
    </div>
    <h2 class="title" style="font-size:1rem;margin-top:18px">✨ Ask AI — across all your meetings</h2>
    <div id="tabc"></div>`;
  document.getElementById('offlineBtn').onclick = startOffline;
  chats.scope = 'all';
  renderAsk(null, document.getElementById('tabc'));
}

// =================== In-person recorder (Notion/Meetily-style, mic + live transcript)
let live = null; // { rec, chunks, stream, recog, startMs, pausedAt, totalPaused, lines, timer }

const liveMMSS = () => { const s = Math.max(0, Math.floor((Date.now() - live.startMs - live.totalPaused) / 1000)); return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0'); };

// Live-transcript languages (Chrome's speech engine does ONE at a time; the final
// AI transcript is language-agnostic regardless — Gemini/Whisper auto-detect).
const LIVE_LANGS = [
  ['auto', 'Auto (browser language)'], ['en-IN', 'English (India / Hinglish)'], ['en-US', 'English (US)'], ['en-GB', 'English (UK)'],
  ['hi-IN', 'हिन्दी Hindi'], ['es-ES', 'Español'], ['fr-FR', 'Français'], ['de-DE', 'Deutsch'], ['pt-BR', 'Português'],
  ['ar-SA', 'العربية Arabic'], ['id-ID', 'Bahasa Indonesia'], ['ja-JP', '日本語 Japanese'], ['ko-KR', '한국어 Korean'],
  ['zh-CN', '中文 Chinese'], ['ru-RU', 'Русский Russian'], ['it-IT', 'Italiano'], ['nl-NL', 'Nederlands'], ['tr-TR', 'Türkçe'],
];

async function startOffline() {
  if (live) return;
  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia({ audio: { noiseSuppression: true, autoGainControl: true, echoCancellation: false } }); }
  catch (e) { alert('Microphone is blocked. Open ⚙ Settings and click "🎤 Enable mic" once, then try again.'); return; }
  const { settings } = await chrome.storage.local.get('settings');
  const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/webm';
  const rec = new MediaRecorder(stream, { mimeType: mime, audioBitsPerSecond: 64000 });
  live = { rec, chunks: [], stream, recog: null, startMs: Date.now(), pausedAt: 0, totalPaused: 0, lines: [], timer: null, lang: (settings && settings.liveLang) || 'auto' };
  rec.ondataavailable = (e) => { if (e.data && e.data.size) live.chunks.push(e.data); };
  rec.start(5000);
  startLiveRecog();
  render();
}

// Chrome's built-in speech engine = live transcript with zero keys/setup.
function startLiveRecog() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) { live.noSR = true; return; }
  const r = new SR();
  r.continuous = true; r.interimResults = true;
  r.lang = (live.lang && live.lang !== 'auto') ? live.lang : (navigator.language || 'en-US');
  r.onresult = (e) => {
    let interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const t = e.results[i][0].transcript.trim();
      if (!t) continue;
      if (e.results[i].isFinal) { live.lines.push(`[${liveMMSS()}] ${t}`); }
      else interim = t;
    }
    updateLiveUI(interim);
  };
  r.onend = () => { if (live && !live.pausedAt) { try { r.start(); } catch (e) { /* */ } } }; // auto-restart on silence
  r.onerror = () => {};
  try { r.start(); live.recog = r; } catch (e) { live.noSR = true; }
}

function updateLiveUI(interim) {
  const box = document.getElementById('liveTr');
  if (!box) return;
  box.innerHTML = live.lines.slice(-40).map((l) => `<div class="tl plain" style="color:#cbd5e1">${esc(l)}</div>`).join('')
    + (interim ? `<div class="tl plain" style="opacity:.5">${esc(interim)}…</div>` : '');
  box.scrollTop = box.scrollHeight;
}

function renderLive(detail) {
  detail.innerHTML = `
    <h2 class="title"><span style="color:#ef4444">●</span> Recording in-person meeting <span class="muted" id="liveTm" style="font-variant-numeric:tabular-nums">00:00</span></h2>
    <div class="muted" style="margin:-4px 0 12px">Keep this tab open. ${live.noSR ? 'Live transcript unavailable in this browser — audio is recorded and AI transcribes it at the end.' : 'Live transcript below — AI writes the polished notes when you stop.'}</div>
    <div class="actions">
      <button class="btn ghost" id="livePause">${live.pausedAt ? '▶ Resume' : '⏸ Pause'}</button>
      <button class="btn" id="liveStop" style="background:#dc2626">■ Stop &amp; get notes</button>
      <select id="liveLang" title="Live transcript language (final AI notes auto-detect any language)" style="background:var(--panel2);color:var(--text);border:1px solid var(--line);border-radius:8px;padding:8px 10px;font-size:.8rem">
        ${LIVE_LANGS.map(([v, l]) => `<option value="${v}" ${v === live.lang ? 'selected' : ''}>${esc(l)}</option>`).join('')}
      </select>
    </div>
    <div class="transcript" id="liveTr" style="min-height:200px;max-height:52vh;overflow-y:auto"><div class="tl plain">Listening…</div></div>`;
  updateLiveUI('');
  if (live.timer) clearInterval(live.timer);
  live.timer = setInterval(() => { const el = document.getElementById('liveTm'); if (el && !live.pausedAt) el.textContent = liveMMSS(); }, 1000);
  document.getElementById('livePause').onclick = () => {
    if (live.pausedAt) { live.totalPaused += Date.now() - live.pausedAt; live.pausedAt = 0; try { live.rec.resume(); } catch (e) { /* */ } startLiveRecog(); }
    else { live.pausedAt = Date.now(); try { live.rec.pause(); } catch (e) { /* */ } if (live.recog) { const r = live.recog; live.recog = null; try { r.stop(); } catch (e) { /* */ } } }
    render();
  };
  document.getElementById('liveStop').onclick = stopOffline;
  document.getElementById('liveLang').onchange = (e) => {
    live.lang = e.target.value;
    chrome.storage.local.get('settings', ({ settings }) => chrome.storage.local.set({ settings: Object.assign({}, settings || {}, { liveLang: live.lang }) }));
    if (live.recog) { const r = live.recog; live.recog = null; try { r.stop(); } catch (err) { /* */ } } // kill (no auto-restart while null)
    live.noSR = false;
    startLiveRecog(); // fresh engine in the new language; recording itself never stops
  };
}

async function stopOffline() {
  const L = live; if (!L) return;
  if (L.pausedAt) { L.totalPaused += Date.now() - L.pausedAt; L.pausedAt = 0; }
  if (L.timer) clearInterval(L.timer);
  if (L.recog) { const r = L.recog; L.recog = null; try { r.stop(); } catch (e) { /* */ } }
  await new Promise((res) => { L.rec.onstop = res; try { L.rec.stop(); } catch (e) { res(); } });
  L.stream.getTracks().forEach((t) => t.stop());
  live = null;
  const blob = new Blob(L.chunks, { type: 'audio/webm' });
  if (!blob.size) { alert('Nothing was recorded.'); render(); return; }
  const id = new Date().toISOString().replace(/[:.]/g, '-');
  const secs = Math.floor((Date.now() - L.startMs - L.totalPaused) / 1000);
  const duration = `${Math.floor(secs / 60)}m ${secs % 60}s`;
  const captions = L.lines.join('\n');
  await idbPut({ id, audio: blob, video: null, captions, settings: null, meta: { date: new Date().toLocaleString(), platform: 'In-person', duration } });
  chrome.runtime.sendMessage({ action: 'OFFLINE_MEETING', meetingId: id, duration }, () => {
    const url = URL.createObjectURL(blob);
    chrome.runtime.sendMessage({ action: 'SAVE_FILE', meetingId: id, kind: 'audio', url });
    setTimeout(() => URL.revokeObjectURL(url), 180000);
    chrome.runtime.sendMessage({ action: 'RETRY_NOTES', meetingId: id });
    selectedId = id; currentTab = 'summary';
    render();
  });
}

function renderTab(m) {
  const tabc = document.getElementById('tabc');
  if (currentTab === 'summary') renderSummary(m, tabc);
  else if (currentTab === 'transcript') renderTranscriptTab(m, tabc);
  else renderAsk(m, tabc);
  // click-to-seek works from any tab that shows transcript lines
  tabc.addEventListener('click', (e) => {
    const row = e.target.closest('.tl'); if (!row || row.dataset.t == null) return;
    const media = document.getElementById('media'); if (!media) return;
    media.currentTime = Number(row.dataset.t);
    media.play().catch(() => {});
    tabc.querySelectorAll('.tl.on').forEach((x) => x.classList.remove('on')); row.classList.add('on');
  });
}

function renderSummary(m, tabc) {
  const f = m.files || {};
  const { summary } = splitNotes(m.notes);
  let warn = (m.warnings && m.warnings.length) ? `<div class="err warnbox">⚠ ${m.warnings.map(esc).join('<br>⚠ ')}</div>` : '';
  if (m.saveError) warn += `<div class="err warnbox">⚠ ${esc(m.saveError)}</div>`;
  const att = m.notes ? attendeesOf(m.notes) : [];

  let body;
  if (m.state === 'done' && m.notes) body = `<div class="notes">${renderMarkdown(summary)}</div>`;
  else if (m.state === 'error') { const fe = friendlyError(m.error); body = `<div class="err">${fe.fix ? `<strong>${esc(fe.fix)}</strong>\n\n` : ''}${esc(fe.raw)}</div>`; }
  else if (m.state === 'processing') body = `<p class="muted"><span class="spin"></span> Transcribing & writing notes with AI — usually under a minute. This page updates by itself.</p>`;
  else if (m.state === 'recording') body = `<p class="muted"><span class="spin"></span> Recording in progress…</p>`;
  else body = `<p class="muted">No notes.</p>`;

  // Everything lives INSIDE this app: player above, notes here, transcript tab,
  // Ask tab. The only file-system touchpoint left is "Show in folder".
  tabc.innerHTML = `
    ${att.length ? `<div class="attend">${att.map((a) => `<span class="chip">${esc(a)}</span>`).join('')}</div>` : ''}
    <div class="actions">
      ${m.notes ? `<button class="btn ghost" id="copySum">📄 Copy summary</button>` : ''}
      ${m.notes ? `<button class="btn" id="emailBtn">📧 Email notes</button>` : ''}
      ${f.video || f.audio || f.notes ? `<button class="btn ghost" id="showBtn">📁 Show files in folder</button>` : ''}
      ${m.state === 'error' ? `<button class="btn retry" id="retryBtn">↻ Retry AI</button>` : ''}
    </div>
    <div id="regen"></div>
    ${warn}${body}`;

  const showBtn = document.getElementById('showBtn');
  if (showBtn) showBtn.onclick = () => { const any = f.notes || f.video || f.audio; if (any) chrome.downloads.show(any.downloadId); };
  const emailBtn = document.getElementById('emailBtn');
  if (emailBtn) emailBtn.onclick = () => chrome.runtime.sendMessage({ action: 'EMAIL_NOTES', meetingId: m.id }, (r) => {
    if (r && r.error === 'no-email') { emailBtn.textContent = 'Add your email in Settings first'; setTimeout(() => { emailBtn.textContent = '📧 Email notes'; }, 3000); }
  });
  const retryBtn = document.getElementById('retryBtn');
  if (retryBtn) retryBtn.onclick = () => { retryBtn.disabled = true; retryBtn.textContent = 'Retrying…'; chrome.runtime.sendMessage({ action: 'RETRY_NOTES', meetingId: m.id }); };
  const copySum = document.getElementById('copySum');
  if (copySum) copySum.onclick = () => { navigator.clipboard.writeText(splitNotes(m.notes).summary).then(() => { copySum.textContent = '✓ Copied'; setTimeout(() => { copySum.textContent = '📄 Copy summary'; }, 1600); }); };
}

function renderTranscriptTab(m, tabc) {
  const { transcript } = splitNotes(m.notes);
  if (!transcript) { tabc.innerHTML = '<p class="muted">No transcript yet' + (m.state === 'processing' ? ' — AI is still working.' : '.') + '</p>'; return; }
  tabc.innerHTML = `
    <div class="actions">
      <button class="btn ghost" id="copyTr">📄 Copy transcript</button>
      <span class="muted" style="align-self:center;font-size:.75rem">Click any line to jump the player</span>
    </div>
    <div class="transcript tall" id="transcript">${renderTranscript(transcript)}</div>`;
  document.getElementById('copyTr').onclick = () => { navigator.clipboard.writeText(transcript).then(() => { const b = document.getElementById('copyTr'); b.textContent = '✓ Copied'; setTimeout(() => { b.textContent = '📄 Copy transcript'; }, 1600); }); };
}

// ---- Ask AI (Fathom-style) ----
const CHIPS = {
  meeting: ['Summarize this meeting', 'Extract all action items', 'What questions were asked?', 'What did I commit to?'],
  all: ['Summarize my recent meetings', 'Things I promised to do', 'What decisions were made this week?', 'Surprise me with an insight'],
};
function askContext(scope, m) {
  if (scope === 'meeting' && m && m.notes) {
    return `Meeting: "${m.title}" — ${localDate(m.date)}${m.duration ? ' · ' + m.duration : ''} · ${m.platform || ''}\n\n${m.notes}`.slice(0, 120000);
  }
  let out = '';
  for (const x of meetings) {
    if (!x.notes) continue;
    const chunk = `\n\n===== Meeting: "${x.title}" — ${localDate(x.date)}${x.duration ? ' · ' + x.duration : ''} =====\n${splitNotes(x.notes).summary}`;
    if (out.length + chunk.length > 100000) break;
    out += chunk;
  }
  return out || 'No meeting notes exist yet.';
}
function renderAsk(m, tabc) {
  const scope = (chats.scope === 'all' || !m || !m.notes) ? 'all' : (chats.scope || 'meeting');
  chats.scope = scope;
  const key = scope === 'all' ? '::all' : m.id;
  const hist = chats[key] || (chats[key] = []);
  tabc.innerHTML = `
    <div class="askhead">
      <span class="muted">Ask about:</span>
      <button class="btn ghost mini ${scope === 'meeting' ? 'selbtn' : ''}" id="scM" ${!m || !m.notes ? 'disabled' : ''}>This meeting</button>
      <button class="btn ghost mini ${scope === 'all' ? 'selbtn' : ''}" id="scA">All meetings</button>
    </div>
    <div class="chat" id="chat">
      ${hist.length ? hist.map((h) => `<div class="msg ${h.role}">${h.role === 'user' ? esc(h.text) : renderMarkdown(h.text)}</div>`).join('')
      : `<div class="empty" style="margin:30px 0">Hi — what can I tell you about ${scope === 'all' ? 'your meetings' : 'this meeting'}?</div>`}
      ${askBusy ? '<div class="msg ai"><span class="spin"></span> Thinking…</div>' : ''}
    </div>
    <div class="chips">${CHIPS[scope].map((c) => `<button class="chipbtn" data-q="${esc(c)}">${esc(c)}</button>`).join('')}</div>
    <div class="askrow">
      <input id="askIn" placeholder="Ask anything…" ${askBusy ? 'disabled' : ''}>
      <button class="btn" id="askGo" ${askBusy ? 'disabled' : ''}>↑</button>
    </div>`;
  const chatEl = document.getElementById('chat');
  chatEl.scrollTop = chatEl.scrollHeight;
  document.getElementById('scM').onclick = () => { chats.scope = 'meeting'; render(); };
  document.getElementById('scA').onclick = () => { chats.scope = 'all'; render(); };
  const go = (q) => { if (q && q.trim() && !askBusy) sendAsk(q.trim(), key, scope, m); };
  tabc.querySelectorAll('.chipbtn').forEach((b) => b.onclick = () => go(b.dataset.q));
  const input = document.getElementById('askIn');
  input.onkeydown = (e) => { if (e.key === 'Enter') go(input.value); };
  document.getElementById('askGo').onclick = () => go(input.value);
  if (!askBusy) input.focus();
}
async function sendAsk(q, key, scope, m) {
  const hist = chats[key];
  hist.push({ role: 'user', text: q });
  askBusy = true; render();
  try {
    const answer = await self.GhostAsk.ask(q, hist.slice(0, -1).slice(-8), askContext(scope, m));
    hist.push({ role: 'ai', text: answer });
  } catch (e) {
    hist.push({ role: 'ai', text: '⚠ ' + e.message });
  }
  askBusy = false;
  if (currentTab === 'ask' || !selectedId) render();
}

// ---- built-in player + regenerate (uses the IndexedDB copy of the recording) ----
async function attachMedia(m) {
  const rec = await idbGet(m.id);
  if (rec && rec.video && !m.thumb && m.state === 'done') makeThumb(m.id, rec.video);
  if (selectedId !== m.id) return; // stale render
  const holder = document.getElementById('player');
  if (holder && rec && (rec.video || rec.audio)) {
    if (mediaUrl) { URL.revokeObjectURL(mediaUrl); mediaUrl = null; }
    const blob = rec.video || rec.audio;
    mediaUrl = URL.createObjectURL(blob);
    const tag = rec.video ? 'video' : 'audio';
    holder.innerHTML = `
      <${tag} id="media" src="${mediaUrl}" controls preload="metadata" ${tag === 'video' ? 'class="vid"' : 'style="width:100%"'}></${tag}>
      <div class="speed">Speed:
        ${[1, 1.25, 1.5, 2].map((s) => `<button class="btn ghost mini spd ${s === 1 ? 'on' : ''}" data-s="${s}">${s}×</button>`).join('')}
      </div>`;
    const media = document.getElementById('media');
    holder.querySelectorAll('.spd').forEach((b) => b.onclick = () => {
      media.playbackRate = Number(b.dataset.s);
      holder.querySelectorAll('.spd').forEach((x) => x.classList.toggle('on', x === b));
    });
  } else if (holder && (m.files && (m.files.video || m.files.audio))) {
    holder.innerHTML = `<div class="muted" style="padding:8px 0 4px;font-size:.78rem">▶ Inline playback covers the 12 most recent recordings — this older one only has its files in Downloads ("📁 Show files in folder").</div>`;
  }
  // regenerate panel (Summary tab only)
  const regen = document.getElementById('regen');
  if (regen && rec && rec.audio && m.state !== 'processing' && m.state !== 'recording') {
    const opts = (self.GhostTemplates ? self.GhostTemplates.list : []).map((t) => `<option value="${t.id}">${esc(t.label)}</option>`).join('');
    regen.innerHTML = `<div class="regenbar">✨ New notes from this recording:
      <select id="regenTpl">${opts}</select>
      <button class="btn" id="regenBtn">Generate</button></div>`;
    document.getElementById('regenBtn').onclick = () => {
      const tpl = document.getElementById('regenTpl').value;
      chrome.runtime.sendMessage({ action: 'RETRY_NOTES', meetingId: m.id, template: tpl });
    };
  }
}

// live-update when the background writes new history/state
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.meetings) { meetings = changes.meetings.newValue || []; render(); }
});
document.addEventListener('DOMContentLoaded', () => {
  const s = document.getElementById('search');
  if (s) s.addEventListener('input', () => { searchQ = s.value.trim(); render(); });
  const goHome = (e) => { if (e) e.preventDefault(); selectedId = null; render(); };
  ['homeBtn', 'logoBtn', 'brandBtn'].forEach((id) => { const el = document.getElementById(id); if (el) el.onclick = goHome; });
  load();
});

// Video thumbnail for the meeting list (F8): grab one frame from the stored video.
function makeThumb(meetingId, blob) {
  try {
    const url = URL.createObjectURL(blob);
    const v = document.createElement('video');
    v.muted = true; v.preload = 'metadata'; v.src = url;
    const done = () => { URL.revokeObjectURL(url); v.remove(); };
    v.onloadedmetadata = () => { v.currentTime = Math.min(2, (v.duration || 2) / 2); };
    v.onseeked = () => {
      try {
        const c = document.createElement('canvas'); c.width = 192; c.height = 108;
        c.getContext('2d').drawImage(v, 0, 0, 192, 108);
        const thumb = c.toDataURL('image/jpeg', 0.6);
        if (thumb.length > 200) chrome.runtime.sendMessage({ action: 'SET_THUMB', meetingId, thumb });
      } catch (e) { /* canvas taint or decode issue — skip */ }
      done();
    };
    v.onerror = done;
  } catch (e) { /* */ }
}
