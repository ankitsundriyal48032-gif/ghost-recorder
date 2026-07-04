// Ghost Recorder — MAIN-world WebRTC hook.
// Runs in the page context (injected via <script> by the content script) so it can
// see the page's own getUserMedia / RTCPeerConnection. It only posts a boolean
// "are we in a live call" signal back to the content script — no page data is read.
(function () {
  if (window.__ghostWebrtcHook) return;
  window.__ghostWebrtcHook = true;
  const flag = (active) => { try { window.postMessage({ type: 'vmh-webrtc', active: !!active }, '*'); } catch (e) { /* */ } };

  try {
    const md = navigator.mediaDevices;
    if (md && md.getUserMedia) {
      const orig = md.getUserMedia.bind(md);
      md.getUserMedia = function (c) {
        return orig(c).then((s) => { try { if (s.getTracks().some((t) => t.readyState === 'live')) flag(true); } catch (e) { /* */ } return s; });
      };
    }
  } catch (e) { /* */ }

  try {
    const RPC = window.RTCPeerConnection;
    if (RPC) {
      const Wrapped = function (...a) {
        const pc = new RPC(...a);
        const check = () => { if (pc.connectionState === 'connected' || pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') flag(true); };
        pc.addEventListener('connectionstatechange', check);
        pc.addEventListener('iceconnectionstatechange', check);
        return pc;
      };
      Wrapped.prototype = RPC.prototype;
      window.RTCPeerConnection = Wrapped;
    }
  } catch (e) { /* */ }
})();
