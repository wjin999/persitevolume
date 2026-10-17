/*
 * PerSite Volume: service worker.
 *
 * Owns the settings: one volume per site (chrome.storage.local), an optional
 * volume for a single tab that is not remembered (chrome.storage.session),
 * and the tabs in enhanced mode, whose audio the offscreen document captures
 * and plays back at the chosen volume.
 */
import {
  CAPTURES_KEY,
  DEFAULT_PREFS,
  FILE_SITE,
  PREFS_KEY,
  SITE_PREFIX,
  TAB_PREFIX,
  clampVolume,
  isStoreUrl,
  normalizePrefs,
  normalizeSite,
  originOf,
  siteKeyFromUrl,
} from './shared/config.js';

const OFFSCREEN_PATH = 'src/offscreen/offscreen.html';
const PERSIST_DELAY_MS = 250;
const BADGE_COLORS = {
  boost: '#e8590c',
  cut: '#1c7ed6',
  mute: '#868e96',
  capture: '#7048e8',
};

const state = {
  prefs: { ...DEFAULT_PREFS },
  sites: new Map(), // site -> { volume, updated, origin? }
  temps: new Map(), // tabId -> { site, volume }
  captures: new Set(), // tabIds in enhanced mode
};

const noop = () => {};
let loading = null;

function ready() {
  loading ??= load().catch((error) => {
    loading = null;
    throw error;
  });
  return loading;
}

async function load() {
  const [local, session] = await Promise.all([chrome.storage.local.get(null), chrome.storage.session.get(null)]);
  state.prefs = normalizePrefs(local[PREFS_KEY]);
  state.sites.clear();
  for (const [key, value] of Object.entries(local)) {
    if (!key.startsWith(SITE_PREFIX)) continue;
    const entry = normalizeSite(value);
    if (entry) state.sites.set(key.slice(SITE_PREFIX.length), entry);
  }
  state.temps.clear();
  for (const [key, value] of Object.entries(session)) {
    if (key.startsWith(TAB_PREFIX) && value) state.temps.set(Number(key.slice(TAB_PREFIX.length)), value);
  }
  await restoreCaptures(session[CAPTURES_KEY]);
}

// Mutations run one at a time so that a burst of slider events can never be
// applied out of order.
let queue = Promise.resolve();
function serial(task) {
  const run = queue.then(task);
  queue = run.catch(noop);
  return run;
}

// ---- volume lookup ----

function volumeFor(tabId, site) {
  const temp = state.temps.get(tabId);
  if (temp && temp.site === site) return temp.volume;
  const entry = site ? state.sites.get(site) : null;
  return entry ? entry.volume : state.prefs.defaultVolume;
}

// 'tab': a volume for this tab only; 'site': the saved setting of the site;
// 'default': nothing set yet.
function modeFor(tabId, site) {
  const temp = state.temps.get(tabId);
  if (temp && temp.site === site) return 'tab';
  return site && state.sites.has(site) ? 'site' : 'default';
}

// Whether a change made now gets remembered for the site. Nothing is ever
// saved from incognito tabs.
function remembers(tab, site) {
  if (tab.incognito) return false;
  const mode = modeFor(tab.id, site);
  if (mode === 'default') return state.prefs.rememberByDefault;
  return mode === 'site';
}

// ---- pushing the volume to tabs ----

function badgeColor(volume, capturing) {
  if (capturing) return BADGE_COLORS.capture;
  if (volume === 0) return BADGE_COLORS.mute;
  return volume > 100 ? BADGE_COLORS.boost : BADGE_COLORS.cut;
}

function updateBadge(tabId, site, volume, capturing) {
  const text = site && state.prefs.showBadge && volume !== 100 ? String(volume) : '';
  chrome.action.setBadgeText({ tabId, text }).catch(noop);
  if (text) {
    chrome.action.setBadgeBackgroundColor({ tabId, color: badgeColor(volume, capturing) }).catch(noop);
    chrome.action.setBadgeTextColor({ tabId, color: '#ffffff' }).catch(noop);
  }
  const name = chrome.i18n.getMessage('extName');
  const where = site === FILE_SITE ? chrome.i18n.getMessage('localFiles') : site;
  chrome.action.setTitle({ tabId, title: site ? `${name}: ${volume}% (${where})` : name }).catch(noop);
}

async function applyToTab(tabId, site) {
  const volume = volumeFor(tabId, site);
  const capturing = state.captures.has(tabId);
  updateBadge(tabId, site, volume, capturing);
  // In enhanced mode the captured audio gets the volume; the page stays at 1x.
  if (capturing) toOffscreen({ type: 'gain', tabId, gain: volume / 100 }).catch(noop);
  await chrome.tabs.sendMessage(tabId, { type: 'apply', gain: capturing ? 1 : volume / 100 }).catch(noop);
}

async function applyToSite(site) {
  const tabs = await chrome.tabs.query({});
  await Promise.all(tabs.filter((tab) => siteKeyFromUrl(tab.url) === site).map((tab) => applyToTab(tab.id, site)));
}

async function applyToAllTabs() {
  const tabs = await chrome.tabs.query({});
  await Promise.all(
    tabs.map((tab) => {
      const site = siteKeyFromUrl(tab.url);
      return site ? applyToTab(tab.id, site) : null;
    }),
  );
}

// ---- persistence ----

const dirty = new Set(); // sites with a write still pending
let persistTimer = 0;

function persistSoon(site) {
  dirty.add(site);
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => flush().catch(console.error), PERSIST_DELAY_MS);
}

async function flush() {
  clearTimeout(persistTimer);
  if (!dirty.size) return;
  const writes = {};
  const removals = [];
  for (const site of dirty) {
    const entry = state.sites.get(site);
    if (entry) writes[SITE_PREFIX + site] = entry;
    else removals.push(SITE_PREFIX + site);
  }
  dirty.clear();
  await Promise.all([
    Object.keys(writes).length ? chrome.storage.local.set(writes) : null,
    removals.length ? chrome.storage.local.remove(removals) : null,
  ]);
}

function saveSite(site, volume, url) {
  const origin = originOf(url) ?? state.sites.get(site)?.origin;
  state.sites.set(site, origin ? { volume, updated: Date.now(), origin } : { volume, updated: Date.now() });
  persistSoon(site);
}

function forgetSite(site) {
  state.sites.delete(site);
  persistSoon(site);
}

async function setTemp(tabId, site, volume) {
  const temp = { site, volume };
  state.temps.set(tabId, temp);
  await chrome.storage.session.set({ [TAB_PREFIX + tabId]: temp });
}

async function clearTemp(tabId) {
  if (!state.temps.delete(tabId)) return;
  await chrome.storage.session.remove(TAB_PREFIX + tabId);
}

// A tab's own volume only lasts while it stays on the same site.
async function dropStaleTemp(tabId, site) {
  const temp = state.temps.get(tabId);
  if (temp && temp.site !== site) await clearTemp(tabId);
}

// ---- requests ----

async function describeTab(tab) {
  const site = siteKeyFromUrl(tab.url);
  let unsupported = null;
  if (!site) unsupported = 'page';
  else if (isStoreUrl(tab.url)) unsupported = 'store';
  else if (site === FILE_SITE && !(await chrome.extension.isAllowedFileSchemeAccess())) unsupported = 'file';
  return {
    tabId: tab.id,
    url: tab.url ?? null,
    site,
    unsupported,
    volume: volumeFor(tab.id, site),
    mode: modeFor(tab.id, site),
    remember: remembers(tab, site),
    incognito: tab.incognito,
    audible: Boolean(tab.audible),
    capturing: state.captures.has(tab.id),
    prefs: state.prefs,
  };
}

async function controllableTab(tabId) {
  const tab = await chrome.tabs.get(tabId);
  const site = siteKeyFromUrl(tab.url);
  if (!site || isStoreUrl(tab.url)) throw new Error('This page cannot be controlled.');
  return { tab, site };
}

async function setVolume({ tabId, volume, remember }) {
  const { tab, site } = await controllableTab(tabId);
  const value = clampVolume(volume);
  if (value === null) throw new Error('Invalid volume.');
  const keep = (typeof remember === 'boolean' ? remember : remembers(tab, site)) && !tab.incognito;
  if (keep) {
    await clearTemp(tab.id);
    saveSite(site, value, tab.url);
    await applyToSite(site);
  } else {
    await setTemp(tab.id, site, value);
    await applyToTab(tab.id, site);
  }
  return describeTab(tab);
}

async function setRemember({ tabId, remember }) {
  const { tab, site } = await controllableTab(tabId);
  if (tab.incognito) throw new Error('Nothing is saved from incognito tabs.');
  const volume = volumeFor(tab.id, site);
  if (remember) {
    await clearTemp(tab.id);
    saveSite(site, volume, tab.url);
  } else {
    // This tab keeps what it has now; other tabs of the site fall back to the default.
    await setTemp(tab.id, site, volume);
    forgetSite(site);
  }
  await flush();
  await applyToSite(site);
  return describeTab(tab);
}

function getVolumes({ tabs }) {
  const result = {};
  for (const { id, url } of tabs ?? []) {
    const site = siteKeyFromUrl(url);
    result[id] = { site, volume: volumeFor(id, site), capturing: state.captures.has(id) };
  }
  return result;
}

// A content script starting up in some frame of a tab.
function hello(message, sender) {
  const { tab } = sender;
  // The tab's site decides, also for frames from other origins.
  const site = siteKeyFromUrl(message.top || tab.url);
  if (sender.frameId === 0 && sender.documentLifecycle !== 'prerender') {
    // A new document in the tab: Chrome has just cleared the badge.
    serial(async () => {
      await dropStaleTemp(tab.id, site);
      updateBadge(tab.id, site, volumeFor(tab.id, site), state.captures.has(tab.id));
    }).catch(noop);
  }
  return { gain: state.captures.has(tab.id) ? 1 : volumeFor(tab.id, site) / 100 };
}

// ---- enhanced mode (tab capture) ----

let creatingOffscreen = null;

async function hasOffscreen() {
  const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  return contexts.length > 0;
}

async function ensureOffscreen() {
  if (await hasOffscreen()) return;
  creatingOffscreen ??= chrome.offscreen
    .createDocument({
      url: OFFSCREEN_PATH,
      reasons: ['USER_MEDIA'],
      justification: 'Plays the captured audio of tabs in enhanced mode back at the chosen volume.',
    })
    .finally(() => {
      creatingOffscreen = null;
    });
  await creatingOffscreen;
}

async function closeOffscreenIfIdle() {
  if (state.captures.size || !(await hasOffscreen())) return;
  await chrome.offscreen.closeDocument().catch(noop);
}

function toOffscreen(message) {
  return chrome.runtime.sendMessage({ ...message, target: 'offscreen' });
}

async function saveCaptures() {
  await chrome.storage.session.set({ [CAPTURES_KEY]: [...state.captures] });
}

async function restoreCaptures(saved) {
  state.captures.clear();
  if (!Array.isArray(saved) || !saved.length) return;
  const reply = (await hasOffscreen()) ? await toOffscreen({ type: 'list' }).catch(() => null) : null;
  const live = new Set(reply?.tabs ?? []);
  for (const tabId of saved) if (live.has(tabId)) state.captures.add(tabId);
  if (state.captures.size !== saved.length) await saveCaptures();
}

async function startCapture({ tabId }) {
  const { tab, site } = await controllableTab(tabId);
  if (state.captures.has(tabId)) return describeTab(tab);
  // Only allowed right after the user opened our popup on this tab.
  const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
  await ensureOffscreen();
  // Capture starts at 1x and the page drops to 1x before the captured audio
  // takes the volume over, so it never plays twice amplified.
  const reply = await toOffscreen({ type: 'start', tabId, streamId, gain: 1 });
  if (!reply?.ok) throw new Error(reply?.error || 'Could not capture the tab.');
  state.captures.add(tabId);
  await saveCaptures();
  await chrome.tabs.sendMessage(tabId, { type: 'apply', gain: 1 }).catch(noop);
  await applyToTab(tabId, site);
  return describeTab(tab);
}

async function captureEnded(tabId) {
  if (!state.captures.delete(tabId)) return;
  await saveCaptures();
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (tab) await applyToTab(tabId, siteKeyFromUrl(tab.url));
  await closeOffscreenIfIdle();
}

async function stopCapture({ tabId }) {
  if (state.captures.has(tabId)) {
    // Stop first: the page takes the volume back while it plays at 1x.
    await toOffscreen({ type: 'stop', tabId }).catch(noop);
    await captureEnded(tabId);
  }
  return describeTab(await chrome.tabs.get(tabId));
}

// ---- wiring ----

const handlers = {
  hello: { fromContent: true, run: hello },
  getTab: { run: async ({ tabId }) => describeTab(await chrome.tabs.get(tabId)) },
  getVolumes: { run: getVolumes },
  setVolume: { run: (message) => serial(() => setVolume(message)) },
  setRemember: { run: (message) => serial(() => setRemember(message)) },
  startCapture: { run: (message) => serial(() => startCapture(message)) },
  stopCapture: { run: (message) => serial(() => stopCapture(message)) },
  captureEnded: { run: ({ tabId }) => serial(() => captureEnded(tabId)) },
};

function fromExtensionPage(sender) {
  return sender.id === chrome.runtime.id && Boolean(sender.url?.startsWith(chrome.runtime.getURL('')));
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target === 'offscreen') return false;
  const handler = Object.hasOwn(handlers, message?.type) ? handlers[message.type] : null;
  if (!handler) return false;
  if (handler.fromContent ? !sender.tab : !fromExtensionPage(sender)) return false;
  ready()
    .then(() => handler.run(message, sender))
    .then(
      (result) => sendResponse(result ?? null),
      (error) => sendResponse({ error: String(error?.message ?? error) }),
    );
  return true;
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  ready()
    .then(() => serial(() => onStorageChanged(changes)))
    .catch(console.error);
});

// Edits from the options page (or another window) reach open tabs here.
async function onStorageChanged(changes) {
  let prefsChanged = false;
  const sites = [];
  for (const [key, { newValue }] of Object.entries(changes)) {
    if (key === PREFS_KEY) {
      state.prefs = normalizePrefs(newValue);
      prefsChanged = true;
    } else if (key.startsWith(SITE_PREFIX)) {
      const site = key.slice(SITE_PREFIX.length);
      // A newer value of ours is about to be written.
      if (dirty.has(site)) continue;
      const entry = normalizeSite(newValue);
      if (entry) state.sites.set(site, entry);
      else state.sites.delete(site);
      sites.push(site);
    }
  }
  if (prefsChanged) await applyToAllTabs();
  else await Promise.all(sites.map(applyToSite));
}

chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (!('url' in info) && info.status !== 'complete') return;
  ready()
    .then(() =>
      serial(async () => {
        const site = siteKeyFromUrl(tab.url);
        if ('url' in info) await dropStaleTemp(tabId, site);
        const volume = volumeFor(tabId, site);
        const capturing = state.captures.has(tabId);
        updateBadge(tabId, site, volume, capturing);
        // The captured tab may have moved on to a site with another volume.
        if (capturing) toOffscreen({ type: 'gain', tabId, gain: volume / 100 }).catch(noop);
      }),
    )
    .catch(console.error);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  ready()
    .then(() =>
      serial(async () => {
        await clearTemp(tabId);
        if (state.captures.delete(tabId)) {
          await saveCaptures();
          await closeOffscreenIfIdle();
        }
      }),
    )
    .catch(console.error);
});

chrome.tabs.onReplaced.addListener((addedTabId, removedTabId) => {
  ready()
    .then(() =>
      serial(async () => {
        const temp = state.temps.get(removedTabId);
        if (!temp) return;
        await clearTemp(removedTabId);
        await setTemp(addedTabId, temp.site, temp.volume);
      }),
    )
    .catch(console.error);
});

chrome.commands.onCommand.addListener((command, tab) => {
  const direction = { 'volume-up': 1, 'volume-down': -1 }[command];
  if (!direction) return;
  ready()
    .then(() =>
      serial(async () => {
        const target = tab?.id >= 0 ? tab : (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0];
        const site = siteKeyFromUrl(target?.url);
        if (!site || isStoreUrl(target.url)) return;
        const { step, maxVolume } = state.prefs;
        const current = volumeFor(target.id, site);
        // Snap to the step grid: 147 goes to 150 or 140.
        const next = direction > 0 ? (Math.floor(current / step) + 1) * step : (Math.ceil(current / step) - 1) * step;
        const volume = Math.min(Math.max(maxVolume, current), Math.max(0, next));
        await setVolume({ tabId: target.id, volume });
      }),
    )
    .catch(console.error);
});

// Content scripts only reach pages loaded after install; bring the open ones in.
chrome.runtime.onInstalled.addListener(() => {
  injectIntoOpenTabs().catch(console.error);
});

async function injectIntoOpenTabs() {
  const scripts = chrome.runtime.getManifest().content_scripts ?? [];
  const tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*', 'file:///*'] });
  await Promise.all(
    tabs.map(async (tab) => {
      if (tab.discarded || isStoreUrl(tab.url)) return;
      for (const script of scripts) {
        await chrome.scripting
          .executeScript({
            target: { tabId: tab.id, allFrames: true },
            files: script.js,
            world: script.world === 'MAIN' ? 'MAIN' : 'ISOLATED',
            injectImmediately: true,
          })
          .catch(noop);
      }
    }),
  );
}
