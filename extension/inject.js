// Ghost Recorder — MAIN-world audio-routing guard (declared in manifest.json,
// runs at document_start BEFORE the page's own scripts).
//
// Why: chrome.tabCapture only hears audio played on the DEFAULT output sink.
// Google Meet uses the default sink, but Microsoft Teams (and some others)
// route call audio to a chosen device — via element.setSinkId(), and in newer
// builds via the `new AudioContext({ sinkId })` constructor option. Any of
// those produce a perfectly silent recording. We pin everything to default.

(function () {
  const TAG = '[Ghost Recorder]';

  // 1) HTMLMediaElement.setSinkId -> force default ("")
  if (HTMLMediaElement.prototype.setSinkId) {
    const orig = HTMLMediaElement.prototype.setSinkId;
    HTMLMediaElement.prototype.setSinkId = function () {
      return orig.call(this, '').catch(() => {}); // resolve so the app doesn't crash
    };
    const fix = (el) => { try { if (el.sinkId && el.sinkId !== '') orig.call(el, '').catch(() => {}); } catch (e) { /* */ } };
    // retro-fix anything created before us + keep watching for new media elements
    const sweep = (root) => { try { root.querySelectorAll && root.querySelectorAll('audio,video').forEach(fix); } catch (e) { /* */ } };
    const start = () => {
      sweep(document);
      new MutationObserver((muts) => {
        for (const m of muts) for (const n of m.addedNodes) {
          if (n.nodeType !== 1) continue;
          if (n.tagName === 'AUDIO' || n.tagName === 'VIDEO') fix(n); else sweep(n);
        }
      }).observe(document.documentElement, { childList: true, subtree: true });
    };
    document.documentElement ? start() : document.addEventListener('DOMContentLoaded', start);
  }

  // 2) AudioContext.setSinkId -> force default
  if (window.AudioContext && AudioContext.prototype.setSinkId) {
    const orig = AudioContext.prototype.setSinkId;
    AudioContext.prototype.setSinkId = function () { return orig.call(this, '').catch(() => {}); };
  }

  // 3) new AudioContext({ sinkId: ... }) -> strip the sinkId option (Teams v2 path)
  if (window.AudioContext) {
    const OrigAC = window.AudioContext;
    const Wrapped = function AudioContext(options) {
      if (options && 'sinkId' in options) { options = Object.assign({}, options); delete options.sinkId; }
      return new OrigAC(options);
    };
    Wrapped.prototype = OrigAC.prototype;
    try { Object.defineProperty(Wrapped, 'name', { value: 'AudioContext' }); } catch (e) { /* */ }
    window.AudioContext = Wrapped;
    if (window.webkitAudioContext) window.webkitAudioContext = Wrapped;
  }

  console.log(TAG + ' audio-routing guard active (document_start): call audio pinned to default sink for recording.');
})();
