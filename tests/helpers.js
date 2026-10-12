// Test harness: a local web server, Chromium with the extension loaded, and a
// way to measure how loud a tab really is.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

export const EXTENSION_DIR = realpathSync(fileURLToPath(new URL('../extension', import.meta.url)));
const FIXTURES_DIR = fileURLToPath(new URL('./fixtures/', import.meta.url));

// Every test page plays (or synthesizes) a 440 Hz sine of this amplitude.
export const TONE_AMPLITUDE = 0.2;
export const TONE_RMS = TONE_AMPLITUDE / Math.SQRT2;

function toneWav({ frequency = 440, amplitude = TONE_AMPLITUDE, seconds = 2, rate = 48000 } = {}) {
  // A whole number of periods, so the loop is seamless.
  const frames = rate * seconds;
  const wav = Buffer.alloc(44 + frames * 2);
  wav.write('RIFF', 0);
  wav.writeUInt32LE(36 + frames * 2, 4);
  wav.write('WAVE', 8);
  wav.write('fmt ', 12);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20); // PCM
  wav.writeUInt16LE(1, 22); // mono
  wav.writeUInt32LE(rate, 24);
  wav.writeUInt32LE(rate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(frames * 2, 40);
  for (let i = 0; i < frames; i++) {
    wav.writeInt16LE(Math.round(Math.sin((2 * Math.PI * frequency * i) / rate) * amplitude * 32767), 44 + i * 2);
  }
  return wav;
}

// Serves tests/fixtures and /tone.wav. Any *.localhost host name reaches it,
// and each host is its own site.
export async function startServer() {
  const tone = toneWav();
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost');
    if (url.pathname === '/tone.wav') {
      const headers = { 'Content-Type': 'audio/wav', 'Content-Length': tone.length, 'Cache-Control': 'no-store' };
      if (url.searchParams.has('cors')) headers['Access-Control-Allow-Origin'] = '*';
      response.writeHead(200, headers);
      response.end(tone);
      return;
    }
    if (url.pathname === '/favicon.ico') {
      response.writeHead(204);
      response.end();
      return;
    }
    if (url.pathname === '/redirect') {
      response.writeHead(302, { Location: url.searchParams.get('to'), 'Cache-Control': 'no-store' });
      response.end();
      return;
    }
    try {
      const body = await readFile(path.join(FIXTURES_DIR, path.basename(url.pathname)));
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      response.end(body);
    } catch {
      response.writeHead(404);
      response.end('not found');
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    port,
    site: (name) => `${name}.localhost:${port}`,
    url: (name, file, query = '') => `http://${name}.localhost:${port}/${file}${query ? `?${query}` : ''}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

// The id Chrome gives an unpacked extension without a "key".
export function extensionIdFor(directory) {
  const hash = createHash('sha256').update(directory).digest('hex').slice(0, 32);
  return [...hash].map((digit) => String.fromCharCode(97 + Number.parseInt(digit, 16))).join('');
}

// Chrome flags every test browser needs, extension or not.
export function baseArgs(id = extensionIdFor(EXTENSION_DIR), { autoplay = true } = {}) {
  return [
    // Lets chrome.tabCapture measure any tab without a click on the toolbar button.
    `--allowlisted-extension-id=${id}`,
    '--no-proxy-server',
    ...(autoplay ? ['--autoplay-policy=no-user-gesture-required'] : []),
  ];
}

// Without developer mode Chrome disables an unpacked extension once it reloads.
export async function createProfile() {
  const profile = await mkdtemp(path.join(os.tmpdir(), 'persitevolume-profile-'));
  await mkdir(path.join(profile, 'Default'));
  await writeFile(
    path.join(profile, 'Default', 'Preferences'),
    JSON.stringify({ extensions: { ui: { developer_mode: true } } }),
  );
  return profile;
}

export async function launch({ autoplay = true, args: extraArgs = [], env } = {}) {
  const id = extensionIdFor(EXTENSION_DIR);
  const args = [
    `--disable-extensions-except=${EXTENSION_DIR}`,
    `--load-extension=${EXTENSION_DIR}`,
    ...baseArgs(id, { autoplay }),
    ...extraArgs,
  ];
  const profile = await createProfile();
  const context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium',
    headless: !process.env.HEADED,
    args,
    env: env ? { ...process.env, ...env } : undefined,
    ignoreDefaultArgs: ['--mute-audio'],
  });
  let [worker] = context.serviceWorkers();
  worker ??= await context.waitForEvent('serviceworker');
  assert.ok(worker.url().startsWith(`chrome-extension://${id}/`), `unexpected extension id: ${worker.url()}`);
  const browser = {
    context,
    id,
    controller: null,
    async close() {
      await context.close();
      await rm(profile, { recursive: true, force: true });
    },
  };
  browser.controller = await openController(browser);
  return browser;
}

// An extension page to call chrome.* APIs from.
export async function openController(browser) {
  const page = await browser.context.newPage();
  try {
    await page.goto(`chrome-extension://${browser.id}/src/options/options.html`);
  } catch (error) {
    await page.close();
    throw error;
  }
  browser.controller = page;
  return page;
}

export async function open(browser, url) {
  const page = await browser.context.newPage();
  await page.goto(url);
  return page;
}

export function send(browser, message) {
  return browser.controller.evaluate((m) => chrome.runtime.sendMessage(m), message);
}

export async function tabIdOf(browser, page) {
  const url = page.url();
  const id = await browser.controller.evaluate(
    async (wanted) => (await chrome.tabs.query({})).find((tab) => tab.url === wanted)?.id ?? null,
    url,
  );
  assert.ok(id !== null, `no tab for ${url}`);
  return id;
}

export async function setVolume(browser, tabId, volume, remember = true) {
  const reply = await send(browser, { type: 'setVolume', tabId, volume, remember });
  assert.equal(reply?.error, undefined, reply?.error);
  return reply;
}

export function storage(browser) {
  return browser.controller.evaluate(() => chrome.storage.local.get(null));
}

// What the content scripts of all frames report, summed like the popup does.
export async function engineStatus(browser, tabId) {
  const frames = await browser.controller.evaluate(async (target) => {
    const results = await chrome.scripting.executeScript({
      target: { tabId: target, allFrames: true },
      func: () => globalThis.__persitevolumeBridge?.status() ?? null,
    });
    return results.map((result) => result.result).filter(Boolean);
  }, tabId);
  const total = { frames: frames.length, gains: frames.map((f) => f.gain), issues: {} };
  for (const key of ['media', 'playing', 'boosted', 'scaled', 'viaPage', 'graphs']) {
    total[key] = frames.reduce((sum, frame) => sum + (frame[key] || 0), 0);
  }
  for (const frame of frames) {
    for (const [reason, count] of Object.entries(frame.issues))
      total.issues[reason] = (total.issues[reason] || 0) + count;
  }
  return total;
}

// RMS level of everything the tab outputs, captured the way Volume Master
// captures tabs.
export function measure(browser, tabId, { settle = 350, duration = 500 } = {}) {
  return browser.controller.evaluate(
    async ({ target, settleMs, durationMs }) => {
      const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: target });
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } },
      });
      const context = new AudioContext();
      try {
        await context.resume();
        const analyser = context.createAnalyser();
        analyser.fftSize = 2048;
        context.createMediaStreamSource(stream).connect(analyser);
        const samples = new Float32Array(analyser.fftSize);
        await new Promise((resolve) => setTimeout(resolve, settleMs));
        let sum = 0;
        let count = 0;
        const end = performance.now() + durationMs;
        while (performance.now() < end) {
          analyser.getFloatTimeDomainData(samples);
          for (const sample of samples) sum += sample * sample;
          count += samples.length;
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        return Math.sqrt(sum / count);
      } finally {
        for (const track of stream.getTracks()) track.stop();
        await context.close();
      }
    },
    { target: tabId, settleMs: settle, durationMs: duration },
  );
}

// Asserts that the tab plays at `percent` % of the original level.
export async function assertLevel(browser, tabId, percent, message = '') {
  const level = await measure(browser, tabId);
  const expected = (TONE_RMS * percent) / 100;
  const label = `${message ? `${message}: ` : ''}expected ${percent}% (${expected.toFixed(4)}), got ${level.toFixed(4)} (${((level / TONE_RMS) * 100).toFixed(1)}%)`;
  if (percent === 0) assert.ok(level < 0.002, label);
  else assert.ok(Math.abs(level - expected) / expected < 0.1, label);
  return level;
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Polls until `check` returns something truthy.
export async function waitFor(check, { timeout = 3000, interval = 50, message = 'condition' } = {}) {
  const end = Date.now() + timeout;
  for (;;) {
    let error;
    try {
      const value = await check();
      if (value) return value;
    } catch (caught) {
      error = caught;
    }
    if (Date.now() > end) throw new Error(`timed out waiting for ${message}${error ? `: ${error.message}` : ''}`);
    await sleep(interval);
  }
}

// Saved site settings are written shortly after a change.
export function savedSite(browser, site, predicate = Boolean) {
  return waitFor(
    async () => {
      const entry = (await storage(browser))[`site:${site}`];
      return predicate(entry) ? (entry ?? true) : null;
    },
    { message: `saved setting of ${site}` },
  );
}

// chrome.runtime.reload(), then wait for the new service worker and reopen the controller.
export async function reloadExtension(browser) {
  const worker = browser.context.waitForEvent('serviceworker', { timeout: 10_000 });
  await browser.controller.evaluate(() => chrome.runtime.reload()).catch(() => {});
  await worker;
  await waitFor(() => openController(browser), { timeout: 10_000, interval: 250, message: 'the reloaded extension' });
}
