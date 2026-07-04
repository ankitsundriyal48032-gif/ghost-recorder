// Ghost Recorder — Content Script (runs on all sites)
// - injects audio-sink override + MAIN-world WebRTC hook
// - universally detects "in a call" and offers a dismissible Record suggestion
// - scrapes Google Meet captions (speaker names + timestamps)
// - shows the user-only recording overlay (Stop + live captions)
(function () {
  'use strict';

  // inject.js + inject-webrtc.js now run as MAIN-world content scripts declared in
  // manifest.json at document_start — early enough to catch Teams' audio routing.

  const PLATFORMS = { GOOGLE_MEET: 'google_meet', ZOOM: 'zoom', MS_TEAMS: 'ms_teams', UNKNOWN: 'unknown' };
  function detectPlatform() {
    const u = location.href;
    if (u.includes('meet.google.com')) return PLATFORMS.GOOGLE_MEET;
    if (u.includes('zoom.us')) return PLATFORMS.ZOOM;
    if (u.includes('teams.microsoft.com') || u.includes('teams.live.com') || u.includes('teams.cloud.microsoft')) return PLATFORMS.MS_TEAMS;
    return PLATFORMS.UNKNOWN;
  }
  const platform = detectPlatform();
  chrome.runtime.sendMessage({ action: 'PLATFORM_DETECTED', platform }).catch(() => {});

  // ---- mic permission iframe (grants mic to the extension origin) ----
  function injectMicIframe() {
    if (document.getElementById('ghost-mic-iframe')) return;
    const f = document.createElement('iframe');
    f.id = 'ghost-mic-iframe'; f.src = chrome.runtime.getURL('mic-permission.html'); f.allow = 'microphone';
    f.style.cssText = 'position:fixed;top:-100px;width:1px;height:1px;opacity:0;border:none;';
    (document.body || document.documentElement).appendChild(f);
  }
  let webrtcActive = false;
  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data) return;
    if (e.data.type === 'vmh-webrtc') webrtcActive = !!e.data.active;
    if (e.data.type === 'MIC_PERMISSION_GRANTED') chrome.runtime.sendMessage({ action: 'MIC_READY' }).catch(() => {});
  });

  // ---- universal meeting detection (content-blind: structure only) ----
  const MEETING_HOSTS = [/(^|\.)meet\.google\.com$/, /(^|\.)zoom\.us$/, /(^|\.)teams\.(microsoft|live)\.com$/, /(^|\.)webex\.com$/, /(^|\.)whereby\.com$/, /(^|\.)zoho\.com$/, /(^|\.)around\.co$/, /(^|\.)jit\.si$/, /^8x8\.vc$/, /(^|\.)bluejeans\.com$/, /(^|\.)gotomeeting\.com$/, /(^|\.)goto\.com$/, /(^|\.)gather\.town$/, /(^|\.)chime\.aws$/, /(^|\.)daily\.co$/, /(^|\.)dialpad\.com$/, /(^|\.)ringcentral\.com$/, /^discord\.com$/, /^app\.slack\.com$/];
  const STRONG_PATH = /\/(j|wc|s|meetup-join|meet|webappng|wbxmjs|huddle|call|room)\b|\/[a-z]{3}-[a-z]{4}-[a-z]{3}/i;
  const LEAVE_RE = /leave|hang ?up|end (call|meeting)|disconnect|leave huddle/i;

  function hasLiveVideo() {
    for (const v of document.querySelectorAll('video')) {
      const s = v.srcObject;
      if (s && typeof s.getTracks === 'function' && s.getTracks().some((t) => t.readyState === 'live')) return true;
    }
    return false;
  }
  function hasLeaveControl() {
    for (const el of document.querySelectorAll('button,[role="button"],[aria-label]')) {
      const t = (el.getAttribute('aria-label') || el.textContent || '').slice(0, 40);
      if (LEAVE_RE.test(t)) return true;
    }
    return false;
  }
  function detectMeeting() {
    const urlHit = MEETING_HOSTS.some((re) => re.test(location.host));
    const strongUrl = urlHit && STRONG_PATH.test(location.pathname);
    const liveVideo = hasLiveVideo();
    const leave = hasLeaveControl();
    return (webrtcActive && (liveVideo || leave)) || (liveVideo && leave) || (strongUrl && (liveVideo || webrtcActive || leave));
  }

  // ---- auto-suggest toast ----
  let suggestShown = false, dismissedFor = '';
  const roomKey = () => location.host + location.pathname;
  function showSuggest() {
    if (suggestShown || dismissedFor === roomKey() || document.getElementById('ghost-suggest')) return;
    suggestShown = true;
    const host = document.createElement('div'); host.id = 'ghost-suggest';
    host.style.cssText = 'position:fixed;top:80px;left:50%;transform:translateX(-50%);z-index:2147483647;'; // top-center: clear of bottom control bars
    document.body.appendChild(host);
    const sh = host.attachShadow({ mode: 'closed' });
    sh.innerHTML = `<style>
      .t{display:flex;align-items:center;gap:12px;background:rgba(15,23,42,.96);color:#fff;font-family:'Segoe UI',sans-serif;
        padding:12px 16px;border-radius:12px;box-shadow:0 12px 30px rgba(0,0,0,.5);border:1px solid rgba(255,255,255,.12);font-size:14px;}
      .dot{width:9px;height:9px;border-radius:50%;background:#ef4444;animation:p 1.6s infinite;}
      button{border:0;border-radius:8px;padding:8px 14px;font-weight:700;cursor:pointer;font-size:13px;}
      .rec{background:#2563eb;color:#fff;} .no{background:transparent;color:#94a3b8;}
      @keyframes p{0%{opacity:1}50%{opacity:.3}100%{opacity:1}}</style>
      <div class="t"><span class="dot"></span><span>Looks like you're in a meeting — record it?</span>
        <button class="rec" id="r">Record</button><button class="no" id="n">Not now</button></div>`;
    sh.getElementById('r').onclick = () => {
      host.remove(); suggestShown = false;
      injectMicIframe();
      chrome.runtime.sendMessage({ action: 'START_CAPTURE' }, (res) => {
        if (!res || !res.success) toast('Click the Ghost Recorder toolbar icon to start recording.');
        else if (!res.hasKey) toast('Recording — but add your ' + (res.provider || 'AI') + ' API key in Settings to get notes.');
      });
    };
    sh.getElementById('n').onclick = () => {
      host.remove(); suggestShown = false; dismissedFor = roomKey();
      chrome.storage.local.get('gr_dismiss', ({ gr_dismiss }) => { const m = gr_dismiss || {}; m[location.host] = Date.now(); chrome.storage.local.set({ gr_dismiss: m }); });
    };
  }
  function toast(msg) {
    const d = document.createElement('div');
    d.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);z-index:2147483647;background:#1e293b;color:#fff;padding:12px 18px;border-radius:10px;font-family:Segoe UI,sans-serif;font-size:13px;box-shadow:0 10px 24px rgba(0,0,0,.5);';
    d.textContent = msg; document.body.appendChild(d); setTimeout(() => d.remove(), 6000);
  }

  let detectTries = 0, detectTimer = null;
  function watchForMeeting() {
    chrome.storage.local.get(['settings', 'isRecording', 'gr_dismiss'], ({ settings, isRecording, gr_dismiss }) => {
      if (settings && settings.autoSuggest === false) return;
      if (isRecording) return;
      const d = (gr_dismiss || {})[location.host];
      if (d && (Date.now() - d) < 8 * 3600 * 1000) return; // dismissed for this site in the last 8h
      const tick = () => {
        if (detectMeeting()) { showSuggest(); return; }
        if (detectTries++ < 40) detectTimer = setTimeout(tick, 2500); // ~100s of polling then stop
      };
      tick();
    });
  }
  if (document.readyState === 'complete' || document.readyState === 'interactive') watchForMeeting();
  else window.addEventListener('DOMContentLoaded', watchForMeeting);

  // ---- recording overlay (Shadow DOM) ----
  let shadow = null, panel = null, transcriptBox = null;
  const overlayLines = [];
  function createUI() {
    if (document.getElementById('ghost-recorder-ui')) return;
    const host = document.createElement('div'); host.id = 'ghost-recorder-ui';
    host.style.cssText = 'position:fixed;bottom:20px;right:20px;z-index:2147483647;';
    document.body.appendChild(host);
    shadow = host.attachShadow({ mode: 'closed' });
    shadow.innerHTML = `<style>
      .panel{background:rgba(15,23,42,.92);backdrop-filter:blur(10px);border:1px solid rgba(255,255,255,.12);border-radius:12px;color:#fff;font-family:'Segoe UI',sans-serif;width:320px;box-shadow:0 10px 25px rgba(0,0,0,.5);overflow:hidden;display:none;flex-direction:column;}
      .header{padding:10px 15px;background:rgba(255,255,255,.06);font-weight:600;font-size:14px;display:flex;align-items:center;gap:8px;cursor:move;user-select:none;}
      .dot{width:8px;height:8px;border-radius:50%;background:#ef4444;animation:p 2s infinite;}
      .time{color:#94a3b8;font-weight:600;font-size:12px;font-variant-numeric:tabular-nums;}
      .stop{margin-left:auto;background:#ef4444;color:#fff;border:0;border-radius:6px;padding:5px 10px;font-weight:700;cursor:pointer;font-size:12px;}
      .pause{background:#334155;color:#fff;border:0;border-radius:6px;padding:5px 10px;font-weight:700;cursor:pointer;font-size:12px;}
      .min{background:transparent;color:#94a3b8;border:0;font-weight:700;cursor:pointer;font-size:14px;padding:2px 6px;}
      .bubble{display:none;width:30px;height:30px;border-radius:50%;background:rgba(15,23,42,.85);border:2px solid #ef4444;align-items:center;justify-content:center;cursor:pointer;font-size:15px;box-shadow:0 4px 14px rgba(0,0,0,.4);animation:p 2s infinite;}
      .content{padding:12px 15px;max-height:200px;overflow-y:auto;font-size:13px;line-height:1.5;color:#cbd5e1;white-space:pre-wrap;}
      .hint{font-size:11px;color:#64748b;padding:0 15px 10px;}
      @keyframes p{0%{box-shadow:0 0 0 0 rgba(239,68,68,.7)}70%{box-shadow:0 0 0 6px rgba(239,68,68,0)}100%{box-shadow:0 0 0 0 rgba(239,68,68,0)}}</style>
      <div class="bubble" id="bubble" title="Ghost Recorder — recording. Click to expand.">👻</div>
      <div class="panel" id="panel"><div class="header" id="hdr"><div class="dot" id="dot"></div>Ghost AI Notes<span class="time" id="tm">00:00</span><button class="pause" id="pause">⏸</button><button class="stop" id="stop">Stop</button><button class="min" id="min" title="Minimize — keeps the overlay out of the recording">—</button></div>
      <div class="content" id="t">Listening… AI transcribes the full audio — CC only adds speaker names.</div><div class="hint" id="aud"></div><div class="hint" id="mic"></div><div class="hint" id="h"></div></div>`;
    panel = shadow.getElementById('panel'); transcriptBox = shadow.getElementById('t');
    shadow.getElementById('stop').onclick = () => {
      chrome.runtime.sendMessage({ action: 'STOP_CAPTURE' });
      toast('✓ Recording saved — AI is writing your notes. Open them via the Ghost Recorder icon → 📋 Meetings.');
    };
    let paused = false, pausedAtMs = 0;
    shadow.getElementById('pause').onclick = () => {
      paused = !paused;
      chrome.runtime.sendMessage({ action: paused ? 'PAUSE_CAPTURE' : 'RESUME_CAPTURE' });
      shadow.getElementById('pause').textContent = paused ? '▶' : '⏸';
      const d = shadow.getElementById('dot'); if (d) d.style.animationPlayState = paused ? 'paused' : 'running';
      if (paused) { pausedAtMs = Date.now(); stopOverlayTimer(); }
      else { startMs += Date.now() - pausedAtMs; startOverlayTimer(); }
      setHint(paused ? 'Paused — nothing is being recorded.' : '');
    };
    // Minimize to a tiny dot — the overlay is part of the page, so it appears in
    // the recorded video; minimized keeps recordings clean. State remembered.
    const bubble = shadow.getElementById('bubble');
    const setMin = (min) => {
      panel.style.display = min ? 'none' : 'flex';
      bubble.style.display = min ? 'flex' : 'none';
      chrome.storage.local.set({ gr_overlay_min: min });
    };
    shadow.getElementById('min').onclick = () => setMin(true);
    bubble.onclick = () => setMin(false);
    chrome.storage.local.get('gr_overlay_min', ({ gr_overlay_min }) => { if (gr_overlay_min) setMin(true); });

    // Draggable: the overlay must never be stuck covering meeting controls.
    const hdr = shadow.getElementById('hdr');
    hdr.addEventListener('mousedown', (e) => {
      if (e.target.id === 'stop') return;
      e.preventDefault();
      const r = host.getBoundingClientRect();
      const dx = e.clientX - r.left, dy = e.clientY - r.top;
      const move = (ev) => {
        host.style.left = Math.max(0, Math.min(window.innerWidth - r.width, ev.clientX - dx)) + 'px';
        host.style.top = Math.max(0, Math.min(window.innerHeight - 40, ev.clientY - dy)) + 'px';
        host.style.right = 'auto'; host.style.bottom = 'auto';
      };
      const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
      window.addEventListener('mousemove', move); window.addEventListener('mouseup', up);
    });
  }
  let overlayTimer = null;
  function startOverlayTimer() {
    stopOverlayTimer();
    const el = shadow && shadow.getElementById('tm');
    if (!el) return;
    const tick = () => { const s = Math.max(0, Math.floor((Date.now() - startMs) / 1000)); el.textContent = String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0'); };
    tick(); overlayTimer = setInterval(tick, 1000);
  }
  function stopOverlayTimer() { if (overlayTimer) { clearInterval(overlayTimer); overlayTimer = null; } }
  function setHint(t) { if (shadow) { const h = shadow.getElementById('h'); if (h) h.textContent = t; } }
  function showOverlayLine(line) { if (!transcriptBox) return; overlayLines.push(line); while (overlayLines.length > 6) overlayLines.shift(); transcriptBox.textContent = overlayLines.join('\n'); transcriptBox.scrollTop = transcriptBox.scrollHeight; }

  // ---- Google Meet caption scraper ----
  let captionObserver = null, startMs = 0; const finalized = new Map();
  function mmss() { const s = Math.max(0, Math.floor((Date.now() - startMs) / 1000)); return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0'); }
  function tryEnableCaptions() {
    if (platform !== PLATFORMS.GOOGLE_MEET) return; // auto-clicking menus on Teams/Zoom is too risky
    const b = document.querySelector('button[aria-label*="aptions" i],button[aria-label*="ubtitle" i]');
    if (b && /turn on|enable|off/i.test(b.getAttribute('aria-label') || '')) { try { b.click(); } catch (e) { /* */ } }
  }
  function findCaptionRegion() {
    if (platform === PLATFORMS.MS_TEAMS) {
      return document.querySelector('[data-tid*="closed-caption" i]') || document.querySelector('[class*="closed-caption" i]') || document.querySelector('[class*="ClosedCaption"]');
    }
    if (platform === PLATFORMS.ZOOM) {
      return document.querySelector('#live-transcription-subtitle') || document.querySelector('[class*="live-transcription" i]') || document.querySelector('[aria-label*="captions" i]');
    }
    return document.querySelector('[role="region"][aria-label*="aptions" i]') || document.querySelector('div[aria-label*="aptions" i]') || document.querySelector('.a4cQT');
  }
  function scrapeRegion(region) {
    const rows = region.querySelectorAll(':scope > div, [data-message-id], .nMcdL, .TBMuR');
    (rows.length ? rows : [region]).forEach((row) => {
      const img = row.querySelector('img');
      let speaker = ((img && img.alt) || ((row.querySelector('.zs7s8d, .KcIKyf, [data-self-name]') || {}).textContent) || '').trim();
      let text = '';
      row.querySelectorAll('div,span').forEach((el) => { const t = (el.textContent || '').trim(); if (t && t !== speaker && t.length > text.length) text = t; });
      if (!text) text = (row.textContent || '').trim();
      if (speaker && text.startsWith(speaker)) text = text.slice(speaker.length).trim();
      if (!text || text.length < 2) return;
      if (!row.dataset.ghostKey) row.dataset.ghostKey = String(row.offsetTop) + ':' + speaker;
      const key = row.getAttribute('data-message-id') || row.dataset.ghostKey;
      clearTimeout(row.__ghostT);
      row.__ghostT = setTimeout(() => {
        if (finalized.get(key) === text) return;
        finalized.set(key, text);
        const line = `[${mmss()}] ${speaker || 'Speaker'}: ${text}`;
        chrome.runtime.sendMessage({ action: 'CAPTION', line }).catch(() => {});
        showOverlayLine(line);
      }, 1200);
    });
  }
  function startCaptionScraper() {
    if (platform === PLATFORMS.UNKNOWN) { setHint('AI transcribes the audio; speaker names come from voices.'); return; }
    tryEnableCaptions(); let tries = 0;
    const tick = () => {
      const region = findCaptionRegion();
      if (region) { captionObserver = new MutationObserver(() => scrapeRegion(region)); captionObserver.observe(region, { childList: true, subtree: true, characterData: true }); scrapeRegion(region); setHint('Captions connected — real speaker names on.'); return; }
      if (tries++ < 20) { tryEnableCaptions(); setTimeout(tick, 2500); } else setHint('Turn on captions/CC for real speaker names (AI still transcribes the audio).');
    };
    tick();
  }
  function stopCaptionScraper() { if (captionObserver) { captionObserver.disconnect(); captionObserver = null; } finalized.clear(); }

  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'SHOW_UI') {
      startMs = Date.now(); createUI(); injectMicIframe(); startOverlayTimer(); startCaptionScraper();
      chrome.storage.local.get('gr_overlay_min', ({ gr_overlay_min }) => {
        if (!shadow) return;
        const b = shadow.getElementById('bubble');
        if (gr_overlay_min && b) { b.style.display = 'flex'; if (panel) panel.style.display = 'none'; }
        else if (panel) panel.style.display = 'flex';
      });
      const sg = document.getElementById('ghost-suggest'); if (sg) sg.remove();
      sendResponse({ success: true });
    } else if (request.action === 'HIDE_UI') {
      stopCaptionScraper(); stopOverlayTimer();
      if (panel) panel.style.display = 'none';
      if (shadow) { const b = shadow.getElementById('bubble'); if (b) b.style.display = 'none'; }
      sendResponse({ success: true });
    } else if (request.action === 'MIC_STATUS') {
      if (shadow) { const m = shadow.getElementById('mic'); if (m) { m.textContent = request.connected ? '🎤 Your voice: recording' : '⚠ Your voice NOT captured — Enable mic in Settings'; m.style.color = request.connected ? '#34d399' : '#fca5a5'; } }
    } else if (request.action === 'AUDIO_STATUS') {
      if (shadow) { const a = shadow.getElementById('aud'); if (a) { a.textContent = request.ok ? '' : '⚠ ' + (request.text || 'No meeting audio detected'); a.style.color = '#fca5a5'; } }
    }
    return false;
  });
})();
