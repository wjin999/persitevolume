import { FILE_SITE, MAX_VOLUME, PRESETS, clampVolume, faviconUrl } from '../shared/config.js';
import { localize, t } from '../shared/i18n.js';

const STATUS_INTERVAL_MS = 1500;
const TABS_INTERVAL_MS = 2500;
const WHEEL_STEP = 5;
const UNITY = 100;

const $ = (id) => document.getElementById(id);
const ui = {
  app: $('app'),
  favicon: $('favicon'),
  siteName: $('siteName'),
  siteMode: $('siteMode'),
  openOptions: $('openOptions'),
  unsupported: $('unsupported'),
  unsupportedText: $('unsupportedText'),
  unsupportedAction: $('unsupportedAction'),
  control: $('control'),
  decrease: $('decrease'),
  increase: $('increase'),
  value: $('value'),
  slider: $('slider'),
  sliderBox: $('sliderBox'),
  scale: $('scale'),
  presets: $('presets'),
  remember: $('remember'),
  rememberHint: $('rememberHint'),
  enhanced: $('enhanced'),
  notice: $('notice'),
  noticeText: $('noticeText'),
  noticeAction: $('noticeAction'),
  status: $('status'),
  tabList: $('tabList'),
  tabListEmpty: $('tabListEmpty'),
};

// ?tab=<id> opens the popup for a given tab (handy when it runs in a tab).
let tabId = Number(new URLSearchParams(location.search).get('tab')) || null;
let tab = null; // the service worker's description of the tab
let status = null; // what the content scripts report, summed over frames
let error = null;
let errorTimer = 0;
let scaleMax = 0;

async function request(type, payload = {}) {
  const reply = await chrome.runtime.sendMessage({ type, ...payload });
  if (reply?.error) throw new Error(reply.error);
  return reply;
}

function siteLabel(site) {
  return site === FILE_SITE ? t('localFiles') : site;
}

function showError(err) {
  error = err instanceof Error ? err.message : String(err);
  clearTimeout(errorTimer);
  errorTimer = setTimeout(() => {
    error = null;
    renderNotice();
  }, 6000);
  renderNotice();
}

// ---- rendering ----

function render() {
  ui.app.removeAttribute('aria-busy');
  ui.siteName.textContent = tab.site ? siteLabel(tab.site) : t('thisPage');
  ui.favicon.src = faviconUrl(tab.url || 'about:blank');
  ui.unsupported.hidden = !tab.unsupported;
  ui.control.hidden = Boolean(tab.unsupported);
  if (tab.unsupported) {
    renderUnsupported();
    return;
  }
  ui.siteMode.textContent = [t(`mode_${tab.mode}`), tab.capturing ? t('enhancedMode') : ''].filter(Boolean).join(' · ');
  renderVolume(tab.volume);
  ui.remember.checked = tab.mode === 'site' || (tab.mode === 'default' && tab.remember);
  ui.remember.disabled = tab.incognito;
  ui.rememberHint.textContent = tab.incognito
    ? t('rememberIncognito')
    : ui.remember.checked
      ? t('rememberOn', siteLabel(tab.site))
      : t('rememberOff');
  ui.enhanced.checked = tab.capturing;
  renderNotice();
}

function renderUnsupported() {
  ui.siteMode.textContent = '';
  ui.unsupportedText.textContent = t(`unsupported_${tab.unsupported}`);
  ui.unsupportedAction.hidden = tab.unsupported !== 'file';
  ui.unsupportedAction.textContent = t('openExtensionSettings');
}

function position(volume, max) {
  return `calc(var(--thumb) / 2 + (100% - var(--thumb)) * ${volume / max})`;
}

function renderScale(max) {
  if (max === scaleMax) return;
  scaleMax = max;
  const step = max <= 200 ? 50 : 100;
  const ticks = [];
  for (let value = 0; value <= max; value += step) {
    const tick = document.createElement('span');
    tick.className = value === UNITY ? 'tick unity' : 'tick';
    tick.style.left = position(value, max);
    tick.textContent = String(value);
    ticks.push(tick);
  }
  ui.scale.replaceChildren(...ticks);
}

function renderVolume(volume) {
  const max = Math.max(tab.prefs.maxVolume, volume);
  ui.app.dataset.level = volume > UNITY ? 'boost' : volume < UNITY ? 'cut' : 'unity';
  if (document.activeElement !== ui.value) ui.value.value = String(volume);
  ui.slider.max = String(max);
  ui.slider.value = String(volume);
  const fill = position(volume, max);
  ui.slider.style.setProperty(
    '--track-fill',
    volume <= UNITY
      ? `linear-gradient(90deg, var(--accent) ${fill}, var(--track) ${fill})`
      : `linear-gradient(90deg, var(--accent) ${position(UNITY, max)}, var(--boost) ${fill}, var(--track) ${fill})`,
  );
  renderScale(max);
  for (const button of ui.presets.children) {
    button.setAttribute('aria-pressed', String(Number(button.dataset.volume) === volume));
  }
}

function pickNotice() {
  if (error) return { kind: 'error', text: error };
  if (!status || tab.capturing) return null;
  if (status.frames === 0) {
    return { kind: 'warn', text: t('noticeReload'), label: t('reload'), action: reloadTab };
  }
  const { issues } = status;
  if (issues.gesture) return { kind: 'warn', text: t('noticeGesture') };
  if (issues.cors || issues.stream || issues.device || issues.foreign || issues.unavailable) {
    return { kind: 'warn', text: t('noticeCannotBoost'), label: t('useEnhanced'), action: startEnhanced };
  }
  if (tab.audible && tab.volume !== UNITY && status.playing === 0 && status.graphs === 0) {
    return { kind: 'warn', text: t('noticeNoSource'), label: t('useEnhanced'), action: startEnhanced };
  }
  return null;
}

function renderNotice() {
  if (!tab || tab.unsupported) return;
  const notice = pickNotice();
  ui.notice.hidden = !notice;
  if (notice) {
    ui.notice.dataset.kind = notice.kind;
    ui.noticeText.textContent = notice.text;
    ui.noticeAction.hidden = !notice.action;
    ui.noticeAction.textContent = notice.label ?? '';
    ui.noticeAction.onclick = notice.action ?? null;
  }
  let line = '';
  if (tab.capturing) line = t('statusEnhanced');
  else if (status && status.frames > 0) {
    const sources = status.playing + status.graphs;
    line = sources > 0 ? t('statusControlling', String(sources)) : t('statusIdle');
  }
  ui.status.textContent = line;
}

// ---- changing the volume ----

let pending = null;
let sending = false;

function changeVolume(volume) {
  const value = clampVolume(volume, MAX_VOLUME);
  if (value === null || !tab || tab.unsupported) return;
  tab.volume = value;
  renderVolume(value);
  pending = value;
  if (!sending) flushVolume();
}

// Sends the newest value only, one request at a time.
async function flushVolume() {
  sending = true;
  try {
    while (pending !== null) {
      const volume = pending;
      pending = null;
      try {
        const remember = ui.remember.checked && !tab.incognito;
        const next = await request('setVolume', { tabId, volume, remember });
        if (pending === null) {
          tab = next;
          render();
        }
      } catch (err) {
        showError(err);
      }
    }
  } finally {
    sending = false;
  }
  refreshTabs();
}

function stepVolume(direction) {
  const { step } = tab.prefs;
  const current = tab.volume;
  const next = direction > 0 ? (Math.floor(current / step) + 1) * step : (Math.ceil(current / step) - 1) * step;
  changeVolume(Math.min(Math.max(tab.prefs.maxVolume, current), Math.max(0, next)));
}

async function setRemember(remember) {
  try {
    tab = await request('setRemember', { tabId, remember });
  } catch (err) {
    showError(err);
  }
  render();
  refreshTabs();
}

async function setEnhanced(on) {
  ui.enhanced.disabled = true;
  try {
    tab = await request(on ? 'startCapture' : 'stopCapture', { tabId });
  } catch (err) {
    showError(t('enhancedFailed', err.message));
  } finally {
    ui.enhanced.disabled = false;
  }
  render();
  refreshStatus();
}

function startEnhanced() {
  setEnhanced(true);
}

async function reloadTab() {
  await chrome.tabs.reload(tabId);
  status = null;
  renderNotice();
  setTimeout(refreshStatus, 800);
}

// ---- live state ----

function sumStatus(frames) {
  const total = {
    frames: frames.length,
    media: 0,
    playing: 0,
    boosted: 0,
    scaled: 0,
    viaPage: 0,
    graphs: 0,
    issues: {},
  };
  for (const frame of frames) {
    for (const key of ['media', 'playing', 'boosted', 'scaled', 'viaPage', 'graphs']) total[key] += frame[key] || 0;
    for (const [reason, count] of Object.entries(frame.issues ?? {})) {
      total.issues[reason] = (total.issues[reason] || 0) + count;
    }
  }
  return total;
}

async function refreshStatus() {
  if (!tab || tab.unsupported) return;
  let frames = [];
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: () => globalThis.__persitevolumeBridge?.status() ?? null,
    });
    frames = results.map((result) => result.result).filter(Boolean);
  } catch {
    // The tab is loading, or went away.
  }
  status = sumStatus(frames);
  try {
    tab.audible = Boolean((await chrome.tabs.get(tabId)).audible);
  } catch {
    // Closed.
  }
  renderNotice();
}

function tabRow(item, info) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'tab';
  if (item.id === tabId) button.setAttribute('aria-current', 'true');
  const icon = document.createElement('img');
  icon.src = faviconUrl(item.url || 'about:blank', 16);
  icon.alt = '';
  const title = document.createElement('span');
  title.className = 'tab-title';
  title.textContent = item.title || item.url || '';
  const volume = document.createElement('span');
  volume.className = 'tab-volume';
  if (info?.site) {
    volume.textContent = `${info.volume}%`;
    if (info.volume > UNITY) volume.dataset.level = 'boost';
  }
  button.append(icon, title, volume);
  button.addEventListener('click', async () => {
    await chrome.tabs.update(item.id, { active: true });
    await chrome.windows.update(item.windowId, { focused: true });
    window.close();
  });
  const row = document.createElement('li');
  row.append(button);
  return row;
}

async function refreshTabs() {
  let tabs = [];
  let volumes = {};
  try {
    tabs = await chrome.tabs.query({ audible: true });
    volumes = await request('getVolumes', { tabs: tabs.map(({ id, url }) => ({ id, url })) });
  } catch {
    // Keep the last list.
  }
  ui.tabList.replaceChildren(...tabs.map((item) => tabRow(item, volumes[item.id])));
  ui.tabListEmpty.hidden = tabs.length > 0;
}

// ---- setup ----

function buildPresets() {
  ui.presets.replaceChildren(
    ...PRESETS.filter((volume) => volume <= Math.max(tab.prefs.maxVolume, UNITY)).map((volume) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'preset';
      button.dataset.volume = String(volume);
      button.textContent = `${volume}%`;
      button.addEventListener('click', () => changeVolume(volume));
      return button;
    }),
  );
}

function bindEvents() {
  ui.slider.addEventListener('input', () => changeVolume(ui.slider.valueAsNumber));
  ui.sliderBox.addEventListener(
    'wheel',
    (event) => {
      event.preventDefault();
      const max = Math.max(tab.prefs.maxVolume, tab.volume);
      changeVolume(Math.min(max, tab.volume + (event.deltaY < 0 ? WHEEL_STEP : -WHEEL_STEP)));
    },
    { passive: false },
  );
  ui.value.addEventListener('change', () => {
    if (ui.value.value === '') renderVolume(tab.volume);
    else changeVolume(ui.value.valueAsNumber);
  });
  ui.value.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') ui.value.blur();
  });
  ui.value.addEventListener('blur', () => renderVolume(tab.volume));
  ui.decrease.addEventListener('click', () => stepVolume(-1));
  ui.increase.addEventListener('click', () => stepVolume(1));
  ui.remember.addEventListener('change', () => setRemember(ui.remember.checked));
  ui.enhanced.addEventListener('change', () => setEnhanced(ui.enhanced.checked));
  ui.openOptions.addEventListener('click', () => chrome.runtime.openOptionsPage());
  ui.unsupportedAction.addEventListener('click', () =>
    chrome.tabs.create({ url: `chrome://extensions/?id=${chrome.runtime.id}` }),
  );
}

async function init() {
  localize();
  if (!tabId) {
    const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
    tabId = active?.id ?? null;
  }
  if (tabId === null) return;
  tab = await request('getTab', { tabId });
  buildPresets();
  bindEvents();
  render();
  refreshStatus();
  refreshTabs();
  setInterval(refreshStatus, STATUS_INTERVAL_MS);
  setInterval(refreshTabs, TABS_INTERVAL_MS);
}

init().catch((err) => {
  ui.app.removeAttribute('aria-busy');
  ui.siteName.textContent = t('thisPage');
  ui.unsupported.hidden = false;
  ui.unsupportedText.textContent = err.message;
});
