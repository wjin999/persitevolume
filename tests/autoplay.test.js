// Chrome's real autoplay rules: Web Audio may only start after a user gesture.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { assertLevel, engineStatus, launch, open, startServer, tabIdOf, waitFor } from './helpers.js';

let server;
let browser;

before(async () => {
  server = await startServer();
  browser = await launch({ autoplay: false });
});

after(async () => {
  await browser?.close();
  await server?.close();
});

async function saveSite(name, volume) {
  await browser.controller.evaluate(
    ([key, value]) => chrome.storage.local.set({ [key]: { volume: value, updated: Date.now() } }),
    [`site:${server.site(name)}`, volume],
  );
}

// No page.evaluate() on these pages: Playwright runs it as a user gesture.
test('a boost starts as soon as the user starts playback', async () => {
  await saveSite('click-to-play', 200);
  const page = await open(browser, server.url('click-to-play', 'media.html', 'manual'));
  const tabId = await tabIdOf(browser, page);
  assert.equal((await engineStatus(browser, tabId)).playing, 0, 'nothing plays before the click');
  await page.click('#play');
  await waitFor(async () => (await engineStatus(browser, tabId)).boosted === 1, { message: 'boost' });
  await assertLevel(browser, tabId, 200);
  await page.close();
});

test('muted autoplay is boosted once the user unmutes it', async () => {
  await saveSite('muted-autoplay', 200);
  const page = await open(browser, server.url('muted-autoplay', 'media.html', 'video&muted'));
  const tabId = await tabIdOf(browser, page);
  await waitFor(async () => (await engineStatus(browser, tabId)).playing === 1, { message: 'muted playback' });
  assert.equal((await engineStatus(browser, tabId)).boosted, 0, 'muted media is left alone');
  await page.click('#unmute');
  await assertLevel(browser, tabId, 200);
  await page.close();
});

test('turning down never needs Web Audio', async () => {
  await saveSite('quiet', 40);
  const page = await open(browser, server.url('quiet', 'media.html', 'manual'));
  const tabId = await tabIdOf(browser, page);
  await page.click('#play');
  await assertLevel(browser, tabId, 40);
  const status = await engineStatus(browser, tabId);
  assert.equal(status.scaled, 1);
  assert.equal(status.boosted, 0);
  await page.close();
});
