/*
 * PerSite Volume: page audio engine.
 *
 * Runs in the MAIN world of every frame at document_start, before any page
 * script, so it can hook the media and Web Audio APIs. It never talks to the
 * extension itself: bridge.js (isolated world) relays the volume over DOM
 * events carrying JSON strings.
 *
 *   below 100 %   the real volume of each media element is scaled, while the
 *                 page keeps reading back the value it set, so the site's own
 *                 volume control keeps working on top of ours.
 *   above 100 %   playing media is routed through a Web Audio gain node; that
 *                 is the only way to amplify past 100 %.
 *   Web Audio     every connection the page makes to a realtime
 *                 AudioContext's destination goes through a gain node of ours.
 */
(() => {
  'use strict';

  const ENGINE = Symbol.for('persitevolume.engine');
  const CMD = 'persitevolume:cmd';
  const REPORT = 'persitevolume:report';
  const PROTOCOL = 1;
  const MAX_GAIN = 10;
  const RAMP_SECONDS = 0.02;
  // Chrome keeps showing a tab as playing for a moment after a short sound.
  const RECENT_MS = 3000;

  // A same-origin navigation away from an initial about:blank document keeps
  // the Window, and with it our hooks; only the listeners need re-attaching.
  const existing = window[ENGINE];
  if (existing) {
    try {
      existing.attach();
    } catch {
      // Not ours; nothing sensible to do.
    }
    return;
  }

  const AudioContextClass = window.AudioContext;
  const MediaElement = window.HTMLMediaElement;
  if (typeof AudioContextClass !== 'function' || typeof MediaElement !== 'function') return;

  // Natives, captured before page scripts get a chance to wrap them.
  const { apply, construct } = Reflect;
  const call = (fn, self, ...args) => apply(fn, self, args);
  const mediaProto = MediaElement.prototype;
  const nodeProto = AudioNode.prototype;
  const contextProto = AudioContextClass.prototype;
  const volumeDescriptor = Object.getOwnPropertyDescriptor(mediaProto, 'volume');
  const getVolume = volumeDescriptor.get;
  const setVolume = volumeDescriptor.set;
  const nativePlay = mediaProto.play;
  const nativeCaptureStream = mediaProto.captureStream;
  const nativeConnect = nodeProto.connect;
  const nativeDisconnect = nodeProto.disconnect;
  const nativeCreateGain = BaseAudioContext.prototype.createGain;
  const nativeCreateElementSource = contextProto.createMediaElementSource;
  const nativeCreateStreamDestination = contextProto.createMediaStreamDestination;
  const nativeCreateStreamSource = contextProto.createMediaStreamSource;
  const NativeElementSourceNode = window.MediaElementAudioSourceNode;
  const DestinationNode = window.AudioDestinationNode;
  const NativeMediaStream = window.MediaStream;
  const NativeCustomEvent = window.CustomEvent;
  const NativeEvent = window.Event;
  const NativeWeakRef = window.WeakRef;
  const nativeAttachShadow = Element.prototype.attachShadow;
  const addListener = EventTarget.prototype.addEventListener;
  const removeListener = EventTarget.prototype.removeEventListener;
  const dispatch = EventTarget.prototype.dispatchEvent;
  const queryDocument = Document.prototype.querySelectorAll;
  const queryFragment = DocumentFragment.prototype.querySelectorAll;
  const getTracks = NativeMediaStream.prototype.getTracks;
  const stopTrack = MediaStreamTrack.prototype.stop;
  const setTimer = window.setTimeout;
  const now = Date.now;
  const { stringify, parse } = JSON;
  const noop = () => {};

  // loadstart: catch media before it can play, so it already starts quieter.
  const DISCOVERY_EVENTS = ['loadstart', 'play', 'playing'];
  const ELEMENT_EVENTS = ['playing', 'loadedmetadata', 'emptied', 'volumechange', 'pause', 'ended'];
  const GESTURE_EVENTS = ['pointerdown', 'pointerup', 'mousedown', 'keydown', 'touchend', 'click'];
  const GESTURE_OPTIONS = { capture: true, passive: true };

  let gain = 1;
  let context = null; // ours, created on the first boost
  let master = null; // gain node in `context` every boosted element feeds
  let contextFailed = false;
  let waitingForGesture = false;

  const seen = new WeakSet();
  const elements = new Set(); // WeakRef<HTMLMediaElement>
  const roots = new Set(); // WeakRef<ShadowRoot>
  const scaled = new WeakMap(); // element -> the volume the page believes it has
  const routed = new WeakMap(); // element -> our MediaElementAudioSourceNode
  const handedOver = new WeakMap(); // element -> MediaStream fed to the page's graph
  const pageOwned = new WeakSet(); // elements the page feeds into its own graph
  const foreign = new WeakSet(); // elements wired into a graph we cannot see
  const blocked = new WeakMap(); // element -> why it cannot be boosted right now
  const verdicts = new WeakMap(); // element -> whether its media is cross-origin
  const stoppedAt = new WeakMap(); // element -> when it last stopped playing
  const pageMasters = new WeakMap(); // page AudioContext -> our gain node in front of its destination
  const pageMasterRefs = new Set(); // WeakRef<GainNode>

  function* live(refs) {
    for (const ref of refs) {
      const value = ref.deref();
      if (value === undefined) refs.delete(ref);
      else yield value;
    }
  }

  // A short linear ramp avoids clicks. Chrome skips nodes that have nothing to
  // play (a page between two short sound effects) and only advances
  // setTargetAtTime() while processing, so the next sound would start out at
  // the old volume; a linear ramp is worked out from the clock instead.
  function rampTo(node, value) {
    const param = node.gain;
    try {
      const now = node.context.currentTime;
      param.cancelScheduledValues(now);
      param.setValueAtTime(param.value, now);
      param.linearRampToValueAtTime(value, now + RAMP_SECONDS);
    } catch {
      param.value = value;
    }
  }

  // ---- volume below 100 %: scale the element's real volume ----

  function applyScale(element) {
    let wanted = scaled.get(element);
    if (wanted === undefined) {
      wanted = call(getVolume, element);
      scaled.set(element, wanted);
    }
    const real = wanted * gain;
    if (call(getVolume, element) !== real) call(setVolume, element, real);
  }

  function releaseScale(element) {
    const wanted = scaled.get(element);
    if (wanted === undefined) return;
    scaled.delete(element);
    if (call(getVolume, element) !== wanted) call(setVolume, element, wanted);
  }

  const volumeShim = {
    get volume() {
      const wanted = scaled.get(this);
      return wanted === undefined ? call(getVolume, this) : wanted;
    },
    set volume(value) {
      if (!scaled.has(this)) {
        call(setVolume, this, value);
        return;
      }
      const wanted = +value;
      if (!(wanted >= 0 && wanted <= 1)) {
        // Let the browser throw exactly the error it normally would.
        call(setVolume, this, value);
        scaled.set(this, call(getVolume, this));
        applyScale(this);
        return;
      }
      const changed = scaled.get(this) !== wanted;
      scaled.set(this, wanted);
      const real = wanted * gain;
      if (call(getVolume, this) !== real) {
        call(setVolume, this, real);
      } else if (changed) {
        // The real volume did not move (we are at 0 %), but the page expects
        // to hear about its change.
        call(setTimer, window, () => call(dispatch, this, new NativeEvent('volumechange')), 0);
      }
    },
  };
  const shimDescriptor = Object.getOwnPropertyDescriptor(volumeShim, 'volume');
  Object.defineProperty(mediaProto, 'volume', {
    configurable: volumeDescriptor.configurable,
    enumerable: volumeDescriptor.enumerable,
    get: shimDescriptor.get,
    set: shimDescriptor.set,
  });

  // ---- volume above 100 %: route through Web Audio ----

  // Web Audio outputs silence for cross-origin media loaded without CORS.
  // captureStream() applies the same check and throws instead.
  function probeCrossOrigin(element) {
    if (typeof nativeCaptureStream !== 'function') return false;
    try {
      const stream = call(nativeCaptureStream, element);
      for (const track of call(getTracks, stream)) call(stopTrack, track);
      return false;
    } catch (error) {
      return !!error && error.name === 'SecurityError';
    }
  }

  function isCrossOrigin(element) {
    let verdict = verdicts.get(element);
    if (verdict === undefined) {
      verdict = probeCrossOrigin(element);
      verdicts.set(element, verdict);
    }
    return verdict;
  }

  function contextRunning() {
    if (!context) {
      try {
        context = new AudioContextClass();
      } catch {
        contextFailed = true;
        return false;
      }
      contextFailed = false;
      master = call(nativeCreateGain, context);
      master.gain.value = gain;
      call(nativeConnect, master, context.destination);
      call(addListener, context, 'statechange', onContextStateChange);
    }
    const { state } = context;
    if (state === 'running') return true;
    if (state !== 'closed') context.resume().then(noop, noop);
    return false;
  }

  function onContextStateChange() {
    const { state } = context;
    if (state === 'running') {
      stopWaitingForGesture();
      refresh();
    } else if (state !== 'closed') {
      waitForGesture();
    }
  }

  // An AudioContext may only start after the user interacted with the page.
  function waitForGesture() {
    if (waitingForGesture) return;
    waitingForGesture = true;
    for (const type of GESTURE_EVENTS) call(addListener, window, type, onGesture, GESTURE_OPTIONS);
  }

  function stopWaitingForGesture() {
    if (!waitingForGesture) return;
    waitingForGesture = false;
    for (const type of GESTURE_EVENTS) call(removeListener, window, type, onGesture, GESTURE_OPTIONS);
  }

  function onGesture() {
    if (context && context.state !== 'running' && context.state !== 'closed') {
      context.resume().then(noop, noop);
    }
  }

  function boostBlocker(element) {
    if (element.sinkId) return 'device';
    if (element.srcObject instanceof NativeMediaStream) return 'stream';
    if (element.readyState < 1) return 'loading'; // origin not known yet
    if (isCrossOrigin(element)) return 'cors';
    if (!contextRunning()) return contextFailed ? 'unavailable' : 'gesture';
    return null;
  }

  function route(element) {
    let source;
    try {
      source = call(nativeCreateElementSource, context, element);
    } catch {
      foreign.add(element);
      return;
    }
    call(nativeConnect, source, master);
    routed.set(element, source);
  }

  // ---- per-element decision ----

  // `starting`: the page is calling play() right now.
  function update(element, starting = false) {
    if (foreign.has(element)) return;
    if (pageOwned.has(element) || routed.has(element)) {
      releaseScale(element);
      return;
    }
    if (gain < 1) {
      blocked.delete(element);
      applyScale(element);
      return;
    }
    releaseScale(element);
    // Routing is permanent, so only do it for media that is actually heard.
    if (gain === 1 || (element.paused && !starting) || element.muted) {
      blocked.delete(element);
      return;
    }
    const reason = boostBlocker(element);
    if (reason) {
      blocked.set(element, reason);
      if (reason === 'gesture') waitForGesture();
      return;
    }
    blocked.delete(element);
    route(element);
  }

  function onElementEvent(event) {
    const element = this;
    try {
      if (event.type === 'pause' || event.type === 'ended') stoppedAt.set(element, now());
      if (event.type === 'emptied' || event.type === 'loadedmetadata') {
        // A new source: its origin has to be checked again.
        verdicts.delete(element);
        if (routed.has(element) && !pageOwned.has(element)) {
          if (event.type === 'emptied') blocked.delete(element);
          else if (isCrossOrigin(element)) blocked.set(element, 'cors');
        }
      }
      update(element);
    } catch {
      // Errors from our listeners would show up in the page's error reporting.
    }
  }

  function track(element) {
    if (seen.has(element)) return;
    seen.add(element);
    elements.add(new NativeWeakRef(element));
    for (const type of ELEMENT_EVENTS) call(addListener, element, type, onElementEvent, true);
  }

  function onDiscovered(event) {
    const element = event.target;
    if (!(element instanceof MediaElement)) return;
    try {
      track(element);
      update(element);
    } catch {
      // See onElementEvent.
    }
  }

  function watchRoot(root) {
    try {
      roots.add(new NativeWeakRef(root));
      for (const type of DISCOVERY_EVENTS) call(addListener, root, type, onDiscovered, true);
    } catch {
      // A closed or exotic root we cannot observe.
    }
  }

  function scan() {
    try {
      for (const element of call(queryDocument, document, 'audio, video')) track(element);
    } catch {
      // No document yet.
    }
    for (const root of live(roots)) {
      try {
        for (const element of call(queryFragment, root, 'audio, video')) track(element);
      } catch {
        // Ignore roots that went away.
      }
    }
  }

  function refresh() {
    scan();
    for (const element of live(elements)) update(element);
  }

  function setGain(value) {
    const next = Number(value);
    if (!(next >= 0 && next <= MAX_GAIN)) return;
    gain = next;
    if (master) rampTo(master, next);
    for (const node of live(pageMasterRefs)) rampTo(node, next);
    refresh();
  }

  // ---- hooks ----

  // Adjust before playback starts: media that is already buffered can render
  // its first samples before a volume change made after play() arrives.
  mediaProto.play = function play() {
    if (this instanceof MediaElement) {
      try {
        track(this);
        update(this, true);
      } catch {
        // Never break playback.
      }
    }
    return apply(nativePlay, this, arguments);
  };

  if (typeof nativeAttachShadow === 'function') {
    Element.prototype.attachShadow = function attachShadow(init) {
      const root = apply(nativeAttachShadow, this, arguments);
      watchRoot(root);
      return root;
    };
  }

  // Our gain node in front of the destination of a realtime page context.
  // Offline contexts render into buffers, not speakers, and stay untouched.
  function pageMasterFor(destination) {
    const owner = destination.context;
    if (!(owner instanceof AudioContextClass) || owner === context) return null;
    let node = pageMasters.get(owner);
    if (!node) {
      node = call(nativeCreateGain, owner);
      node.gain.value = gain;
      call(nativeConnect, node, destination);
      pageMasters.set(owner, node);
      pageMasterRefs.add(new NativeWeakRef(node));
    }
    return node;
  }

  nodeProto.connect = function connect(destination, ...rest) {
    if (destination instanceof DestinationNode) {
      const node = pageMasterFor(destination);
      if (node) {
        apply(nativeConnect, this, [node, ...rest]);
        return destination;
      }
    }
    return apply(nativeConnect, this, [destination, ...rest]);
  };

  nodeProto.disconnect = function disconnect(...args) {
    if (args[0] instanceof DestinationNode) {
      const node = pageMasters.get(args[0].context);
      if (node) {
        try {
          return apply(nativeDisconnect, this, [node, ...args.slice(1)]);
        } catch {
          // Connected straight to the destination before we were injected.
        }
      }
    }
    return apply(nativeDisconnect, this, args);
  };

  function claimByPage(element) {
    if (!(element instanceof MediaElement)) return;
    track(element);
    pageOwned.add(element);
    blocked.delete(element);
    releaseScale(element);
  }

  // The page wants an element in its own graph that already feeds ours, and an
  // element can only ever have one source node. Pass our copy of the audio on
  // through a MediaStream; the page's graph gets our volume at its destination,
  // so our part of the path has to stay at 1x.
  function handOver(pageContext, element) {
    let stream = handedOver.get(element);
    const out = stream ? null : call(nativeCreateStreamDestination, context);
    if (out) stream = out.stream;
    // If the page's context refuses the stream, our routing stays as it was.
    const node = call(nativeCreateStreamSource, pageContext, stream);
    if (out) {
      const source = routed.get(element);
      call(nativeDisconnect, source);
      call(nativeConnect, source, out);
      handedOver.set(element, stream);
    }
    try {
      Object.defineProperty(node, 'mediaElement', { value: element, configurable: true });
    } catch {
      // Cosmetic only.
    }
    claimByPage(element);
    return node;
  }

  contextProto.createMediaElementSource = function createMediaElementSource(mediaElement) {
    if (routed.has(mediaElement)) return handOver(this, mediaElement);
    const node = apply(nativeCreateElementSource, this, arguments);
    claimByPage(mediaElement);
    return node;
  };

  if (typeof NativeElementSourceNode === 'function') {
    const ElementSourceNode = function MediaElementAudioSourceNode(audioContext, options) {
      if (!new.target) return apply(NativeElementSourceNode, this, arguments);
      const element = options ? options.mediaElement : undefined;
      if (element && routed.has(element)) return handOver(audioContext, element);
      const target = new.target === ElementSourceNode ? NativeElementSourceNode : new.target;
      const node = construct(NativeElementSourceNode, arguments, target);
      if (element) claimByPage(element);
      return node;
    };
    Object.setPrototypeOf(ElementSourceNode, Object.getPrototypeOf(NativeElementSourceNode));
    ElementSourceNode.prototype = NativeElementSourceNode.prototype;
    Object.defineProperty(NativeElementSourceNode.prototype, 'constructor', {
      value: ElementSourceNode,
      writable: true,
      configurable: true,
    });
    Object.defineProperty(window, 'MediaElementAudioSourceNode', {
      value: ElementSourceNode,
      writable: true,
      configurable: true,
    });
  }

  // ---- talking to the bridge ----

  function describe() {
    let media = 0;
    let playing = 0;
    let recent = 0; // playing, or stopped a moment ago
    let boosted = 0;
    let scaledCount = 0;
    let viaPage = 0;
    const issues = {};
    const time = now();
    for (const element of live(elements)) {
      media += 1;
      if (element.paused) {
        if (time - (stoppedAt.get(element) ?? -Infinity) < RECENT_MS) recent += 1;
        continue;
      }
      playing += 1;
      recent += 1;
      if (pageOwned.has(element)) viaPage += 1;
      else if (routed.has(element)) boosted += 1;
      else if (scaled.has(element)) scaledCount += 1;
      const reason = foreign.has(element) ? 'foreign' : blocked.get(element);
      if (reason && reason !== 'loading') issues[reason] = (issues[reason] || 0) + 1;
    }
    let graphs = 0;
    for (const node of live(pageMasterRefs)) {
      if (node.context.state === 'running') graphs += 1;
    }
    return {
      v: PROTOCOL,
      gain,
      media,
      playing,
      recent,
      boosted,
      scaled: scaledCount,
      viaPage,
      graphs,
      issues,
      context: context ? context.state : null,
    };
  }

  function report(message) {
    try {
      call(dispatch, window, new NativeCustomEvent(REPORT, { detail: stringify(message) }));
    } catch {
      // Reporting must never break the page.
    }
  }

  function onCommand(event) {
    let message;
    try {
      message = parse(event.detail);
    } catch {
      return;
    }
    if (!message || typeof message !== 'object') return;
    try {
      if (message.type === 'gain') setGain(message.gain);
      else if (message.type === 'ping') report({ type: 'ready', v: PROTOCOL });
      else if (message.type === 'status') report({ type: 'status', status: describe() });
    } catch {
      // See onElementEvent.
    }
  }

  function attach() {
    call(addListener, window, CMD, onCommand);
    for (const type of DISCOVERY_EVENTS) call(addListener, window, type, onDiscovered, true);
    if (waitingForGesture) {
      for (const type of GESTURE_EVENTS) call(addListener, window, type, onGesture, GESTURE_OPTIONS);
    }
    report({ type: 'ready', v: PROTOCOL });
  }

  Object.defineProperty(window, ENGINE, { value: Object.freeze({ attach }) });
  attach();
  // When injected into a page that is already running (right after install).
  scan();
})();
