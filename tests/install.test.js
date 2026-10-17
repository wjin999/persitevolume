// Installing the extension while tabs are already playing: they are taken over
// without a reload.
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';
import {
  EXTENSION_DIR,
  assertLevel,
  baseArgs,
  createProfile,
  engineStatus,
  extensionIdFor,
  openController,
  setVolume,
  startServer,
  tabIdOf,
} from './helpers.js';

let server;
let context;
let profile;

before(async () => {
  server = await startServer();
  profile = await createProfile();
  // Start without the extension; it gets installed through the DevTools
  // protocol once the tabs are open.
  context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium',
    headless: !process.env.HEADED,
    args: [...baseArgs(), '--enable-unsafe-extension-debugging'],
    ignoreDefaultArgs: ['--disable-extensions', '--mute-audio'],
  });
});

after(async () => {
  await context?.close();
  if (profile) await rm(profile, { recursive: true, force: true });
  await server?.close();
});

test('tabs that were already open are controlled right after installing', async () => {
  const plain = await context.newPage();
  await plain.goto(server.url('before-install', 'media.html'));
  const framed = await context.newPage();
  await framed.goto(server.url('before-install-outer', 'frame.html', 'frame=before-install-inner.localhost'));

  const session = await context.browser().newBrowserCDPSession();
  const worker = context.waitForEvent('serviceworker');
  const { id } = await session.send('Extensions.loadUnpacked', { path: EXTENSION_DIR });
  assert.equal(id, extensionIdFor(EXTENSION_DIR));
  await worker;

  const browser = { context, id, controller: null };
  await openController(browser);
  for (const page of [plain, framed]) {
    const tabId = await tabIdOf(browser, page);
    await assertLevel(browser, tabId, 100, 'untouched until changed');
    await setVolume(browser, tabId, 200);
    await assertLevel(browser, tabId, 200);
    await setVolume(browser, tabId, 50);
    await assertLevel(browser, tabId, 50);
    assert.ok((await engineStatus(browser, tabId)).frames >= 1);
  }
});
