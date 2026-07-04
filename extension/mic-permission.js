// This script runs in the invisible iframe injected by the content script.
// Its sole purpose is to request microphone permission from the user.

async function requestMicPermission() {
    try {
        // Request the microphone. This will trigger the browser's native permission prompt.
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        
        // If we get here, permission was granted!
        console.log("[Ghost Recorder] Microphone permission granted.");
        
        // We don't actually need to keep the stream open here.
        // We just needed the permission. The offscreen document will do the actual recording.
        stream.getTracks().forEach(track => track.stop());
        
        // Notify the content script (parent window) that we succeeded
        window.parent.postMessage({ type: 'MIC_PERMISSION_GRANTED' }, '*');
        
    } catch (err) {
        console.error("[Ghost Recorder] Microphone permission denied:", err);
        window.parent.postMessage({ type: 'MIC_PERMISSION_DENIED', error: err.message }, '*');
    }
}

// Request immediately when the iframe loads
requestMicPermission();
