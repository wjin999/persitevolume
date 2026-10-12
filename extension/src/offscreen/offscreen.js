// Enhanced mode: plays the captured audio of tabs back at their volume.
// A captured tab is silent by itself, so everything it plays goes through here.

const RAMP_SECONDS = 0.01;
const captures = new Map(); // tabId -> { stream, source, node }
let context = null;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Only the service worker and extension pages, never content scripts.
  const fromExtension = sender.id === chrome.runtime.id && Boolean(sender.url?.startsWith(chrome.runtime.getURL('')));
  if (message?.target !== 'offscreen' || !fromExtension) return false;
  handle(message).then(sendResponse, (error) => sendResponse({ ok: false, error: String(error?.message ?? error) }));
  return true;
});

async function handle(message) {
  switch (message.type) {
    case 'start':
      await start(message);
      return { ok: true };
    case 'gain':
      setGain(message.tabId, message.gain);
      return { ok: true };
    case 'stop':
      stop(message.tabId);
      return { ok: true };
    case 'list':
      return { ok: true, tabs: [...captures.keys()] };
    case 'level':
      return { ok: true, level: await level(message.tabId) };
    default:
      return { ok: false, error: `Unknown request: ${message.type}` };
  }
}

async function start({ tabId, streamId, gain }) {
  stop(tabId);
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } },
    video: false,
  });
  context ??= new AudioContext();
  if (context.state !== 'running') await context.resume();
  const source = context.createMediaStreamSource(stream);
  const node = context.createGain();
  node.gain.value = gain;
  source.connect(node).connect(context.destination);
  // Ends when the tab closes or Chrome stops the capture.
  stream.getAudioTracks()[0]?.addEventListener('ended', () => {
    if (captures.get(tabId)?.stream !== stream) return;
    stop(tabId);
    chrome.runtime.sendMessage({ type: 'captureEnded', tabId }).catch(() => {});
  });
  captures.set(tabId, { stream, source, node });
}

function setGain(tabId, gain) {
  const capture = captures.get(tabId);
  if (!capture || !(gain >= 0)) return;
  const param = capture.node.gain;
  const now = context.currentTime;
  param.cancelScheduledValues(now);
  param.setTargetAtTime(gain, now, RAMP_SECONDS);
}

function stop(tabId) {
  const capture = captures.get(tabId);
  if (!capture) return;
  captures.delete(tabId);
  capture.source.disconnect();
  capture.node.disconnect();
  for (const track of capture.stream.getTracks()) track.stop();
}

// Output level (RMS) of a captured tab after our gain, for diagnostics.
async function level(tabId, duration = 400) {
  const capture = captures.get(tabId);
  if (!capture) return null;
  const analyser = context.createAnalyser();
  analyser.fftSize = 2048;
  capture.node.connect(analyser);
  const samples = new Float32Array(analyser.fftSize);
  let sum = 0;
  let count = 0;
  const end = performance.now() + duration;
  while (performance.now() < end) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    analyser.getFloatTimeDomainData(samples);
    for (const sample of samples) sum += sample * sample;
    count += samples.length;
  }
  capture.node.disconnect(analyser);
  return Math.sqrt(sum / count);
}
