/*
 * PerSite Volume: bridge between the service worker and the page engine.
 *
 * Runs in the extension's isolated world of every frame at document_start.
 * It asks the service worker which volume applies to the tab and passes it to
 * engine.js (MAIN world) over DOM events.
 */
(() => {
  'use strict';

  const CMD = 'persitevolume:cmd';
  const REPORT = 'persitevolume:report';

  // Injected again after an update: the old copy can no longer reach the
  // extension, so it steps aside.
  const previous = globalThis.__persitevolumeBridge;
  if (previous) {
    try {
      previous.dispose();
    } catch {
      // Already gone.
    }
  }

  let gain = null;
  let lastStatus = null;
  let disposed = false;

  const alive = () => !disposed && Boolean(globalThis.chrome?.runtime?.id);

  function toEngine(message) {
    window.dispatchEvent(new CustomEvent(CMD, { detail: JSON.stringify(message) }));
  }

  function applyGain(value) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return;
    gain = value;
    toEngine({ type: 'gain', gain });
  }

  function onReport(event) {
    if (!alive()) {
      dispose();
      return;
    }
    let message;
    try {
      message = JSON.parse(event.detail);
    } catch {
      return;
    }
    if (message?.type === 'ready') {
      if (gain !== null) toEngine({ type: 'gain', gain });
    } else if (message?.type === 'status') {
      lastStatus = message.status;
    }
  }

  function onMessage(message) {
    if (message?.type === 'apply') applyGain(message.gain);
  }

  // The site whose setting applies is the tab's, even inside a cross-origin
  // iframe. The service worker falls back to the tab URL when this is null.
  function topLevelUrl() {
    if (window === window.top) return location.href;
    try {
      return window.top.location.href;
    } catch {
      // Cross-origin parent.
    }
    const ancestors = location.ancestorOrigins;
    const top = ancestors?.length ? ancestors[ancestors.length - 1] : null;
    return top && top !== 'null' ? top : null;
  }

  async function hello() {
    if (!alive()) return;
    try {
      const reply = await chrome.runtime.sendMessage({ type: 'hello', top: topLevelUrl() });
      applyGain(reply?.gain);
    } catch {
      // The extension is reloading or the tab is going away.
    }
  }

  function onPageShow(event) {
    // Back/forward cache: settings may have changed while the page was hidden.
    if (event.persisted) hello();
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    window.removeEventListener(REPORT, onReport);
    window.removeEventListener('pageshow', onPageShow);
    document.removeEventListener('prerenderingchange', hello);
    try {
      chrome.runtime.onMessage.removeListener(onMessage);
    } catch {
      // Context already invalidated.
    }
  }

  window.addEventListener(REPORT, onReport);
  window.addEventListener('pageshow', onPageShow);
  document.addEventListener('prerenderingchange', hello);
  chrome.runtime.onMessage.addListener(onMessage);

  globalThis.__persitevolumeBridge = {
    // Read by the popup through chrome.scripting. The engine answers
    // synchronously, so the status is current.
    status() {
      lastStatus = null;
      toEngine({ type: 'status' });
      return lastStatus && { ...lastStatus, top: window === window.top };
    },
    dispose,
  };

  toEngine({ type: 'ping' });
  hello();
})();
