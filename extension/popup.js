const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const statusText = document.getElementById('statusText');
const timer = document.getElementById('timer');
const videoToggle = document.getElementById('videoToggle');
const dashLink = document.getElementById('dashLink');
const settingsLink = document.getElementById('settingsLink');

let timerInterval = null;

dashLink.onclick = (e) => { e.preventDefault(); chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html') }); };
settingsLink.onclick = (e) => { e.preventDefault(); chrome.tabs.create({ url: chrome.runtime.getURL('options.html') }); };

// Mic status — your voice is only recorded if mic is granted to the extension origin.
const micStatus = document.getElementById('micStatus');
try {
  navigator.permissions.query({ name: 'microphone' }).then((p) => {
    const render = () => {
      if (p.state === 'granted') { micStatus.innerHTML = '🎤 Mic enabled — your voice is recorded'; micStatus.style.color = '#34d399'; }
      else { micStatus.innerHTML = '🎤 <a href="#" id="micLink" style="color:#fbbf24">Enable mic</a> to record your voice'; const l = document.getElementById('micLink'); if (l) l.onclick = (e) => { e.preventDefault(); chrome.tabs.create({ url: chrome.runtime.getURL('options.html') }); }; }
    };
    render(); p.onchange = render;
  }).catch(() => {});
} catch (e) { /* permissions API unavailable */ }

// Show WHICH tab will be recorded (and block unrecordable browser pages) so the
// user never silently records the wrong thing.
const tabInfo = document.getElementById('tabInfo');
const UNRECORDABLE = /^(chrome|edge|about|devtools|view-source|chrome-extension):|^https:\/\/(chrome\.google\.com\/webstore|chromewebstore\.google\.com)/i;
chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
  chrome.storage.local.get('isRecording', ({ isRecording }) => {
    if (isRecording || !tab) return;
    if (UNRECORDABLE.test(tab.url || '')) {
      tabInfo.textContent = "⚠ This page can't be recorded — open your meeting tab.";
      tabInfo.style.color = '#fbbf24';
      startBtn.disabled = true; startBtn.style.opacity = '.5';
    } else {
      tabInfo.textContent = '⏺ Will record: ' + (tab.title || 'this tab');
      tabInfo.title = tab.title || '';
    }
  });
});

// Restore recording state + the video preference (stored in settings).
chrome.storage.local.get(['isRecording', 'startTime', 'settings'], (result) => {
  const s = result.settings || {};
  if (result.isRecording) { setRecordingUI(); startTimer(result.startTime); }
  else {
    const prov = s.provider || 'gemini';
    const key = prov === 'custom' ? (s.keys && s.keys.custom) : (s.keys && s.keys[prov]);
    if (!key) {
      statusText.innerHTML = 'First, <a href="#" id="setupLink" style="color:#38bdf8">add your AI key in Settings</a>.';
      const l = document.getElementById('setupLink'); if (l) l.onclick = (e) => { e.preventDefault(); chrome.tabs.create({ url: chrome.runtime.getURL('options.html') }); };
    }
  }
  videoToggle.checked = (s.videoEnabled !== false);
});

// Persist the video toggle into settings (shared with the options page + background).
videoToggle.addEventListener('change', () => {
  chrome.storage.local.get('settings', ({ settings }) => {
    chrome.storage.local.set({ settings: Object.assign({ videoEnabled: true }, settings || {}, { videoEnabled: videoToggle.checked }) });
  });
});

startBtn.onclick = async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) { statusText.innerText = 'No active tab found'; return; }
  chrome.runtime.sendMessage({ action: 'START_CAPTURE', tabId: tab.id }, (response) => {
    if (response?.success) {
      setRecordingUI();
      const now = Date.now();
      chrome.storage.local.set({ startTime: now });
      startTimer(now);
      if (!response.hasKey) {
        statusText.innerHTML = '⚠ Recording — but add your <a href="#" id="setupLink" style="color:#fbbf24">' + (response.provider || 'AI') + ' key in Settings</a> to get notes.';
        const l = document.getElementById('setupLink'); if (l) l.onclick = (e) => { e.preventDefault(); chrome.tabs.create({ url: chrome.runtime.getURL('options.html') }); };
      }
    } else {
      statusText.innerText = 'Error: ' + (response?.error || 'Unknown');
    }
  });
};

stopBtn.onclick = () => {
  chrome.runtime.sendMessage({ action: 'STOP_CAPTURE' }, (response) => {
    if (response?.success) { setStoppedUI(); if (timerInterval) clearInterval(timerInterval); }
  });
};

const recRow = document.getElementById('recRow');
const pauseBtn = document.getElementById('pauseBtn');
let popupPaused = false;
pauseBtn.onclick = () => {
  popupPaused = !popupPaused;
  chrome.runtime.sendMessage({ action: popupPaused ? 'PAUSE_CAPTURE' : 'RESUME_CAPTURE' }, () => {
    pauseBtn.textContent = popupPaused ? '▶ Resume' : '⏸ Pause';
    statusText.innerHTML = popupPaused ? '⏸ Paused — nothing is being recorded' : '<span class="pulse"></span> Recording meeting...';
    if (popupPaused) { if (timerInterval) clearInterval(timerInterval); }
    else chrome.storage.local.get('startTime', ({ startTime }) => startTimer(startTime));
  });
};

function setRecordingUI() {
  tabInfo.textContent = '';
  startBtn.style.display = 'none';
  recRow.style.display = 'flex';
  videoToggle.disabled = true;
  timer.style.display = 'block';
  statusText.innerHTML = '<span class="pulse"></span> Recording meeting...';
  chrome.runtime.sendMessage({ action: 'GET_STATE' }, (s) => {
    if (s && s.pausedAt) { popupPaused = true; pauseBtn.textContent = '▶ Resume'; statusText.innerHTML = '⏸ Paused'; if (timerInterval) clearInterval(timerInterval); }
  });
}

function setStoppedUI() {
  startBtn.style.display = 'block';
  recRow.style.display = 'none';
  popupPaused = false; pauseBtn.textContent = '⏸ Pause';
  videoToggle.disabled = false;
  timer.style.display = 'none';
  statusText.innerText = 'Saved. AI is writing notes — see 📋 Meetings.';
}

function startTimer(startTime) {
  if (timerInterval) clearInterval(timerInterval);
  const tick = () => {
    const elapsed = Math.floor((Date.now() - startTime) / 1000);
    const mins = String(Math.floor(elapsed / 60)).padStart(2, '0');
    const secs = String(elapsed % 60).padStart(2, '0');
    timer.textContent = `${mins}:${secs}`;
  };
  tick();
  timerInterval = setInterval(tick, 1000);
}
