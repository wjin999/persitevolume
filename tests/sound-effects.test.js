// Pages that only play short sound effects: notifications, games, clicks, …
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import {
  CLICK_AMPLITUDE,
  assertShot,
  engineStatus,
  launch,
  open,
  send,
  setVolume,
  sleep,
  startServer,
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

const cdnClick = () => encodeURIComponent(server.url('sounds-cdn', 'click.wav'));

const PLAYERS = [
  { name: 'Web Audio buffer sources', file: 'sfx-webaudio.html', boosts: true },
  { name: 'a new Audio() per sound from another origin', file: 'sfx-element.html', query: () => `src=${cdnClick()}` },
  { name: 'Howler.js using Web Audio', file: 'sfx-howler.html', boosts: true },
  {
    name: 'Howler.js using HTML5 Audio from another origin',
    file: 'sfx-howler.html',
    query: () => `html5&src=${cdnClick()}`,
  },
];

for (const [index, player] of PLAYERS.entries()) {
  test(`sound effects played with ${player.name} are turned down from the first sound on`, async () => {
    const page = await open(browser, server.url(`sfx-${index}`, player.file, player.query?.() ?? ''));
    await page.evaluate(() => window.ready);
    const tabId = await tabIdOf(browser, page);
    const playSound = () => page.click('#sound');

    await assertShot(browser, tabId, playSound, 100, 'untouched');
    await setVolume(browser, tabId, 25);
    await assertShot(browser, tabId, playSound, 25, 'turned down');
    const status = await engineStatus(browser, tabId);
    assert.ok(status.recent + status.graphs > 0, 'the popup can tell where the sound came from');

    // Remembered for the site: after a reload the very first sound is quiet too.
    await page.reload();
    await page.evaluate(() => window.ready);
    await assertShot(browser, tabId, playSound, 25, 'first sound after reloading');

    await setVolume(browser, tabId, 200);
    if (player.boosts) await assertShot(browser, tabId, playSound, 200, 'boosted');
    else await assertShot(browser, tabId, playSound, 100, 'another origin: never boosted, never silenced');
    await page.close();
  });
}

test('in enhanced mode a change made between two sounds applies to the next sound', async () => {
  const page = await open(browser, server.url('sfx-enhanced', 'sfx-webaudio.html'));
  await page.evaluate(() => window.ready);
  const tabId = await tabIdOf(browser, page);
  const state = await send(browser, { type: 'startCapture', tabId });
  assert.equal(state.error, undefined, state.error);

  const peakOfSound = async () => {
    const level = send(browser, { target: 'offscreen', type: 'level', tabId, duration: 700 });
    await sleep(200);
    await page.click('#sound');
    return ((await level).peak / CLICK_AMPLITUDE) * 100;
  };
  assert.ok(Math.abs((await peakOfSound()) - 100) < 10, 'untouched');
  await setVolume(browser, tabId, 25);
  await sleep(300);
  const quieter = await peakOfSound();
  assert.ok(Math.abs(quieter - 25) < 2.5, `expected 25%, got ${quieter.toFixed(1)}%`);

  await send(browser, { type: 'stopCapture', tabId });
  await assertShot(browser, tabId, () => page.click('#sound'), 25, 'back to the page engine');
  await page.close();
});
