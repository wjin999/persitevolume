// End-to-end tests: real Chromium with the extension, real audio, measured.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import {
  assertLevel,
  engineStatus,
  launch,
  open,
  reloadExtension,
  savedSite,
  send,
  setVolume,
  sleep,
  startServer,
  storage,
  tabIdOf,
} from './helpers.js';

let server;
let browser;

before(async () => {
  server = await startServer();
  browser = await launch();
});

after(async () => {
  await browser?.close();
  await server?.close();
});

describe('volume control', () => {
  test('100% leaves the page untouched', async () => {
    const page = await open(browser, server.url('untouched', 'media.html'));
    const tabId = await tabIdOf(browser, page);
    await assertLevel(browser, tabId, 100);
    const status = await engineStatus(browser, tabId);
    assert.equal(status.frames, 1);
    assert.equal(status.playing, 1);
    assert.equal(status.boosted + status.scaled, 0);
    await page.close();
  });

  test('turning down scales the audio while the page keeps its own volume', async () => {
    const page = await open(browser, server.url('down', 'media.html'));
    const tabId = await tabIdOf(browser, page);
    await setVolume(browser, tabId, 50);
    await assertLevel(browser, tabId, 50);
    assert.equal(await page.evaluate(() => document.getElementById('media').volume), 1);
    // The site's own volume control multiplies with ours.
    await page.evaluate(() => {
      document.getElementById('media').volume = 0.5;
    });
    await assertLevel(browser, tabId, 25);
    assert.equal(await page.evaluate(() => document.getElementById('media').volume), 0.5);
    const status = await engineStatus(browser, tabId);
    assert.equal(status.scaled, 1);
    assert.equal(status.boosted, 0);
    await page.close();
  });

  test('boosting above 100% amplifies, and 0% is silent', async () => {
    const page = await open(browser, server.url('boost', 'media.html'));
    const tabId = await tabIdOf(browser, page);
    await setVolume(browser, tabId, 200);
    await assertLevel(browser, tabId, 200);
    assert.equal((await engineStatus(browser, tabId)).boosted, 1);
    await setVolume(browser, tabId, 300);
    await assertLevel(browser, tabId, 300);
    await setVolume(browser, tabId, 50);
    await assertLevel(browser, tabId, 50);
    assert.equal(await page.evaluate(() => document.getElementById('media').volume), 1);
    await setVolume(browser, tabId, 0);
    await assertLevel(browser, tabId, 0);
    await page.close();
  });

  test('the badge shows the volume', async () => {
    const page = await open(browser, server.url('badge', 'media.html'));
    const tabId = await tabIdOf(browser, page);
    const badge = () => browser.controller.evaluate((id) => chrome.action.getBadgeText({ tabId: id }), tabId);
    assert.equal(await badge(), '');
    await setVolume(browser, tabId, 250);
    assert.equal(await badge(), '250');
    await page.reload();
    await sleep(300);
    assert.equal(await badge(), '250', 'restored after navigation');
    await setVolume(browser, tabId, 100);
    assert.equal(await badge(), '');
    await page.close();
  });
});

describe('remembering sites', () => {
  test('a site keeps its volume after reloading and in new tabs, www included', async () => {
    const page = await open(browser, server.url('remember', 'media.html'));
    const tabId = await tabIdOf(browser, page);
    await setVolume(browser, tabId, 150);
    const saved = await savedSite(browser, server.site('remember'));
    assert.equal(saved.volume, 150);
    assert.equal(saved.origin, `http://${server.site('remember')}`);

    await page.reload();
    await assertLevel(browser, tabId, 150, 'after reload');

    const second = await open(browser, server.url('remember', 'media.html', 'second'));
    await assertLevel(browser, await tabIdOf(browser, second), 150, 'new tab');

    const www = await open(browser, server.url('www.remember', 'media.html'));
    await assertLevel(browser, await tabIdOf(browser, www), 150, 'www. host');

    const other = await open(browser, server.url('elsewhere', 'media.html'));
    await assertLevel(browser, await tabIdOf(browser, other), 100, 'another site');

    for (const p of [page, second, www, other]) await p.close();
  });

  test('a volume for one tab only is not saved and ends when the tab leaves the site', async () => {
    const first = await open(browser, server.url('temporary', 'media.html'));
    const second = await open(browser, server.url('temporary', 'media.html', 'second'));
    const firstId = await tabIdOf(browser, first);
    const secondId = await tabIdOf(browser, second);

    const state = await setVolume(browser, firstId, 40, false);
    assert.equal(state.mode, 'tab');
    await assertLevel(browser, firstId, 40);
    await assertLevel(browser, secondId, 100, 'other tab of the site');
    await sleep(400);
    assert.equal((await storage(browser))[`site:${server.site('temporary')}`], undefined, 'nothing saved');

    await first.goto(server.url('temporary-elsewhere', 'media.html'));
    await assertLevel(browser, firstId, 100, 'on another site');
    await first.goto(server.url('temporary', 'media.html'));
    await assertLevel(browser, firstId, 100, 'back on the site');
    await first.close();
    await second.close();
  });

  test('turning "remember" off forgets the site, turning it on saves the current volume', async () => {
    const page = await open(browser, server.url('toggle', 'media.html'));
    const other = await open(browser, server.url('toggle', 'media.html', 'other'));
    const tabId = await tabIdOf(browser, page);
    const otherId = await tabIdOf(browser, other);
    const key = `site:${server.site('toggle')}`;

    await setVolume(browser, tabId, 180);
    await assertLevel(browser, otherId, 180, 'other tab follows the site');

    let state = await send(browser, { type: 'setRemember', tabId, remember: false });
    assert.equal(state.mode, 'tab');
    assert.equal((await storage(browser))[key], undefined);
    await assertLevel(browser, tabId, 180, 'this tab keeps its volume');
    await assertLevel(browser, otherId, 100, 'other tab back to default');

    state = await send(browser, { type: 'setRemember', tabId, remember: true });
    assert.equal(state.mode, 'site');
    assert.equal((await savedSite(browser, server.site('toggle'))).volume, 180);
    await assertLevel(browser, otherId, 180);
    await page.close();
    await other.close();
  });

  test('changes made on the options page reach open tabs', async () => {
    const page = await open(browser, server.url('options-edit', 'media.html'));
    const tabId = await tabIdOf(browser, page);
    await browser.controller.evaluate(
      (key) => chrome.storage.local.set({ [key]: { volume: 220, updated: Date.now() } }),
      `site:${server.site('options-edit')}`,
    );
    await assertLevel(browser, tabId, 220);
    await browser.controller.evaluate((key) => chrome.storage.local.remove(key), `site:${server.site('options-edit')}`);
    await assertLevel(browser, tabId, 100);

    const fresh = await open(browser, server.url('default-volume', 'media.html'));
    const freshId = await tabIdOf(browser, fresh);
    await browser.controller.evaluate(() => chrome.storage.local.set({ prefs: { defaultVolume: 60 } }));
    await assertLevel(browser, freshId, 60, 'default volume');
    await browser.controller.evaluate(() => chrome.storage.local.remove('prefs'));
    await assertLevel(browser, freshId, 100);
    await page.close();
    await fresh.close();
  });
});

describe('audio sources', () => {
  test('media from another site without CORS is turned down but never silenced by a boost', async () => {
    const src = server.url('cdn', 'tone.wav');
    const page = await open(browser, server.url('cors', 'media.html', `src=${encodeURIComponent(src)}`));
    const tabId = await tabIdOf(browser, page);
    await setVolume(browser, tabId, 50);
    await assertLevel(browser, tabId, 50);
    await setVolume(browser, tabId, 250);
    await assertLevel(browser, tabId, 100, 'stays at 100%');
    assert.equal((await engineStatus(browser, tabId)).issues.cors, 1);
    await page.close();
  });

  test('a same-origin URL redirecting to another site is detected too', async () => {
    const src = `/redirect?to=${encodeURIComponent(server.url('cdn', 'tone.wav'))}`;
    const page = await open(browser, server.url('redirect', 'media.html', `src=${encodeURIComponent(src)}`));
    const tabId = await tabIdOf(browser, page);
    await setVolume(browser, tabId, 250);
    await assertLevel(browser, tabId, 100);
    assert.equal((await engineStatus(browser, tabId)).issues.cors, 1);
    await page.close();
  });

  test('media from another site with CORS can be boosted', async () => {
    const src = server.url('cdn', 'tone.wav', 'cors=1');
    const page = await open(
      browser,
      server.url('cors-ok', 'media.html', `crossorigin=anonymous&src=${encodeURIComponent(src)}`),
    );
    const tabId = await tabIdOf(browser, page);
    await setVolume(browser, tabId, 250);
    await assertLevel(browser, tabId, 250);
    await page.close();
  });

  test('Media Source Extensions playback (YouTube, Bilibili, …) is turned down and boosted', async () => {
    const page = await open(browser, server.url('mse', 'mse.html'));
    assert.equal(await page.evaluate(() => window.ready), true);
    const tabId = await tabIdOf(browser, page);
    await assertLevel(browser, tabId, 100);
    await setVolume(browser, tabId, 50);
    await assertLevel(browser, tabId, 50);
    await setVolume(browser, tabId, 250);
    await assertLevel(browser, tabId, 250);
    const status = await engineStatus(browser, tabId);
    assert.equal(status.boosted, 1);
    assert.deepEqual(status.issues, {});
    await page.close();
  });

  test("the page's own Web Audio is controlled", async () => {
    const page = await open(browser, server.url('webaudio', 'webaudio.html'));
    const tabId = await tabIdOf(browser, page);
    await assertLevel(browser, tabId, 100);
    await setVolume(browser, tabId, 50);
    await assertLevel(browser, tabId, 50);
    await setVolume(browser, tabId, 200);
    await assertLevel(browser, tabId, 200);
    assert.equal((await engineStatus(browser, tabId)).graphs, 1);
    await page.close();
  });

  test('Audio objects that are never added to the page are controlled', async () => {
    const page = await open(browser, server.url('detached', 'detached.html'));
    const tabId = await tabIdOf(browser, page);
    await setVolume(browser, tabId, 200);
    await assertLevel(browser, tabId, 200);
    await setVolume(browser, tabId, 50);
    await assertLevel(browser, tabId, 50);
    await page.close();
  });

  test('media inside a closed shadow root is controlled', async () => {
    const page = await open(browser, server.url('shadow', 'shadow.html'));
    const tabId = await tabIdOf(browser, page);
    await setVolume(browser, tabId, 200);
    await assertLevel(browser, tabId, 200);
    await page.close();
  });

  test("frames from other sites follow the tab's site", async () => {
    await browser.controller.evaluate(
      (key) => chrome.storage.local.set({ [key]: { volume: 30, updated: Date.now() } }),
      `site:${server.site('framed')}`,
    );
    const page = await open(browser, server.url('outer', 'frame.html', `frame=framed.localhost`));
    const tabId = await tabIdOf(browser, page);
    await assertLevel(browser, tabId, 100, "the frame's own site setting does not apply");
    await setVolume(browser, tabId, 200);
    await assertLevel(browser, tabId, 200);
    await page.close();
  });

  for (const useConstructor of [false, true]) {
    const how = useConstructor ? 'new MediaElementAudioSourceNode()' : 'createMediaElementSource()';
    test(`a page routing boosted media into its own graph (${how}) keeps the volume`, async () => {
      const page = await open(browser, server.url(`takeover-${Number(useConstructor)}`, 'takeover.html'));
      const tabId = await tabIdOf(browser, page);
      await setVolume(browser, tabId, 200);
      await assertLevel(browser, tabId, 200, 'boosted by us');
      assert.equal(await page.evaluate((flag) => window.takeOver(flag), useConstructor), true);
      await assertLevel(browser, tabId, 200, 'after the page took over');
      await setVolume(browser, tabId, 50);
      await assertLevel(browser, tabId, 50);
      await page.close();
    });
  }

  test('media the page routed itself is not turned down twice', async () => {
    const page = await open(browser, server.url('own-graph', 'takeover.html'));
    const tabId = await tabIdOf(browser, page);
    await page.evaluate(() => window.takeOver(false));
    await setVolume(browser, tabId, 50);
    await assertLevel(browser, tabId, 50);
    await setVolume(browser, tabId, 200);
    await assertLevel(browser, tabId, 200);
    await page.close();
  });
});

describe('enhanced mode', () => {
  test('captures the tab and applies the volume to the captured audio', async () => {
    const page = await open(browser, server.url('enhanced', 'media.html'));
    const tabId = await tabIdOf(browser, page);
    await setVolume(browser, tabId, 200);

    let state = await send(browser, { type: 'startCapture', tabId });
    assert.equal(state.error, undefined, state.error);
    assert.equal(state.capturing, true);
    const status = await engineStatus(browser, tabId);
    assert.deepEqual(status.gains, [1], 'the page itself is left at 100%');
    const level = () => send(browser, { target: 'offscreen', type: 'level', tabId });
    const relative = async () => ((await level()).level / 0.1414213562) * 100;
    assert.ok(Math.abs((await relative()) - 200) < 20, `captured level ${await relative()}%`);

    await setVolume(browser, tabId, 50);
    await sleep(100);
    assert.ok(Math.abs((await relative()) - 50) < 5, `captured level ${await relative()}%`);

    state = await send(browser, { type: 'stopCapture', tabId });
    assert.equal(state.capturing, false);
    await assertLevel(browser, tabId, 50, 'the page takes over again');
    await page.close();
  });

  test('ends when the captured tab closes', async () => {
    const page = await open(browser, server.url('enhanced-close', 'media.html'));
    const tabId = await tabIdOf(browser, page);
    await send(browser, { type: 'startCapture', tabId });
    await page.close();
    await sleep(300);
    const offscreen = await browser.controller.evaluate(() =>
      chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] }),
    );
    assert.equal(offscreen.length, 0, 'offscreen document closed');
  });
});

describe('extension updates', () => {
  test('open tabs keep working after the extension reloads', async () => {
    const page = await open(browser, server.url('reload', 'media.html'));
    const tabId = await tabIdOf(browser, page);
    await setVolume(browser, tabId, 150);
    await assertLevel(browser, tabId, 150);

    await reloadExtension(browser);
    await assertLevel(browser, tabId, 150, 'right after the reload');
    await setVolume(browser, tabId, 50);
    await assertLevel(browser, tabId, 50, 'controlled by the new version');
    assert.equal((await engineStatus(browser, tabId)).frames, 1, 'one bridge left');
    await page.close();
  });
});
