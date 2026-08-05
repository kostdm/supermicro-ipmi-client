/**
 * End-to-end check of the application against a live BMC: launches the built
 * Electron app, connects to the server and captures console screenshots.
 *
 * `npm run build` has to be run first.
 * Run: npm run e2e -- <host> [user] [password]
 *
 * The interface is bilingual, so every control is addressed through its
 * data-testid rather than through its visible text.
 */
import { mkdirSync } from 'node:fs';
import { _electron as electron } from 'playwright-core';
import { fail, parseTarget } from './args';

const { host, user, password } = parseTarget('e2e');
const SHOT_DIR = '.data/e2e';

async function main() {
  mkdirSync(SHOT_DIR, { recursive: true });

  const app = await electron.launch({
    args: ['.'],
    env: { ...process.env, ELECTRON_ENABLE_LOGGING: '1' },
  });

  const page = await app.firstWindow();
  page.on('console', (msg) => console.log(`[renderer] ${msg.text()}`));
  page.on('pageerror', (err) => console.error(`[renderer error] ${err.message}`));

  await page.waitForSelector('.servers');
  await page.screenshot({ path: `${SHOT_DIR}/01-servers.png` });
  console.log('Server list rendered');

  // Add a server through the form.
  await page.click('[data-testid="add-server"]');
  await page.fill('[data-testid="field-name"]', 'Test BMC');
  await page.fill('[data-testid="field-host"]', host);
  await page.fill('[data-testid="field-user"]', user);
  await page.fill('[data-testid="field-password"]', password);
  await page.click('[data-testid="save-server"]');
  await page.waitForSelector('.server-card');
  await page.screenshot({ path: `${SHOT_DIR}/02-saved.png` });
  console.log('Server saved');

  await page.click('[data-testid="connect"]');

  // Wait for a picture: the canvas only becomes visible after the first frame.
  await page.waitForSelector('.console__canvas:visible', { timeout: 40_000 });
  console.log('First video frame rendered');

  // Give a few more frames and the power status time to arrive.
  await page.waitForTimeout(4000);
  await page.screenshot({ path: `${SHOT_DIR}/03-console.png` });

  const info = await page.evaluate(() => {
    const canvas = document.querySelector('canvas');
    const badge = document.querySelector('.badge');
    return {
      width: canvas?.width ?? 0,
      height: canvas?.height ?? 0,
      power: badge?.textContent ?? '',
    };
  });
  console.log(`Console resolution: ${info.width}x${info.height}, ${info.power}`);

  // A shot of the console area alone shows the decoding quality.
  const canvas = page.locator('.console__canvas');
  await canvas.screenshot({ path: `${SHOT_DIR}/04-screen.png` });

  // Keyboard check: NumLock does not affect the server, but the BMC answers
  // with a changed indicator state — which means the packet arrived.
  const numLedOn = () =>
    page.locator('.led:has-text("Num")').evaluate((el) => el.classList.contains('led--on'));
  const before = await numLedOn();
  await page.keyboard.press('NumLock');
  await page.waitForTimeout(2500);
  const after = await numLedOn();
  console.log(
    `Keyboard: the Num indicator was ${before ? 'lit' : 'unlit'} -> ` +
      `${after ? 'lit' : 'unlit'} ${before !== after ? '(the server took the keypress)' : '(NO CHANGE)'}`,
  );
  if (before === after) process.exitCode = 1;

  // Put the indicator back the way it was.
  await page.keyboard.press('NumLock');
  await page.waitForTimeout(1500);

  // The sensor panel: a separate IPMI over LAN session on port 623.
  await page.click('[data-testid="tab-sensors"]');
  await page.waitForSelector('.sensor-table', { timeout: 40_000 });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${SHOT_DIR}/05-sensors.png` });
  const sensorCount = await page.locator('.sensor-table tr').count();
  console.log(`Sensor panel: ${sensorCount} rows`);
  if (sensorCount === 0) process.exitCode = 1;

  await page.click('[data-testid="tab-console"]');
  await page.click('[data-testid="disconnect"]');
  await page.waitForSelector('.servers');
  console.log('Disconnected cleanly');

  await app.close();
  console.log(`\nScreenshots in ${SHOT_DIR}/`);
}

main().catch(fail);
