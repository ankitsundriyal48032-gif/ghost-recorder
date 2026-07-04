// Ghost Recorder — Service Worker (serverless, multi-provider, BYOK)

const SETTINGS_DEFAULTS = {
  provider: 'gemini', // gemini | groq | openrouter | custom
  keys: { gemini: '', groq: '', openrouter: '', custom: '' },
  models: { gemini: 'gemini-2.5-flash', groq: 'llama-3.3-70b-versatile', openrouter: 'google/gemini-2.5-flash', custom: '' },
  groqWhisper: 'whisper-large-v3-turbo',
  customBaseUrl: '',
  template: 'general',
  email: '',
  autoEmail: false,
  videoEnabled: true,
  autoSuggest: true,
};

let recordingState = { isRecording: false, tabId: null, meetingId: null, startTime: null, videoEnabled: true, platform: 'Unknown' };

chrome.storage.local.get(['isRecording', 'meetingId', 'tabId', 'startTime', 'videoEnabled', 'platform'], (s) => {
  if (s && s.isRecording && s.meetingId && !recordingState.meetingId) {
    recordingState = { isRecording: true, tabId: s.tabId ?? null, meetingId: s.meetingId, startTime: s.startTime ?? null, videoEnabled: s.videoEnabled ?? true, platform: s.platform || 'Unknown' };
  }
});

// First install -> open the settings page so the user adds their API key (BYOK).
chrome.runtime.onInstalled.addListener((d) => { if (d.reason === 'install') chrome.tabs.create({ url: chrome.runtime.getURL('options.html') }); });

// FAILSAFE: shortly after the browser/worker starts, ask the offscreen doc to
// recover any recording that was interrupted mid-meeting (live-* IDB snapshots).
async function kickRecovery() {
  try {
    const { isRecording } = await chrome.storage.local.get('isRecording');
    if (isRecording) return; // an active session owns the offscreen doc
    if (await ensureOffscreen()) chrome.runtime.sendMessage({ action: 'RECOVER', target: 'offscreen' }).catch(() => {});
  } catch (e) { /* */ }
}
chrome.runtime.onStartup.addListener(() => setTimeout(kickRecovery, 3000));
setTimeout(kickRecovery, 5000);

// --------------------------------------------------------------------------- helpers
function getSettings() {
  return new Promise((r) => chrome.storage.local.get('settings', ({ settings }) => {
    const s = settings || {};
    r(Object.assign({}, SETTINGS_DEFAULTS, s, {
      keys: Object.assign({}, SETTINGS_DEFAULTS.keys, s.keys || {}),
      models: Object.assign({}, SETTINGS_DEFAULTS.models, s.models || {}),
    }));
  }));
}
function providerKey(settings) {
  if (settings.provider === 'custom') return settings.keys.custom;
  return settings.keys[settings.provider] || '';
}
function getMeetings() { return new Promise((r) => chrome.storage.local.get('meetings', ({ meetings }) => r(meetings || []))); }

let storageChain = Promise.resolve();
function serialize(task) { const run = storageChain.then(task, task); storageChain = run.then(() => {}, () => {}); return run; }
function upsertMeeting(id, patch) {
  return serialize(async () => {
    const list = await getMeetings();
    let m = list.find((x) => x.id === id);
    if (!m) { m = { id, files: {} }; list.unshift(m); }
    const files = patch.files; const rest = Object.assign({}, patch); delete rest.files;
    Object.assign(m, rest);
    if (files) m.files = Object.assign(m.files || {}, files);
    await chrome.storage.local.set({ meetings: list.slice(0, 100) });
    return m;
  });
}
async function getMeeting(id) { return (await getMeetings()).find((x) => x.id === id); }

const capKey = (id) => 'cap_' + id;
function appendCaption(id, line) {
  return serialize(async () => {
    const key = capKey(id);
    const cur = (await chrome.storage.local.get(key))[key] || '';
    await chrome.storage.local.set({ [key]: cur + (line.endsWith('\n') ? line : line + '\n') });
  });
}
async function readCaptions(id) { return (await chrome.storage.local.get(capKey(id)))[capKey(id)] || ''; }
async function clearCaptions(id) { await chrome.storage.local.remove(capKey(id)); }

let restoreUiTimer = null;
function setDownloadUI(enabled) {
  try { if (chrome.downloads.setUiOptions) chrome.downloads.setUiOptions({ enabled }); } catch (e) { /* */ }
  try { if (chrome.downloads.setShelfEnabled) chrome.downloads.setShelfEnabled(enabled); } catch (e) { /* */ }
}
function suppressDownloadUI() { setDownloadUI(false); if (restoreUiTimer) clearTimeout(restoreUiTimer); restoreUiTimer = setTimeout(() => setDownloadUI(true), 8000); }

const PLATFORMS = [
  [/meet\.google\.com/, 'Google Meet'], [/zoom\.us/, 'Zoom'], [/teams\.(microsoft|live)\.com|teams\.cloud\.microsoft/, 'MS Teams'],
  [/webex\.com/, 'Webex'], [/whereby\.com/, 'Whereby'], [/zoho\.com/, 'Zoho'], [/around\.co/, 'Around'],
  [/jit\.si|8x8\.vc/, 'Jitsi'], [/bluejeans\.com/, 'BlueJeans'], [/gotomeeting\.com|goto\.com/, 'GoTo'],
  [/gather\.town/, 'Gather'], [/chime\.aws/, 'Chime'], [/daily\.co/, 'Daily'], [/discord\.com/, 'Discord'], [/slack\.com/, 'Slack'],
];
function derivePlatform(url) {
  try { const u = url || ''; for (const [re, name] of PLATFORMS) if (re.test(u)) return name; return new URL(u).hostname.replace(/^www\./, ''); } catch (e) { return 'Unknown'; }
}
function durationStr(ms) { if (!ms || ms < 0) return 'Unknown'; const s = Math.floor(ms / 1000); const m = Math.floor(s / 60); return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m ${s % 60}s`; }

// Human-findable per-meeting folder: "Ghost Recordings/2026-07-04 14-30 Google Meet"
function folderName(date, platform) {
  const d = new Date(date); const p = (n) => String(n).padStart(2, '0');
  const plat = String(platform || 'Meeting').replace(/[\\/:*?"<>|.]/g, '').trim() || 'Meeting';
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}-${p(d.getMinutes())} ${plat}`;
}
async function saveFileFor(meetingId, name, url, done) {
  const m = await getMeeting(meetingId);
  const folder = (m && m.folder) || `meeting-${meetingId}`;
  suppressDownloadUI();
  chrome.downloads.download({ url, filename: `Ghost Recordings/${folder}/${name}`, saveAs: false, conflictAction: 'overwrite' }, (downloadId) => {
    if (chrome.runtime.lastError) {
      // FAILSAFE: never fail silently — the copy in IndexedDB still exists.
      const msg = chrome.runtime.lastError.message;
      console.warn('save failed', name, msg);
      upsertMeeting(meetingId, { saveError: `Saving ${name} to Downloads failed (${msg}). The recording is still playable here in the dashboard.` });
      notify(meetingId + '-save', 'Saving to Downloads failed', name + ': ' + msg + ' — recording is still available in the dashboard.');
      return;
    }
    if (done) done(downloadId);
  });
}

const UNRECORDABLE = /^(chrome|edge|about|devtools|view-source|chrome-extension|https:\/\/chrome\.google\.com\/webstore|https:\/\/chromewebstore\.google\.com)/i;

function notify(id, title, message) {
  try {
    chrome.notifications.create('ghost-' + id, { type: 'basic', iconUrl: 'icon.png', title, message: (message || '').slice(0, 150), priority: 2 });
  } catch (e) { /* notifications unavailable */ }
}
if (chrome.notifications && chrome.notifications.onClicked) {
  chrome.notifications.onClicked.addListener((nid) => {
    chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html') });
    chrome.notifications.clear(nid);
  });
}

function emailMailto(meeting, email) {
  const notes = meeting.notes || '';
  let body = notes.split(/##\s*Full Transcript/i)[0].trim() || notes.slice(0, 1500);
  if (body.length > 1800) body = body.slice(0, 1800) + '\n\n…(full notes saved to Downloads)';
  else body += '\n\n(Full transcript + recording saved to your Downloads folder.)';
  return `mailto:${encodeURIComponent(email)}?subject=${encodeURIComponent('Meeting Notes — ' + (meeting.date ? meeting.date.slice(0, 10) : meeting.id))}&body=${encodeURIComponent(body)}`;
}
function openEmail(meeting, email) { if (email) chrome.tabs.create({ url: emailMailto(meeting, email) }).catch(() => {}); }

function offscreenPing() {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ action: 'PING', target: 'offscreen' }, (r) => { resolve(!chrome.runtime.lastError && !!(r && r.ready)); });
  });
}
async function ensureOffscreen() {
  if (!(await chrome.offscreen.hasDocument())) {
    await chrome.offscreen.createDocument({ url: 'offscreen.html', reasons: ['USER_MEDIA', 'AUDIO_PLAYBACK', 'DISPLAY_MEDIA'], justification: 'Invisible meeting recording and transcription.' });
  }
  // Wait until the offscreen listener is actually live before sending START_RECORDING
  // (fixes the cold-start race that silently dropped the first recording).
  for (let i = 0; i < 30; i++) { if (await offscreenPing()) return true; await new Promise((r) => setTimeout(r, 150)); }
  return false;
}
function prettyDate(iso) {
  try { return new Date(iso || Date.now()).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }); } catch (e) { return String(iso || ''); }
}
async function buildMeta(id) {
  const m = await getMeeting(id);
  return { date: prettyDate(m && m.date), platform: (m && m.platform) || recordingState.platform || 'Unknown', duration: durationStr(recordingState.startTime ? Date.now() - recordingState.startTime : 0), title: m && m.title };
}

// --------------------------------------------------------------------------- messages
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  switch (request.action) {
    case 'START_CAPTURE':
      startCapture(request.tabId || (sender.tab && sender.tab.id))
        .then((r) => sendResponse(r))
        .catch((err) => sendResponse({ success: false, error: err.message }));
      return true;

    case 'STOP_CAPTURE':
      stopCapture().then(() => sendResponse({ success: true })).catch((err) => sendResponse({ success: false, error: err.message }));
      return true;

    case 'PAUSE_CAPTURE':
      if (recordingState.isRecording && !recordingState.pausedAt) {
        recordingState.pausedAt = Date.now();
        chrome.runtime.sendMessage({ action: 'PAUSE_RECORDING', target: 'offscreen' }).catch(() => {});
        chrome.action.setBadgeText({ text: '⏸' }); chrome.action.setBadgeBackgroundColor({ color: '#64748b' });
      }
      sendResponse({ success: true });
      return true;

    case 'RESUME_CAPTURE':
      if (recordingState.isRecording && recordingState.pausedAt) {
        // shift startTime forward so elapsed-time displays exclude the pause
        const pausedFor = Date.now() - recordingState.pausedAt;
        recordingState.startTime += pausedFor; recordingState.pausedAt = null;
        chrome.storage.local.set({ startTime: recordingState.startTime });
        chrome.runtime.sendMessage({ action: 'RESUME_RECORDING', target: 'offscreen' }).catch(() => {});
        chrome.action.setBadgeText({ text: 'REC' }); chrome.action.setBadgeBackgroundColor({ color: '#ef4444' });
      }
      sendResponse({ success: true });
      return true;

    case 'TAB_ENDED':
      if (recordingState.isRecording && request.meetingId === recordingState.meetingId) stopCapture();
      return false;

    case 'GET_STATE':
      sendResponse(recordingState);
      return true;

    case 'CAPTION': {
      const store = (mid) => { if (mid && request.line) appendCaption(mid, request.line); };
      if (recordingState.meetingId) { store(recordingState.meetingId); return false; }
      chrome.storage.local.get(['isRecording', 'meetingId'], (s) => { if (s && s.isRecording && s.meetingId) { recordingState.meetingId = s.meetingId; store(s.meetingId); } });
      return true;
    }

    case 'MIC_READY':
      chrome.runtime.sendMessage({ action: 'MIC_READY', target: 'offscreen' }).catch(() => {});
      return false;

    case 'MIC_STATUS': // from offscreen -> relay to the recording tab's overlay
      if (recordingState.tabId != null) chrome.tabs.sendMessage(recordingState.tabId, { action: 'MIC_STATUS', connected: request.connected }).catch(() => {});
      return false;

    case 'AUDIO_STATUS': // live meeting-audio silence warning from offscreen -> overlay
      if (recordingState.tabId != null) chrome.tabs.sendMessage(recordingState.tabId, { action: 'AUDIO_STATUS', ok: request.ok, text: request.text }).catch(() => {});
      return false;

    case 'SAVE_FILE': {
      const name = request.kind === 'video' ? 'video.webm' : 'audio.webm';
      saveFileFor(request.meetingId, name, request.url, (downloadId) => upsertMeeting(request.meetingId, { files: { [request.kind]: { downloadId, name } } }));
      return false;
    }

    case 'NOTES_READY': {
      saveFileFor(request.meetingId, 'notes.md', 'data:text/markdown;charset=utf-8,' + encodeURIComponent(request.notes), (downloadId) => upsertMeeting(request.meetingId, { files: { notes: { downloadId, name: 'notes.md' } } }));
      upsertMeeting(request.meetingId, { state: 'done', notes: request.notes, model: request.model, provider: request.provider, warnings: request.warnings || [], error: null }).then(async (m) => {
        notify(request.meetingId, '✓ Meeting notes ready', (m && m.title || 'Your meeting') + ' — click to open.');
        const settings = await getSettings();
        if (settings.autoEmail && settings.email) openEmail(m, settings.email);
      });
      clearCaptions(request.meetingId);
      chrome.action.setBadgeText({ text: '✓' }); chrome.action.setBadgeBackgroundColor({ color: '#10b981' });
      setTimeout(() => chrome.action.setBadgeText({ text: '' }), 5000);
      return false;
    }

    case 'NOTES_ERROR':
      upsertMeeting(request.meetingId, { state: 'error', error: request.error, warnings: request.warnings || [] });
      notify(request.meetingId, 'Meeting notes failed', 'Recording is saved. Click to open the dashboard and Retry.');
      return false;

    case 'EMAIL_NOTES':
      getMeeting(request.meetingId).then(async (m) => {
        if (!m) return;
        const email = request.email || (await getSettings()).email;
        if (email) openEmail(m, email);
        else { chrome.tabs.create({ url: chrome.runtime.getURL('options.html') }); try { sendResponse({ success: false, error: 'no-email' }); } catch (e) { /* */ } }
      });
      return true;

    case 'RECOVERED': { // interrupted recording found in IndexedDB by the offscreen doc
      const mid = request.meetingId;
      let date = new Date().toISOString();
      const m5 = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})/.exec(mid);
      if (m5) date = `${m5[1]}T${m5[2]}:${m5[3]}:${m5[4]}Z`;
      upsertMeeting(mid, {
        date, title: 'Recovered meeting', platform: 'Recovered', folder: folderName(date, 'Recovered'),
        state: 'error', error: 'This recording was interrupted (browser closed or crashed) but has been RECOVERED. The audio/video files are saved — press "↻ Retry AI" to generate the notes.', videoEnabled: !!request.hasVideo, warnings: [],
      }).then(() => { notify(mid, 'Recovered an interrupted recording', 'Open the dashboard to play it and generate notes.'); sendResponse({ ok: true }); });
      return true;
    }

    case 'OFFLINE_MEETING': { // in-person recording made in the dashboard (mic + live transcript)
      const d = new Date();
      upsertMeeting(request.meetingId, {
        date: d.toISOString(), title: 'In-person meeting — ' + d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }),
        platform: 'In-person', folder: folderName(d, 'In-person'), state: 'processing', videoEnabled: false,
        duration: request.duration || 'Unknown', notes: '', error: null, warnings: [],
      }).then(() => sendResponse({ ok: true }));
      return true;
    }

    case 'SET_THUMB': // dashboard-generated video thumbnail (small jpeg data URL)
      if (request.meetingId && request.thumb && request.thumb.length < 60000) upsertMeeting(request.meetingId, { thumb: request.thumb });
      return false;

    case 'RENAME_MEETING':
      if (request.meetingId && request.title) upsertMeeting(request.meetingId, { title: String(request.title).slice(0, 120) });
      return false;

    case 'DELETE_MEETING':
      serialize(async () => {
        const list = (await getMeetings()).filter((x) => x.id !== request.meetingId);
        await chrome.storage.local.set({ meetings: list });
      });
      clearCaptions(request.meetingId);
      return false;

    case 'RETRY_NOTES': // also used to RE-generate notes with a different template
      retryNotes(request.meetingId, request.template);
      return false;

    case 'PLATFORM_DETECTED':
      if (sender.tab && recordingState.tabId === sender.tab.id) recordingState.platform = derivePlatform(sender.tab.url);
      return false;

    case 'LOG':
      console.log('[offscreen]', request.message);
      return false;

    default:
      return false;
  }
});

// --------------------------------------------------------------------------- actions
async function startCapture(tabId) {
  if (tabId == null) throw new Error('No tab to record.');
  if (recordingState.isRecording) throw new Error('Already recording a meeting — stop that one first.');
  const settings = await getSettings();
  let platform = 'Unknown', tabTitle = '';
  try {
    const tab = await chrome.tabs.get(tabId);
    if (UNRECORDABLE.test(tab.url || '')) throw new Error("This page can't be recorded — switch to your meeting tab, then press Start.");
    platform = derivePlatform(tab.url);
    tabTitle = (tab.title || '').trim();
  } catch (e) { if (/can't be recorded/.test(e.message)) throw e; }

  const meetingId = new Date().toISOString().replace(/[:.]/g, '-');
  const videoEnabled = settings.videoEnabled;
  const startedAt = new Date();
  const title = tabTitle ? tabTitle.slice(0, 80) : platform + ' meeting';

  await ensureOffscreen();
  let streamId;
  try { streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }); }
  catch (e) { throw new Error("Chrome refused to capture this tab (" + e.message + "). Click into the meeting tab once, then press Start."); }

  chrome.runtime.sendMessage({ action: 'START_RECORDING', target: 'offscreen', data: { streamId, videoEnabled, meetingId } });

  recordingState = { isRecording: true, tabId, meetingId, startTime: Date.now(), videoEnabled, platform };
  chrome.storage.local.set({ isRecording: true, meetingId, tabId, startTime: recordingState.startTime, videoEnabled, platform });
  await clearCaptions(meetingId);
  await upsertMeeting(meetingId, { date: startedAt.toISOString(), title, platform, folder: folderName(startedAt, platform), state: 'recording', videoEnabled, notes: '', error: null, warnings: [] });

  chrome.action.setBadgeText({ text: 'REC' }); chrome.action.setBadgeBackgroundColor({ color: '#ef4444' });
  chrome.tabs.sendMessage(tabId, { action: 'SHOW_UI', meetingId }).catch(() => {});

  return { success: true, meetingId, hasKey: !!providerKey(settings), provider: settings.provider };
}

async function stopCapture() {
  const id = recordingState.meetingId;
  if (!id) return;
  if (recordingState.pausedAt) { recordingState.startTime += Date.now() - recordingState.pausedAt; recordingState.pausedAt = null; }
  const settings = await getSettings();
  const captions = await readCaptions(id);
  const meta = await buildMeta(id);

  chrome.runtime.sendMessage({ action: 'STOP_RECORDING', target: 'offscreen', data: { captions, settings, meta } }).catch(() => {});
  if (recordingState.tabId != null) chrome.tabs.sendMessage(recordingState.tabId, { action: 'HIDE_UI' }).catch(() => {});
  await upsertMeeting(id, { state: 'processing', duration: meta.duration });

  recordingState.isRecording = false;
  chrome.storage.local.set({ isRecording: false });
  chrome.action.setBadgeText({ text: '' });
}

async function retryNotes(id, templateOverride) {
  const settings = await getSettings();
  if (templateOverride) settings.template = templateOverride;
  const m = await getMeeting(id);
  await upsertMeeting(id, { state: 'processing', error: null });
  await ensureOffscreen();
  chrome.runtime.sendMessage({ action: 'RETRY', target: 'offscreen', data: { meetingId: id, settings, meta: { date: prettyDate(m && m.date), platform: (m && m.platform) || 'Unknown', duration: (m && m.duration) || 'Unknown', title: m && m.title } } }).catch(() => {});
}
