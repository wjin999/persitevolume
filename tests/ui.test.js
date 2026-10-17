// The popup and the options page, driven like a user would.
import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { assertLevel, launch, open, savedSite, setVolume, startServer, storage, tabIdOf, waitFor } from './helpers.js';

const SCREENSHOTS = fileURLToPath(new URL('../test-results/', import.meta.url));

let server;
let browser;

before(async () => {
  server = await startServer();
  browser = await launch();
  await mkdir(SCREENSHOTS, { recursive: true });
});

after(async () => {
  await browser?.close();
  await server?.close();
});

async function openPopup(tabId) {
  const popup = await browser.context.newPage();
  await popup.setViewportSize({ width: 344, height: 600 });
  await popup.goto(`chrome-extension://${browser.id}/src/popup/popup.html?tab=${tabId}`);
  await popup.waitForSelector('#app:not([aria-busy])');
  return popup;
}

async function openOptions() {
  const page = await browser.context.newPage();
  await page.setViewportSize({ width: 900, height: 1000 });
  await page.goto(`chrome-extension://${browser.id}/src/options/options.html`);
  await page.waitForSelector('html[data-ready]');
  return page;
}

describe('popup', () => {
  test('changes and remembers the volume of the tab', async () => {
    const page = await open(browser, server.url('popup', 'media.html'));
    const tabId = await tabIdOf(browser, page);
    const popup = await openPopup(tabId);
    const site = server.site('popup');

    assert.equal(await popup.textContent('#siteName'), site);
    assert.equal(await popup.inputValue('#value'), '100');
    assert.equal(await popup.textContent('#siteMode'), 'Default volume');
    assert.equal(await popup.isChecked('#remember'), true);

    await popup.click('.preset[data-volume="200"]');
    assert.equal((await savedSite(browser, site, (entry) => entry?.volume === 200)).volume, 200);
    await assertLevel(browser, tabId, 200);
    assert.equal(await popup.getAttribute('.preset[data-volume="200"]', 'aria-pressed'), 'true');
    await popup.waitForFunction(() => document.getElementById('siteMode').textContent === 'Saved for this site');

    await popup.click('#decrease');
    await savedSite(browser, site, (entry) => entry?.volume === 190);
    assert.equal(await popup.inputValue('#value'), '190');

    await popup.fill('#value', '250');
    await popup.press('#value', 'Enter');
    await savedSite(browser, site, (entry) => entry?.volume === 250);

    await popup.focus('#slider');
    await popup.keyboard.press('ArrowRight');
    await savedSite(browser, site, (entry) => entry?.volume === 251);

    await popup.waitForFunction(() => document.getElementById('status').textContent.includes('1'));
    await popup.waitForFunction(() => document.querySelector('#tabList .tab-volume')?.textContent === '251%');
    await popup.screenshot({ path: `${SCREENSHOTS}popup.png`, fullPage: true });
    await popup.emulateMedia({ colorScheme: 'dark' });
    await popup.screenshot({ path: `${SCREENSHOTS}popup-dark.png`, fullPage: true });
    await popup.emulateMedia({ colorScheme: 'light' });

    await popup.click('#remember');
    await savedSite(browser, site, (entry) => entry === undefined);
    await popup.waitForFunction(() => document.getElementById('siteMode').textContent === 'This tab only');
    await assertLevel(browser, tabId, 251, 'the tab keeps its volume');
    await popup.close();
    await page.close();
  });

  test('explains when media cannot be boosted and offers enhanced mode', async () => {
    const src = server.url('cdn', 'tone.wav');
    const page = await open(browser, server.url('popup-cors', 'media.html', `src=${encodeURIComponent(src)}`));
    const tabId = await tabIdOf(browser, page);
    const popup = await openPopup(tabId);
    await popup.click('.preset[data-volume="300"]');
    await popup.waitForSelector('#notice:not([hidden])');
    assert.match(await popup.textContent('#noticeText'), /can't go above 100%/);
    assert.equal(await popup.textContent('#noticeAction'), 'Use enhanced mode');
    await popup.screenshot({ path: `${SCREENSHOTS}popup-notice.png`, fullPage: true });

    await popup.click('#noticeAction');
    await popup.waitForFunction(() => document.getElementById('enhanced').checked);
    assert.equal(await popup.isHidden('#notice'), true);
    await popup.click('#enhanced');
    await popup.waitForFunction(() => !document.getElementById('enhanced').checked);
    await popup.close();
    await page.close();
  });

  test('does not blame short sound effects on an unreachable source', async () => {
    const src = encodeURIComponent(server.url('sounds-cdn', 'click.wav'));
    const page = await open(browser, server.url('popup-moves', 'move-element.html', `src=${src}`));
    const tabId = await tabIdOf(browser, page);
    await setVolume(browser, tabId, 25);
    await page.click('#move');
    // Chrome keeps the tab marked as playing for a moment after the sound ends.
    await waitFor(() => browser.controller.evaluate(async (id) => (await chrome.tabs.get(id)).audible, tabId), {
      message: 'tab marked as playing',
    });
    const popup = await openPopup(tabId);
    await popup.waitForFunction(() => document.getElementById('status').textContent !== '');
    assert.equal(await popup.isHidden('#notice'), true, await popup.textContent('#noticeText'));
    await popup.close();
    await page.close();
  });

  test('lists the tabs playing audio', async () => {
    const quiet = await open(browser, server.url('popup-list-quiet', 'webaudio.html'));
    const loud = await open(browser, server.url('popup-list-loud', 'media.html'));
    const loudId = await tabIdOf(browser, loud);
    const popup = await openPopup(loudId);
    await popup.waitForFunction(() => document.querySelectorAll('#tabList .tab').length >= 2);
    const titles = await popup.$$eval('#tabList .tab-title', (nodes) => nodes.map((node) => node.textContent));
    assert.ok(titles.includes('media') && titles.includes('webaudio'), titles.join(', '));
    assert.equal(
      await popup.$eval('#tabList .tab[aria-current="true"] .tab-title', (node) => node.textContent),
      'media',
    );
    await popup.close();
    await quiet.close();
    await loud.close();
  });

  test('says when a page cannot be controlled', async () => {
    const page = await open(browser, 'about:blank');
    // Without access to a page Chrome does not tell the extension its URL.
    const tabId = await browser.controller.evaluate(
      async () => (await chrome.tabs.query({})).find((tab) => !tab.url)?.id,
    );
    const popup = await openPopup(tabId);
    assert.equal(await popup.isVisible('#unsupported'), true);
    assert.equal(await popup.isHidden('#control'), true);
    await popup.close();
    await page.close();
  });

  test('is translated', async () => {
    const chinese = await launch({ args: ['--lang=zh-CN'], env: { LANGUAGE: 'zh_CN', LANG: 'zh_CN.UTF-8' } });
    try {
      const page = await chinese.context.newPage();
      await page.goto(server.url('popup-zh', 'media.html'));
      const tabId = await chinese.controller.evaluate(
        async (url) => (await chrome.tabs.query({})).find((tab) => tab.url === url)?.id,
        page.url(),
      );
      const popup = await chinese.context.newPage();
      await popup.setViewportSize({ width: 344, height: 600 });
      await popup.goto(`chrome-extension://${chinese.id}/src/popup/popup.html?tab=${tabId}`);
      await popup.waitForSelector('#app:not([aria-busy])');
      await popup.click('.preset[data-volume="150"]');
      await popup.waitForFunction(() => document.getElementById('siteMode').textContent === '已为此网站保存');
      assert.equal(await popup.textContent('.toggle-title'), '记住此网站的音量');
      await popup.waitForFunction(() => document.getElementById('status').textContent !== '');
      await popup.screenshot({ path: `${SCREENSHOTS}popup-zh_CN.png`, fullPage: true });
    } finally {
      await chinese.close();
    }
  });
});

describe('options page', () => {
  test('adds, edits and forgets sites', async () => {
    const options = await openOptions();
    await options.fill('#addSiteName', 'not a site');
    await options.click('#addSite button[type="submit"]');
    assert.equal(await options.isVisible('#addSiteError'), true);

    await options.fill('#addSiteName', 'https://www.Example.org/some/page');
    await options.fill('#addSiteVolume', '175');
    await options.click('#addSite button[type="submit"]');
    await savedSite(browser, 'example.org', (entry) => entry?.volume === 175);
    const row = options.locator('#siteRows tr[data-site="example.org"]');
    await row.waitFor();

    await row.locator('input[type="number"]').fill('80');
    await row.locator('input[type="number"]').press('Enter');
    await savedSite(browser, 'example.org', (entry) => entry?.volume === 80);

    await options.fill('#search', 'nothing-like-this');
    assert.equal(await options.isVisible('#searchEmpty'), true);
    await options.fill('#search', 'example');
    await row.waitFor();
    await options.screenshot({ path: `${SCREENSHOTS}options.png`, fullPage: true });

    await row.locator('.icon-button').click();
    await savedSite(browser, 'example.org', (entry) => entry === undefined);
    await row.waitFor({ state: 'detached' });
    await options.close();
  });

  test('saves the general settings', async () => {
    const options = await openOptions();
    await options.selectOption('#maxVolume', '300');
    await options.click('label[for="rememberByDefault"]');
    await waitFor(async () => {
      const { prefs } = await storage(browser);
      return prefs?.maxVolume === 300 && prefs.rememberByDefault === false;
    });
    await browser.controller.evaluate(() => chrome.storage.local.remove('prefs'));
    await options.close();
  });

  test('exports and imports a backup', async () => {
    await browser.controller.evaluate(() =>
      chrome.storage.local.set({ 'site:exported.example': { volume: 140, updated: 1 } }),
    );
    const options = await openOptions();
    await options.locator('#siteRows tr[data-site="exported.example"]').waitFor();
    const [download] = await Promise.all([options.waitForEvent('download'), options.click('#exportSettings')]);
    const backup = JSON.parse(await readFile(await download.path(), 'utf8'));
    assert.equal(backup.app, 'persitevolume');
    assert.equal(backup.sites['exported.example'].volume, 140);

    const file = {
      name: 'backup.json',
      mimeType: 'application/json',
      buffer: Buffer.from(
        JSON.stringify({ app: 'persitevolume', version: 1, sites: { 'www.imported.example': 260, 'bad site': 10 } }),
      ),
    };
    await options.setInputFiles('#importFile', file);
    await savedSite(browser, 'imported.example', (entry) => entry?.volume === 260);
    assert.match(await options.textContent('#backupMessage'), /Imported 1 site/);

    await options.setInputFiles('#importFile', { ...file, buffer: Buffer.from('not json') });
    await options.waitForFunction(() => document.getElementById('backupMessage').dataset.kind === 'error');
    await options.close();
  });
});
