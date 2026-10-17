import {
  FILE_SITE,
  MAX_CHOICES,
  MAX_VOLUME,
  PREFS_KEY,
  SITE_PREFIX,
  STEP_CHOICES,
  clampVolume,
  faviconUrl,
  normalizePrefs,
  normalizeSite,
  pageUrlForSite,
  siteKeyFromInput,
} from '../shared/config.js';
import { localize, t } from '../shared/i18n.js';

const BACKUP_APP = 'persitevolume';
const BACKUP_VERSION = 1;

const $ = (id) => document.getElementById(id);
const ui = {
  defaultVolume: $('defaultVolume'),
  defaultVolumeValue: $('defaultVolumeValue'),
  maxVolume: $('maxVolume'),
  step: $('step'),
  rememberByDefault: $('rememberByDefault'),
  showBadge: $('showBadge'),
  shortcutsHint: $('shortcutsHint'),
  editShortcuts: $('editShortcuts'),
  siteCount: $('siteCount'),
  addSite: $('addSite'),
  addSiteName: $('addSiteName'),
  addSiteVolume: $('addSiteVolume'),
  addSiteError: $('addSiteError'),
  tableTools: $('tableTools'),
  search: $('search'),
  sitesTable: $('sitesTable'),
  siteRows: $('siteRows'),
  sitesEmpty: $('sitesEmpty'),
  searchEmpty: $('searchEmpty'),
  deleteAll: $('deleteAll'),
  exportSettings: $('exportSettings'),
  importSettings: $('importSettings'),
  importFile: $('importFile'),
  backupMessage: $('backupMessage'),
};

const SVG_NS = 'http://www.w3.org/2000/svg';
const TRASH_ICON =
  'M9 3h6l1 2h4v2H4V5h4l1-2Zm-3 6h12l-.8 11.1A2 2 0 0 1 15.2 22H8.8a2 2 0 0 1-2-1.9L6 9Zm4 2v8h2v-8h-2Zm4 0v8h2v-8h-2Z';

let prefs = normalizePrefs(null);
let sites = new Map(); // site -> entry
let renderPending = false;

const dateFormat = new Intl.DateTimeFormat(chrome.i18n.getUILanguage(), {
  dateStyle: 'medium',
  timeStyle: 'short',
});

function siteLabel(site) {
  return site === FILE_SITE ? t('localFiles') : site;
}

async function loadAll() {
  const all = await chrome.storage.local.get(null);
  prefs = normalizePrefs(all[PREFS_KEY]);
  sites = new Map();
  for (const [key, value] of Object.entries(all)) {
    if (!key.startsWith(SITE_PREFIX)) continue;
    const entry = normalizeSite(value);
    if (entry) sites.set(key.slice(SITE_PREFIX.length), entry);
  }
}

// ---- general settings ----

function fillSelect(select, values, format) {
  select.replaceChildren(
    ...values.map((value) => {
      const option = document.createElement('option');
      option.value = String(value);
      option.textContent = format(value);
      return option;
    }),
  );
}

function renderPrefs() {
  ui.defaultVolume.value = String(prefs.defaultVolume);
  ui.defaultVolumeValue.textContent = `${prefs.defaultVolume}%`;
  ui.maxVolume.value = String(prefs.maxVolume);
  ui.step.value = String(prefs.step);
  ui.rememberByDefault.checked = prefs.rememberByDefault;
  ui.showBadge.checked = prefs.showBadge;
}

async function savePrefs(changes) {
  prefs = normalizePrefs({ ...prefs, ...changes });
  await chrome.storage.local.set({ [PREFS_KEY]: prefs });
}

async function renderShortcuts() {
  const commands = await chrome.commands.getAll();
  const keys = Object.fromEntries(commands.map((command) => [command.name, command.shortcut]));
  const none = t('shortcutNotSet');
  ui.shortcutsHint.textContent = t('shortcutsHint', [keys['volume-up'] || none, keys['volume-down'] || none]);
}

// ---- saved sites ----

function volumeEditor(site, entry) {
  const box = document.createElement('div');
  box.className = 'editor';
  const range = document.createElement('input');
  range.type = 'range';
  range.min = '0';
  range.max = String(Math.max(prefs.maxVolume, entry.volume));
  range.step = '5';
  range.value = String(entry.volume);
  range.setAttribute('aria-label', t('volumeFor', siteLabel(site)));
  const number = document.createElement('input');
  number.type = 'number';
  number.min = '0';
  number.max = String(MAX_VOLUME);
  number.step = '1';
  number.value = String(entry.volume);
  number.setAttribute('aria-label', t('volumeFor', siteLabel(site)));
  const unit = document.createElement('span');
  unit.className = 'unit';
  unit.textContent = '%';

  const mark = (volume) => box.parentElement?.classList.toggle('boost', volume > 100);
  range.addEventListener('input', () => {
    number.value = range.value;
    mark(range.valueAsNumber);
  });
  range.addEventListener('change', () => saveSite(site, range.valueAsNumber));
  number.addEventListener('change', () => {
    const volume = clampVolume(number.value);
    if (volume === null) {
      number.value = String(entry.volume);
      return;
    }
    number.value = String(volume);
    range.value = String(volume);
    mark(volume);
    saveSite(site, volume);
  });
  box.append(range, number, unit);
  return box;
}

function siteRow(site, entry) {
  const row = document.createElement('tr');
  row.dataset.site = site;

  const name = document.createElement('td');
  const nameBox = document.createElement('div');
  nameBox.className = 'site-cell';
  const icon = document.createElement('img');
  icon.src = faviconUrl(pageUrlForSite(site, entry), 16);
  icon.alt = '';
  const label = document.createElement('span');
  label.textContent = siteLabel(site);
  label.title = siteLabel(site);
  nameBox.append(icon, label);
  name.append(nameBox);

  const volume = document.createElement('td');
  volume.className = entry.volume > 100 ? 'volume-cell boost' : 'volume-cell';
  volume.append(volumeEditor(site, entry));

  const updated = document.createElement('td');
  updated.className = 'updated';
  updated.textContent = entry.updated ? dateFormat.format(new Date(entry.updated)) : '-';

  const actions = document.createElement('td');
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'icon-button';
  remove.title = t('deleteSite', siteLabel(site));
  remove.setAttribute('aria-label', t('deleteSite', siteLabel(site)));
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', TRASH_ICON);
  svg.append(path);
  remove.append(svg);
  remove.addEventListener('click', () => {
    // The row goes away; keep keyboard focus somewhere useful.
    (sites.size > 1 ? ui.search : ui.addSiteName).focus();
    chrome.storage.local.remove(SITE_PREFIX + site);
  });
  actions.append(remove);

  row.append(name, volume, updated, actions);
  return row;
}

function renderSites() {
  // Never rebuild the table under a volume being edited; catch up on blur.
  const active = document.activeElement;
  if (active instanceof HTMLInputElement && ui.sitesTable.contains(active)) {
    renderPending = true;
    return;
  }
  renderPending = false;
  const query = ui.search.value.trim().toLowerCase();
  const all = [...sites.entries()].sort(([a], [b]) => a.localeCompare(b));
  const shown = query ? all.filter(([site]) => siteLabel(site).toLowerCase().includes(query)) : all;
  ui.siteRows.replaceChildren(...shown.map(([site, entry]) => siteRow(site, entry)));
  ui.siteCount.textContent = all.length ? String(all.length) : '';
  ui.sitesTable.hidden = shown.length === 0;
  ui.tableTools.hidden = all.length === 0;
  ui.sitesEmpty.hidden = all.length > 0;
  ui.searchEmpty.hidden = all.length === 0 || shown.length > 0;
  ui.deleteAll.disabled = all.length === 0;
}

async function saveSite(site, volume) {
  const entry = sites.get(site) ?? {};
  await chrome.storage.local.set({ [SITE_PREFIX + site]: { ...entry, volume, updated: Date.now() } });
}

async function addSite(event) {
  event.preventDefault();
  const site = siteKeyFromInput(ui.addSiteName.value);
  const volume = clampVolume(ui.addSiteVolume.value);
  ui.addSiteError.hidden = true;
  if (!site) {
    ui.addSiteError.textContent = t('invalidSite');
    ui.addSiteError.hidden = false;
    ui.addSiteName.focus();
    return;
  }
  if (volume === null) {
    ui.addSiteError.textContent = t('invalidVolume');
    ui.addSiteError.hidden = false;
    ui.addSiteVolume.focus();
    return;
  }
  await saveSite(site, volume);
  ui.addSiteName.value = '';
}

async function deleteAll() {
  if (!sites.size || !confirm(t('deleteAllConfirm', String(sites.size)))) return;
  await chrome.storage.local.remove([...sites.keys()].map((site) => SITE_PREFIX + site));
}

// ---- backup ----

function showBackupMessage(kind, text) {
  ui.backupMessage.dataset.kind = kind;
  ui.backupMessage.textContent = text;
}

function exportSettings() {
  const backup = {
    app: BACKUP_APP,
    version: BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    prefs,
    sites: Object.fromEntries([...sites.entries()].sort(([a], [b]) => a.localeCompare(b))),
  };
  const blob = new Blob([`${JSON.stringify(backup, null, 2)}\n`], { type: 'application/json' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `persitevolume-${new Date().toISOString().slice(0, 10)}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 10_000);
  showBackupMessage('ok', t('exportDone', String(sites.size)));
}

async function importSettings(file) {
  let backup;
  try {
    backup = JSON.parse(await file.text());
  } catch {
    backup = null;
  }
  if (!backup || typeof backup !== 'object' || !backup.sites || typeof backup.sites !== 'object') {
    showBackupMessage('error', t('importInvalid'));
    return;
  }
  const writes = {};
  for (const [key, value] of Object.entries(backup.sites)) {
    const site = siteKeyFromInput(key);
    const entry = normalizeSite(value);
    if (site && entry) writes[SITE_PREFIX + site] = entry;
  }
  if (backup.prefs) writes[PREFS_KEY] = normalizePrefs(backup.prefs);
  await chrome.storage.local.set(writes);
  showBackupMessage('ok', t('importDone', String(Object.keys(writes).filter((key) => key !== PREFS_KEY).length)));
}

// ---- setup ----

function bindEvents() {
  ui.defaultVolume.addEventListener('input', () => {
    ui.defaultVolumeValue.textContent = `${ui.defaultVolume.value}%`;
  });
  ui.defaultVolume.addEventListener('change', () => savePrefs({ defaultVolume: ui.defaultVolume.valueAsNumber }));
  ui.maxVolume.addEventListener('change', () => savePrefs({ maxVolume: Number(ui.maxVolume.value) }));
  ui.step.addEventListener('change', () => savePrefs({ step: Number(ui.step.value) }));
  ui.rememberByDefault.addEventListener('change', () => savePrefs({ rememberByDefault: ui.rememberByDefault.checked }));
  ui.showBadge.addEventListener('change', () => savePrefs({ showBadge: ui.showBadge.checked }));
  ui.editShortcuts.addEventListener('click', () => chrome.tabs.create({ url: 'chrome://extensions/shortcuts' }));
  ui.addSite.addEventListener('submit', addSite);
  ui.search.addEventListener('input', renderSites);
  ui.sitesTable.addEventListener('focusout', () => {
    setTimeout(() => {
      if (renderPending) renderSites();
    });
  });
  ui.deleteAll.addEventListener('click', deleteAll);
  ui.exportSettings.addEventListener('click', exportSettings);
  ui.importSettings.addEventListener('click', () => ui.importFile.click());
  ui.importFile.addEventListener('change', async () => {
    const [file] = ui.importFile.files;
    ui.importFile.value = '';
    if (file) await importSettings(file);
  });
  window.addEventListener('focus', renderShortcuts);

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    let sitesChanged = false;
    for (const [key, { newValue }] of Object.entries(changes)) {
      if (key === PREFS_KEY) {
        prefs = normalizePrefs(newValue);
        renderPrefs();
        sitesChanged = true; // slider ranges follow the maximum
      } else if (key.startsWith(SITE_PREFIX)) {
        const entry = normalizeSite(newValue);
        const site = key.slice(SITE_PREFIX.length);
        if (entry) sites.set(site, entry);
        else sites.delete(site);
        sitesChanged = true;
      }
    }
    if (sitesChanged) renderSites();
  });
}

async function init() {
  localize();
  document.title = t('optionsTitle');
  fillSelect(ui.maxVolume, MAX_CHOICES, (value) => `${value}%`);
  fillSelect(ui.step, STEP_CHOICES, (value) => `${value}%`);
  await loadAll();
  renderPrefs();
  renderSites();
  bindEvents();
  await renderShortcuts();
  document.documentElement.dataset.ready = '';
}

init();
