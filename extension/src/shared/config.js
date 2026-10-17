// Settings shared by the service worker, the popup and the options page.

export const PREFS_KEY = 'prefs';
export const SITE_PREFIX = 'site:';
// chrome.storage.session: volume set for a single tab without remembering it.
export const TAB_PREFIX = 'tab:';
// chrome.storage.session: tabs whose audio is captured (enhanced mode).
export const CAPTURES_KEY = 'captures';

export const MIN_VOLUME = 0;
export const MAX_VOLUME = 600;
export const MAX_CHOICES = [200, 300, 400, 500, 600];
export const STEP_CHOICES = [1, 5, 10, 20, 25, 50];
export const PRESETS = [10, 25, 50, 100, 150, 200, 300];

// Every local file shares one setting.
export const FILE_SITE = 'file://';

export const DEFAULT_PREFS = Object.freeze({
  defaultVolume: 100,
  maxVolume: 600,
  step: 10,
  rememberByDefault: true,
  showBadge: true,
});

const STORE_HOSTS = new Set(['chromewebstore.google.com']);

export function clampVolume(value, max = MAX_VOLUME) {
  if (value === null || value === '' || typeof value === 'boolean') return null;
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return null;
  return Math.min(max, Math.max(MIN_VOLUME, n));
}

export function normalizePrefs(raw) {
  const prefs = { ...DEFAULT_PREFS };
  if (!raw || typeof raw !== 'object') return prefs;
  const defaultVolume = clampVolume(raw.defaultVolume);
  if (defaultVolume !== null) prefs.defaultVolume = defaultVolume;
  if (MAX_CHOICES.includes(raw.maxVolume)) prefs.maxVolume = raw.maxVolume;
  if (STEP_CHOICES.includes(raw.step)) prefs.step = raw.step;
  if (typeof raw.rememberByDefault === 'boolean') prefs.rememberByDefault = raw.rememberByDefault;
  if (typeof raw.showBadge === 'boolean') prefs.showBadge = raw.showBadge;
  return prefs;
}

// Saved entries are { volume, updated, origin? }; a bare number is accepted
// so that hand-written backups can be imported.
export function normalizeSite(raw) {
  const entry = typeof raw === 'number' ? { volume: raw } : raw;
  if (!entry || typeof entry !== 'object') return null;
  const volume = clampVolume(entry.volume);
  if (volume === null) return null;
  const site = { volume, updated: Number(entry.updated) || 0 };
  if (typeof entry.origin === 'string' && /^https?:\/\//.test(entry.origin)) site.origin = entry.origin;
  return site;
}

// The key settings are stored under: the host (with port) without a leading
// "www.", so www.example.com and example.com share a setting.
export function siteKeyFromUrl(url) {
  if (!url) return null;
  let parsed;
  try {
    parsed = new URL(url);
    if (parsed.protocol === 'blob:') parsed = new URL(parsed.origin);
  } catch {
    return null;
  }
  if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
    const host = parsed.host.toLowerCase();
    if (!host) return null;
    return host.startsWith('www.') ? host.slice(4) : host;
  }
  if (parsed.protocol === 'file:') return FILE_SITE;
  return null;
}

// host[:port], or [IPv6][:port]
const SITE_KEY_PATTERN = /^(?:[a-z\d_-]+(?:\.[a-z\d_-]+)*|\[[\da-f:.]+\])(?::\d{1,5})?$/;

// Accepts what people type in the options page: "example.com", a full URL, …
export function siteKeyFromInput(text) {
  const value = String(text ?? '').trim();
  if (!value) return null;
  if (/^file:/i.test(value)) return FILE_SITE;
  const withScheme = /^[a-z][a-z\d+.-]*:\/\//i.test(value) ? value : `https://${value}`;
  const key = siteKeyFromUrl(withScheme);
  // Chrome's URL parser escapes rather than rejects typos like "a b".
  return key && SITE_KEY_PATTERN.test(key) ? key : null;
}

// Pages where Chrome never runs extension scripts, even with host access.
export function isStoreUrl(url) {
  try {
    const { hostname, pathname } = new URL(url);
    return STORE_HOSTS.has(hostname) || (hostname === 'chrome.google.com' && pathname.startsWith('/webstore'));
  } catch {
    return false;
  }
}

export function originOf(url) {
  try {
    const { protocol, origin } = new URL(url);
    return protocol === 'http:' || protocol === 'https:' ? origin : undefined;
  } catch {
    return undefined;
  }
}

// A page URL to look a site's favicon up with.
export function pageUrlForSite(site, entry) {
  if (entry?.origin) return `${entry.origin}/`;
  if (site === FILE_SITE) return 'file:///';
  return `https://${site}/`;
}

export function faviconUrl(pageUrl, size = 32) {
  const url = new URL(chrome.runtime.getURL('/_favicon/'));
  url.searchParams.set('pageUrl', pageUrl);
  url.searchParams.set('size', String(size));
  return url.href;
}
