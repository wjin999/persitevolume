// Pages that only play short sound effects, such as the move sounds of chess
// sites. Their move sounds are often too loud and there is no volume setting.
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
  { name: 'Web Audio, the way lichess.org does', file: 'move-webaudio.html', boosts: true },
  { name: 'a new Audio() per move from another origin', file: 'move-element.html', query: () => `src=${cdnClick()}` },
  { name: 'Howler.js using Web Audio', file: 'move-howler.html', boosts: true },
  {
    name: 'Howler.js using HTML5 Audio from another origin',
    file: 'move-howler.html',
    query: () => `html5&src=${cdnClick()}`,
  },
];

for (const [index, player] of PLAYERS.entries()) {
  test(`move sounds played with ${player.name} are turned down from the first move on`, async () => {
    const page = await open(browser, server.url(`chess-${index}`, player.file, player.query?.() ?? ''));
    await page.evaluate(() => window.ready);
    const tabId = await tabIdOf(browser, page);
    const move = () => page.click('#move');

    await assertShot(browser, tabId, move, 100, 'untouched');
    await setVolume(browser, tabId, 25);
    await assertShot(browser, tabId, move, 25, 'turned down');
    const status = await engineStatus(browser, tabId);
    assert.ok(status.recent + status.graphs > 0, 'the popup can tell where the sound came from');

    // Remembered for the site: after a reload the very first move is quiet too.
    await page.reload();
    await page.evaluate(() => window.ready);
    await assertShot(browser, tabId, move, 25, 'first move after reloading');

    await setVolume(browser, tabId, 200);
    if (player.boosts) await assertShot(browser, tabId, move, 200, 'boosted');
    else await assertShot(browser, tabId, move, 100, 'another origin: never boosted, never silenced');
    await page.close();
  });
}

test('in enhanced mode a change made between two moves applies to the next move', async () => {
  const page = await open(browser, server.url('chess-enhanced', 'move-webaudio.html'));
  await page.evaluate(() => window.ready);
  const tabId = await tabIdOf(browser, page);
  const state = await send(browser, { type: 'startCapture', tabId });
  assert.equal(state.error, undefined, state.error);

  const peakOfMove = async () => {
    const level = send(browser, { target: 'offscreen', type: 'level', tabId, duration: 700 });
    await sleep(200);
    await page.click('#move');
    return ((await level).peak / CLICK_AMPLITUDE) * 100;
  };
  assert.ok(Math.abs((await peakOfMove()) - 100) < 10, 'untouched');
  await setVolume(browser, tabId, 25);
  await sleep(300);
  const quieter = await peakOfMove();
  assert.ok(Math.abs(quieter - 25) < 2.5, `expected 25%, got ${quieter.toFixed(1)}%`);

  await send(browser, { type: 'stopCapture', tabId });
  await assertShot(browser, tabId, () => page.click('#move'), 25, 'back to the page engine');
  await page.close();
});
