// Ghost Recorder — Offscreen Recorder (serverless, multi-provider)
//
// Captures BOTH sides of the call and survives backgrounding/minimizing:
//   tab audio ─┬─► recGain ─► recDest ─► MediaRecorder(s)   (RECORDING: remote + you)
//              └─► monitorGain ─► ctx.destination           (you keep HEARING the call, once)
//   mic audio ───► micGain ─► recDest                       (recorded, NOT monitored = no feedback)
//
// Hardening: AudioContext auto-resume if the OS suspends it when minimized;
// auto-stop if the captured tab is closed/navigated; silent-track detection;
// chunks buffered + audio kept in IndexedDB so a failed AI call can be retried.

let ctx = null, tabStream = null, micStream = null, recDest = null, micConnected = false, monitorEl = null;
let audioRecorder = null, videoRecorder = null, audioChunks = [], videoChunks = [];
let meetingId = null, stopping = false, recStartMs = 0;
let levelTimer = null, tabLevel = null, micLevel = null, tabHadAudio = false, micHadAudio = false, tabHadAudioTrack = false;
let silenceWarned = false, levelTicks = 0, persistTimer = null, samplerTimer = null;
let tabPeak = 0, micPeak = 0, tabPeakAll = 0, micPeakAll = 0;
let pausedAt = 0, totalPausedMs = 0;

function log(msg) { console.log('[offscreen]', msg); chrome.runtime.sendMessage({ action: 'LOG', message: msg }).catch(() => {}); }

const IDB_NAME = 'ghost', IDB_STORE = 'pending';
function idb() { return new Promise((res, rej) => { const r = indexedDB.open(IDB_NAME, 1); r.onupgradeneeded = () => r.result.createObjectStore(IDB_STORE, { keyPath: 'id' }); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); }
async function idbPut(v) { const db = await idb(); return new Promise((res, rej) => { const tx = db.transaction(IDB_STORE, 'readwrite'); tx.objectStore(IDB_STORE).put(v); tx.oncomplete = res; tx.onerror = () => rej(tx.error); }); }
async function idbGet(id) { const db = await idb(); return new Promise((res, rej) => { const tx = db.transaction(IDB_STORE, 'readonly'); const rq = tx.objectStore(IDB_STORE).get(id); rq.onsuccess = () => res(rq.result); rq.onerror = () => rej(rq.error); }); }
async function idbDel(id) { const db = await idb(); return new Promise((res) => { const tx = db.transaction(IDB_STORE, 'readwrite'); tx.objectStore(IDB_STORE).delete(id); tx.oncomplete = res; tx.onerror = res; }); }
async function idbAll() { const db = await idb(); return new Promise((res, rej) => { const tx = db.transaction(IDB_STORE, 'readonly'); const rq = tx.objectStore(IDB_STORE).getAll(); rq.onsuccess = () => res(rq.result || []); rq.onerror = () => rej(rq.error); }); }
// Keep the library bounded: newest 12 full recordings stay playable; older ones drop.
async function pruneLibrary() {
  try {
    const ids = (await idbAll()).map((r) => r.id).filter((i) => !String(i).startsWith('live-')).sort().reverse();
    for (const id of ids.slice(12)) await idbDel(id);
  } catch (e) { log('prune failed: ' + e.message); }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.target !== 'offscreen') return;
  if (message.action === 'PING') { sendResponse({ ready: true }); return; } // readiness handshake
  if (message.action === 'START_RECORDING') startRecording(message.data.streamId, message.data.videoEnabled, message.data.meetingId);
  else if (message.action === 'STOP_RECORDING') stopRecording(message.data || {});
  else if (message.action === 'PAUSE_RECORDING') pauseRecording(true);
  else if (message.action === 'RESUME_RECORDING') pauseRecording(false);
  else if (message.action === 'MIC_READY') connectMic('mic-ready');
  else if (message.action === 'RETRY') retry(message.data || {});
  else if (message.action === 'RECOVER') recoverInterrupted();
});

// FAILSAFE: if Chrome/the extension died mid-recording, a 'live-<id>' snapshot is
// still in IndexedDB. Turn it into a normal (recovered) meeting with saved files.
async function recoverInterrupted() {
  try {
    const all = await idbAll();
    for (const rec of all) {
      const rid = String(rec.id);
      if (!rid.startsWith('live-')) continue;
      const mid = rid.slice(5);
      if (mid === meetingId) continue; // that one is still actively recording
      log('recovering interrupted recording ' + mid);
      // Register the meeting first (so the save lands in its folder), then save files.
      await new Promise((res) => chrome.runtime.sendMessage({ action: 'RECOVERED', meetingId: mid, hasVideo: !!rec.video }, () => res()));
      // Snapshots were cut mid-flight and carry no Duration header — measure and
      // stamp so recovered files are seekable and end where the media ends.
      if (rec.audio) { const d = await measureDurationMs(rec.audio, 0); if (d > 0) rec.audio = await fixWebmDuration(rec.audio, d); }
      if (rec.video) { const d = await measureDurationMs(rec.video, 0); if (d > 0) rec.video = await fixWebmDuration(rec.video, d); }
      if (rec.audio) saveBlob(mid, 'audio', rec.audio);
      if (rec.video) saveBlob(mid, 'video', rec.video);
      await idbPut({ id: mid, audio: rec.audio, video: rec.video || null, captions: rec.captions || '', settings: rec.settings || null, meta: rec.meta || {} });
      await idbDel(rid);
    }
  } catch (e) { log('recover failed: ' + e.message); }
}

function levelChecker(node) {
  const an = ctx.createAnalyser(); an.fftSize = 512; node.connect(an);
  const data = new Uint8Array(an.fftSize);
  return () => { an.getByteTimeDomainData(data); let s = 0; for (let i = 0; i < data.length; i++) { const v = (data[i] - 128) / 128; s += v * v; } return Math.sqrt(s / data.length); };
}

async function connectMic(why) {
  if (micConnected || !ctx || !recDest) return;
  try {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    if (ctx.state === 'suspended') await ctx.resume();
    const micNode = ctx.createMediaStreamSource(micStream);
    const micGain = ctx.createGain(); micGain.gain.value = 1.0;
    micNode.connect(micGain).connect(recDest); // recorded only — never monitored (no feedback)
    micLevel = levelChecker(micNode);
    micConnected = true;
    chrome.runtime.sendMessage({ action: 'MIC_STATUS', connected: true }).catch(() => {});
    log(`microphone mixed in (${why})`);
  } catch (err) { log(`microphone not available (${why}): ${err.message}`); }
}

function pauseRecording(pause) {
  try {
    for (const r of [audioRecorder, videoRecorder]) {
      if (!r) continue;
      if (pause && r.state === 'recording') r.pause();
      else if (!pause && r.state === 'paused') r.resume();
    }
    if (pause) pausedAt = Date.now();
    else if (pausedAt) { totalPausedMs += Date.now() - pausedAt; pausedAt = 0; }
    log(pause ? 'recording paused' : 'recording resumed');
  } catch (e) { log('pause/resume failed: ' + e.message); }
}

function sendAudioStatus(ok, text) {
  chrome.runtime.sendMessage({ action: 'AUDIO_STATUS', ok, text }).catch(() => {});
}

// ---- Seekable WebM ----------------------------------------------------------
// MediaRecorder writes no Duration into the Segment Info, so players can't show
// a timeline or seek — playback always restarts from 0. Patch the real duration
// into the EBML header before saving. Best-effort: any parse failure returns the
// original blob untouched.
// Ask the browser for the media's REAL length: fresh MediaRecorder webm has no
// Duration header, so metadata reports Infinity — seeking far past the end
// forces Chrome to scan the clusters and report the true duration. Falls back
// to the wall-clock estimate on any failure (never blocks saving).
function measureDurationMs(blob, fallbackMs) {
  return new Promise((resolve) => {
    let el, url, timer;
    const done = (ms) => {
      clearTimeout(timer);
      if (url) URL.revokeObjectURL(url);
      if (el) { el.onerror = el.onloadedmetadata = el.ondurationchange = null; el.src = ''; el.remove(); }
      resolve(ms);
    };
    try {
      url = URL.createObjectURL(blob);
      el = document.createElement('video');
      el.preload = 'metadata'; el.muted = true;
      timer = setTimeout(() => done(fallbackMs), 10000);
      el.onerror = () => done(fallbackMs);
      el.onloadedmetadata = () => {
        if (isFinite(el.duration) && el.duration > 0) { done(el.duration * 1000); return; }
        el.ondurationchange = () => { if (isFinite(el.duration) && el.duration > 0) done(el.duration * 1000); };
        el.currentTime = 1e8; // force the cluster scan
      };
      el.src = url;
    } catch (e) { done(fallbackMs); }
  });
}

async function fixWebmDuration(blob, durationMs) {
  try {
    const buf = new Uint8Array(await blob.arrayBuffer());
    const vintLen = (b) => { for (let i = 0; i < 8; i++) if (b & (0x80 >> i)) return i + 1; return -1; };
    function readElem(pos) {
      const idLen = vintLen(buf[pos]);
      if (idLen < 1 || pos + idLen >= buf.length) return null;
      let id = 0; for (let i = 0; i < idLen; i++) id = id * 256 + buf[pos + i];
      const sp = pos + idLen, sizeLen = vintLen(buf[sp]);
      if (sizeLen < 1) return null;
      let size = buf[sp] & (0xff >> sizeLen), unknown = size === (0xff >> sizeLen);
      for (let i = 1; i < sizeLen; i++) { size = size * 256 + buf[sp + i]; if (buf[sp + i] !== 0xff) unknown = false; }
      return { id, size, sizeLen, hdrLen: idLen + sizeLen, dataPos: sp + sizeLen, pos, unknown };
    }
    // top level: skip EBML header, find Segment
    let pos = 0, seg = null;
    while (pos < buf.length) { const e = readElem(pos); if (!e) return blob; if (e.id === 0x18538067) { seg = e; break; } pos = e.dataPos + e.size; }
    if (!seg) return blob;
    // inside Segment: find Info before the first media Cluster
    pos = seg.dataPos; let info = null;
    while (pos < buf.length) {
      const e = readElem(pos); if (!e) return blob;
      if (e.id === 0x1549A966) { info = e; break; }
      if (e.id === 0x1F43B675 || e.unknown) return blob; // hit media / can't walk further
      pos = e.dataPos + e.size;
    }
    if (!info || info.unknown) return blob;
    // inside Info: read TimecodeScale, find existing Duration
    let scale = 1000000, dur = null; pos = info.dataPos;
    while (pos < info.dataPos + info.size) {
      const e = readElem(pos); if (!e) break;
      if (e.id === 0x2AD7B1) { let v = 0; for (let i = 0; i < e.size; i++) v = v * 256 + buf[e.dataPos + i]; if (v) scale = v; }
      if (e.id === 0x4489) dur = e;
      pos = e.dataPos + e.size;
    }
    const durVal = durationMs * 1e6 / scale; // Duration is in TimecodeScale units
    if (dur && (dur.size === 8 || dur.size === 4)) { // overwrite in place
      const dv = new DataView(buf.buffer, dur.dataPos, dur.size);
      if (dur.size === 8) dv.setFloat64(0, durVal); else dv.setFloat32(0, durVal);
      return new Blob([buf], { type: blob.type });
    }
    if (dur) return blob;
    // No Duration element: splice one in at the start of Info's body.
    const durBytes = new Uint8Array(11); // 0x4489, size 0x88, float64
    durBytes[0] = 0x44; durBytes[1] = 0x89; durBytes[2] = 0x88;
    new DataView(durBytes.buffer).setFloat64(3, durVal);
    const newInfoSize = info.size + durBytes.length;
    const infoHdr = new Uint8Array(4 + 8); // Info id (4B) + 8-byte vint size
    infoHdr.set([0x15, 0x49, 0xA9, 0x66, 0x01]);
    for (let i = 0; i < 7; i++) infoHdr[5 + i] = (newInfoSize / Math.pow(256, 6 - i)) & 0xff;
    const prefix = buf.slice(0, info.pos);
    const delta = (infoHdr.length + durBytes.length + info.size) - (info.hdrLen + info.size);
    if (!seg.unknown) { // Segment has a known size: only safe if we can rewrite it in the same width
      let s = seg.size + delta;
      const segSizePos = seg.pos + (seg.hdrLen - seg.sizeLen);
      if (seg.sizeLen !== 8) return blob;
      prefix[segSizePos] = 0x01;
      for (let i = 0; i < 7; i++) prefix[segSizePos + 1 + i] = (s / Math.pow(256, 6 - i)) & 0xff;
    }
    return new Blob([prefix, infoHdr, durBytes, buf.slice(info.dataPos)], { type: blob.type });
  } catch (e) { log('webm duration patch skipped: ' + e.message); return blob; }
}

function onTabEnded() {
  if (stopping) return;
  log('captured tab ended (closed/navigated) — auto-stopping');
  chrome.runtime.sendMessage({ action: 'TAB_ENDED', meetingId }).catch(() => {});
}

async function startRecording(streamId, videoEnabled, id) {
  meetingId = id; stopping = false; audioChunks = []; videoChunks = [];
  tabHadAudio = micHadAudio = tabHadAudioTrack = false; silenceWarned = false; levelTicks = 0;
  tabPeak = 0; micPeak = 0; tabPeakAll = 0; micPeakAll = 0;
  recStartMs = Date.now(); pausedAt = 0; totalPausedMs = 0;
  log(`starting recording (video=${videoEnabled}, id=${id})`);
  try {
    const constraints = { audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId, googDisableLocalEcho: false } } };
    if (videoEnabled) constraints.video = { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId, maxWidth: 1280, maxHeight: 720, maxFrameRate: 15 } };
    tabStream = await navigator.mediaDevices.getUserMedia(constraints);

    const tabAudio = tabStream.getAudioTracks();
    tabHadAudioTrack = tabAudio.length > 0;
    log(`captured tracks — video:${tabStream.getVideoTracks().length} audio:${tabAudio.length}`);
    tabStream.getTracks().forEach((t) => { t.onended = onTabEnded; });

    // 'playback' latency = larger render buffers (hidden page is CPU-throttled; the
    // default 'interactive' buffers underran -> crackle). No forced sampleRate: on
    // 44.1kHz output devices a forced 48k context resamples on the fly = more glitches.
    ctx = new AudioContext({ latencyHint: 'playback' });
    if (ctx.state === 'suspended') await ctx.resume();
    // If the OS suspends the AudioContext when the window is minimized, resume it so recording doesn't drop out.
    ctx.onstatechange = () => { if (ctx && ctx.state === 'suspended' && !stopping) ctx.resume().catch(() => {}); };
    recDest = ctx.createMediaStreamDestination();

    if (tabAudio.length) {
      const tabNode = ctx.createMediaStreamSource(new MediaStream([tabAudio[0]]));
      const recGain = ctx.createGain(); recGain.gain.value = 1.0;
      tabNode.connect(recGain).connect(recDest);                 // BRANCH A — record (WebAudio mix)
      // BRANCH B — MONITOR through an <audio> element instead of ctx.destination:
      // the element has its own deeply-buffered playout path, so device-output
      // underruns on this throttled hidden page no longer crackle what the user
      // hears, and the recording graph no longer contends with device output.
      monitorEl = new Audio();
      monitorEl.srcObject = new MediaStream([tabAudio[0]]);
      monitorEl.play().catch((e) => log('monitor play failed: ' + e.message));
      tabLevel = levelChecker(tabNode);
      // NOTE: captured tab tracks fire mute/unmute on every natural pause in speech —
      // that is NOT an error (v5.8.3 fix: these used to raise false "no audio" warnings).
      tabAudio[0].onmute = () => log('tab audio track muted (natural silence — normal)');
      tabAudio[0].onunmute = () => log('tab audio track unmuted');
    } else { log('WARNING: no tab audio track'); }

    // Level sampling every 300ms (a single 2s snapshot missed speech between checks
    // and caused false "silent" verdicts); peaks are evaluated by the 2s watchdog.
    samplerTimer = setInterval(() => {
      if (tabLevel) { const v = tabLevel(); tabPeak = Math.max(tabPeak, v); tabPeakAll = Math.max(tabPeakAll, v); }
      if (micLevel) { const v = micLevel(); micPeak = Math.max(micPeak, v); micPeakAll = Math.max(micPeakAll, v); }
    }, 300);

    // Watchdog every 2s: keep the AudioContext alive; warn LIVE only if the meeting
    // side has produced NO audio at all for ~14s, and clear the moment audio appears.
    levelTimer = setInterval(() => {
      if (ctx && ctx.state !== 'running' && !stopping) ctx.resume().catch(() => {});
      levelTicks++;
      if (tabPeak > 0.008) { if (!tabHadAudio || silenceWarned) { silenceWarned = false; sendAudioStatus(true, ''); } tabHadAudio = true; }
      if (micPeak > 0.008) micHadAudio = true;
      if (levelTicks % 10 === 0) log(`audio levels — tabPeak=${tabPeak.toFixed(4)} micPeak=${micPeak.toFixed(4)} (threshold 0.008)`);
      tabPeak = 0; micPeak = 0;
      if (!tabHadAudio && levelTicks === 7 && !silenceWarned) { silenceWarned = true; sendAudioStatus(false, 'No meeting audio detected yet — unmute the tab / check the call has sound.'); }
    }, 2000);

    const amime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/webm';
    audioRecorder = new MediaRecorder(recDest.stream, { mimeType: amime, audioBitsPerSecond: 64000 });
    audioRecorder.ondataavailable = (e) => { if (e.data && e.data.size) audioChunks.push(e.data); };
    audioRecorder.start(5000);

    if (videoEnabled && tabStream.getVideoTracks().length) {
      const mime = MediaRecorder.isTypeSupported('video/webm;codecs=vp8,opus') ? 'video/webm;codecs=vp8,opus' : 'video/webm';
      const recordStream = new MediaStream([tabStream.getVideoTracks()[0], ...recDest.stream.getAudioTracks()]);
      videoRecorder = new MediaRecorder(recordStream, { mimeType: mime, videoBitsPerSecond: 1200000, audioBitsPerSecond: 96000 });
      videoRecorder.ondataavailable = (e) => { if (e.data && e.data.size) videoChunks.push(e.data); };
      videoRecorder.start(5000);
    }
    log('recording started');

    // FAILSAFE: snapshot the chunks so far into IndexedDB every 20s — if the
    // browser/extension dies mid-meeting, the recording is recoverable.
    persistTimer = setInterval(() => {
      if (stopping || !meetingId) return;
      const snap = { id: 'live-' + meetingId, updated: Date.now(), meta: { date: new Date(recStartMs).toISOString() } };
      if (audioChunks.length) snap.audio = new Blob(audioChunks, { type: 'audio/webm' });
      if (videoChunks.length) snap.video = new Blob(videoChunks, { type: 'video/webm' });
      if (snap.audio) idbPut(snap).catch((e) => log('live snapshot failed: ' + e.message));
    }, 20000);

    // Mic AFTER the recorders are live: a slow/hung permission check must never
    // delay or kill the meeting recording. It mixes into recDest mid-stream fine.
    connectMic('eager').then(() => {
      if (!micConnected) chrome.runtime.sendMessage({ action: 'MIC_STATUS', connected: false }).catch(() => {});
    });
  } catch (err) {
    log(`recording failed to start: ${err.message}`);
    try { teardownGraph(); } catch (e) { /* */ }   // don't leak a live capture / AudioContext
    chrome.runtime.sendMessage({ action: 'NOTES_ERROR', meetingId: id, error: 'Recording failed to start: ' + err.message }).catch(() => {});
  }
}

function saveBlob(id, kind, blob) {
  const url = URL.createObjectURL(blob);
  chrome.runtime.sendMessage({ action: 'SAVE_FILE', meetingId: id, kind, url, bytes: blob.size }).catch(() => {});
  setTimeout(() => URL.revokeObjectURL(url), 180000);
}

function teardownGraph() {
  if (levelTimer) { clearInterval(levelTimer); levelTimer = null; }
  if (samplerTimer) { clearInterval(samplerTimer); samplerTimer = null; }
  if (persistTimer) { clearInterval(persistTimer); persistTimer = null; }
  if (monitorEl) { try { monitorEl.pause(); monitorEl.srcObject = null; } catch (e) { /* */ } monitorEl = null; }
  if (tabStream) tabStream.getTracks().forEach((t) => { t.onended = null; t.stop(); });
  if (micStream) micStream.getTracks().forEach((t) => t.stop());
  if (ctx) { try { ctx.onstatechange = null; ctx.close(); } catch (e) { /* ignore */ } }
  ctx = null; tabStream = null; micStream = null; recDest = null; tabLevel = null; micLevel = null;
  audioRecorder = null; videoRecorder = null;
  micConnected = false; // CRITICAL: without this, every recording after the first skips the mic (silent second run)
}

function audioWarnings() {
  const w = [];
  const db = (v) => (v > 0 ? Math.round(20 * Math.log10(v)) + ' dB' : 'silence');
  if (!tabHadAudioTrack) w.push('No meeting-audio track was captured — the remote side may be missing.');
  else if (!tabHadAudio) w.push('The meeting (remote) audio was silent the whole recording. (Normal if you were ALONE in the call — your own voice comes from the mic, not the meeting.)');
  if (!micConnected) w.push('Your microphone was NOT captured — open Settings → "Enable mic", then record again.');
  else if (!micHadAudio) w.push('Your microphone was connected but stayed silent — check Windows is using the right input device.');
  w.push(`Audio diagnostics — meeting side peak: ${db(tabPeakAll)} · your mic peak: ${db(micPeakAll)} (speech is roughly -30 to -6 dB).`);
  return w;
}

async function transcribeAndReport(id, audioBlob, captions, ctxData, extraWarnings) {
  log('generating notes with ' + (ctxData.settings && ctxData.settings.provider) + '…');
  try {
    const res = await self.GhostProviders.run(audioBlob, captions || '', ctxData.settings, ctxData.meta || {});
    chrome.runtime.sendMessage({ action: 'NOTES_READY', meetingId: id, notes: res.notes, model: res.model, provider: res.provider, warnings: (extraWarnings || []).concat(res.warnings || []) }).catch(() => {});
    log('notes ready'); // recording stays in IndexedDB for playback/re-generation (pruned to newest 12)
  } catch (err) {
    chrome.runtime.sendMessage({ action: 'NOTES_ERROR', meetingId: id, error: err.message, warnings: extraWarnings || [] }).catch(() => {});
    log('notes failed: ' + err.message);
  }
}

async function stopRecording(opts) {
  if (stopping) return; stopping = true;
  const id = meetingId;
  log('stopping recording');
  const waits = [];
  for (const r of [audioRecorder, videoRecorder]) {
    if (r && r.state !== 'inactive') { waits.push(new Promise((res) => { r.onstop = res; })); r.stop(); }
  }
  await Promise.all(waits);

  if (pausedAt) { totalPausedMs += Date.now() - pausedAt; pausedAt = 0; } // stopped while paused
  const durationMs = Math.max(0, Date.now() - recStartMs - totalPausedMs);
  let audioBlob = audioChunks.length ? new Blob(audioChunks, { type: 'audio/webm' }) : null;
  let videoBlob = videoChunks.length ? new Blob(videoChunks, { type: 'video/webm' }) : null;
  audioChunks = []; videoChunks = [];
  const warnings = audioWarnings();

  // Stamp each file with its OWN measured duration (decoded from the media
  // timeline), not the wall clock — if the stamp is shorter than the real
  // media, players stop early and pretend the recording ended. Wall clock is
  // only the fallback when measuring fails.
  if (audioBlob) audioBlob = await fixWebmDuration(audioBlob, await measureDurationMs(audioBlob, durationMs));
  if (videoBlob) videoBlob = await fixWebmDuration(videoBlob, await measureDurationMs(videoBlob, durationMs));
  if (videoBlob) saveBlob(id, 'video', videoBlob);
  if (audioBlob) saveBlob(id, 'audio', audioBlob);

  teardownGraph();
  meetingId = null;

  if (!audioBlob) {
    chrome.runtime.sendMessage({ action: 'NOTES_ERROR', meetingId: id, error: 'No audio captured.', warnings }).catch(() => {});
    return;
  }
  const ctxData = { settings: opts.settings, meta: opts.meta || {} };
  // Keep the full recording in IndexedDB: powers in-dashboard playback, note
  // re-generation with other templates, and retry after AI failures.
  try { await idbPut({ id, audio: audioBlob, video: videoBlob || null, captions: opts.captions || '', settings: opts.settings, meta: opts.meta || {} }); } catch (e) { log('idb put failed: ' + e.message); }
  await idbDel('live-' + id);
  pruneLibrary();
  await transcribeAndReport(id, audioBlob, opts.captions || '', ctxData, warnings);
}

async function retry(opts) {
  const id = opts.meetingId;
  try {
    const rec = await idbGet(id);
    if (!rec || !rec.audio) { chrome.runtime.sendMessage({ action: 'NOTES_ERROR', meetingId: id, error: 'Audio no longer available to retry — please re-record.' }).catch(() => {}); return; }
    // Allow settings (provider/template) to be overridden on retry.
    const settings = opts.settings || rec.settings;
    await transcribeAndReport(id, rec.audio, rec.captions || '', { settings, meta: opts.meta || rec.meta || {} }, []);
  } catch (err) { chrome.runtime.sendMessage({ action: 'NOTES_ERROR', meetingId: id, error: err.message }).catch(() => {}); }
}
