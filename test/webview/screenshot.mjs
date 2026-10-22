// Builds the webview, drives test/webview/harness.html in headless Chromium, takes screenshots into
// test/webview/out/ and checks the messages the webview posts. Run: npm run test:webview
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../..');
const out = join(here, 'out');
mkdirSync(out, { recursive: true });

const require = createRequire(import.meta.url);
function loadPlaywright() {
  try { return require('playwright'); } catch {
    return require('/usr/local/lib/node_modules/@playwright/cli/node_modules/playwright');
  }
}

execFileSync(process.execPath, ['esbuild.mjs'], { cwd: repo, stdio: 'inherit' });

const { chromium } = loadPlaywright();
const harness = pathToFileURL(join(here, 'harness.html')).href;
const failures = [];
const check = (ok, what) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failures.push(what);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch({ args: ['--no-sandbox'] });
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 720 } });
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') pageErrors.push(m.text()); });

  async function open(query, width = 1200, height = 720) {
    await page.setViewportSize({ width, height });
    await page.evaluate(() => sessionStorage.clear()).catch(() => {});
    await page.goto(`${harness}?${query}`);
    await page.waitForSelector('.app', { timeout: 5000 });
  }
  async function shot(name) {
    const noOverflow = await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth
      && document.documentElement.scrollHeight <= document.documentElement.clientHeight);
    check(noOverflow, `${name}: page does not overflow the viewport`);
    await page.screenshot({ path: join(out, `${name}.png`) });
  }
  const posted = () => page.evaluate(() => window.__posted);
  const edits = async () => (await posted()).filter((m) => m.type === 'edit').flatMap((m) => m.ops);
  const hasEdit = (ops, path) => ops.some((o) => JSON.stringify(o.path) === JSON.stringify(path));

  // Dark theme, split screen.
  await open('theme=dark');
  check((await posted())[0]?.type === 'ready', 'posts ready on load');
  const [left, right] = await Promise.all([page.locator('.pane-request').boundingBox(), page.locator('.pane-response').boundingBox()]);
  check(left && right && left.x + left.width <= right.x && Math.abs(left.y - right.y) < 2, 'request and response panes are side by side');
  const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  check(bg === 'rgb(30, 30, 30)', `body uses --vscode-editor-background (got ${bg})`);
  await shot('dark');

  const urlTitle = await page.getAttribute('.url-input input', 'title');
  check(/baseUrl.*env\/local\.yaml/.test(urlTitle ?? '') && /orgId.*path parameter/.test(urlTitle ?? ''), `url tooltip names variable sources (got ${JSON.stringify(urlTitle)})`);
  check(await page.locator('.field-mirror .tok-missing').count() === 0 && await page.locator('.url-input .tok-variable').count() === 1, 'url variables are highlighted');

  // Dragging the divider changes the ratio and keeps it in VS Code state.
  const div = await page.locator('.divider').boundingBox();
  await page.mouse.move(div.x + div.width / 2, div.y + 200);
  await page.mouse.down();
  await page.mouse.move(360, div.y + 200, { steps: 5 });
  await page.mouse.up();
  const ratio = await page.evaluate(() => JSON.parse(sessionStorage.getItem('vscodeState') ?? '{}').ratio);
  check(Math.abs(ratio - 0.3) < 0.02, `divider drag stores the ratio (got ${ratio})`);
  await page.reload();
  await page.waitForSelector('.pane-request');
  const w = (await page.locator('.pane-request').boundingBox()).width;
  check(Math.abs(w - 360) < 6, `ratio survives a reload (request pane ${w}px)`);
  await page.evaluate(() => sessionStorage.clear());

  // Method select posts an edit right away.
  await page.selectOption('.method-select', 'PUT');
  check(JSON.stringify((await edits()).find((o) => hasEdit([o], ['method']))) === '{"op":"set","path":["method"],"value":"PUT"}', 'method select posts set ["method"]');

  // URL edits are debounced.
  await page.click('.url-input input');
  await page.keyboard.press('End');
  await page.keyboard.type('?x=1');
  await sleep(100);
  check(!hasEdit(await edits(), ['url']), 'url edit is debounced (nothing posted after 100 ms)');
  await sleep(400);
  const urlOp = (await edits()).filter((o) => hasEdit([o], ['url'])).pop();
  check(urlOp?.value === '{{baseUrl}}/users/{{orgId}}/members?x=1', `url input posts set ["url"] (got ${JSON.stringify(urlOp)})`);

  // A state arriving while the input is focused does not move the cursor or replace the text.
  await page.keyboard.type('2');
  await page.evaluate(() => {
    const s = structuredClone(window.__fixture.state);
    s.request.url = 'https://other.example';
    window.postMessage(s, '*');
  });
  await sleep(50);
  const focusState = await page.evaluate(() => {
    const el = document.querySelector('.url-input input');
    return { focused: document.activeElement === el, value: el.value, caret: el.selectionStart };
  });
  check(focusState.focused && focusState.value === '{{baseUrl}}/users/{{orgId}}/members?x=12' && focusState.caret === focusState.value.length,
    `focused url input keeps its text and caret on new state (got ${JSON.stringify(focusState)})`);

  // Ctrl+Enter sends (after flushing the pending edit); Escape cancels while sending.
  await page.keyboard.press('Control+Enter');
  const afterSend = await posted();
  const sendAt = afterSend.findIndex((m) => m.type === 'send');
  check(sendAt >= 0, 'Ctrl+Enter posts send');
  check(afterSend.slice(0, sendAt).some((m) => m.type === 'edit' && m.ops.some((o) => o.value === '{{baseUrl}}/users/{{orgId}}/members?x=12')),
    'pending url edit is flushed before send');
  await page.evaluate(() => window.postMessage({ type: 'sending' }, '*'));
  await sleep(50);
  check(await page.locator('.send-button', { hasText: 'Cancel' }).count() === 1, 'Send button becomes Cancel while sending');
  await page.keyboard.press('Escape');
  check((await posted()).some((m) => m.type === 'cancel'), 'Escape while sending posts cancel');

  // After blur, the committed text stays until the host echoes it; an unfocused input follows the host.
  await open('theme=dark');
  await page.click('.url-input input');
  await page.keyboard.press('End');
  await page.keyboard.type('Z');
  await sleep(400);
  await page.click('.pane-request .tab-body', { position: { x: 400, y: 400 } });
  await sleep(50);
  const urlValue = () => page.inputValue('.url-input input');
  check((await urlValue()).endsWith('/membersZ'), 'blurred input keeps the committed text before the host echoes it');
  await page.evaluate(() => window.postMessage(window.__fixture.state, '*'));
  await sleep(50);
  check(await urlValue() === '{{baseUrl}}/users/{{orgId}}/members', 'a state without the edit (rejected) restores the host value');
  await page.evaluate(() => {
    const s = structuredClone(window.__fixture.state);
    s.request.url = 'https://changed.example/{{id}}';
    window.postMessage(s, '*');
  });
  await sleep(50);
  check(await urlValue() === 'https://changed.example/{{id}}', 'unfocused input shows the new host value');

  // Key/value table: the empty last row inserts an entry.
  await open('theme=dark');
  await page.click('.request-tabs .tab:has-text("Headers")');
  await page.fill('.kv-row.kv-new .kv-name input', 'X-New');
  await sleep(400);
  const ins = (await edits()).find((o) => o.op === 'insert');
  check(JSON.stringify(ins) === '{"op":"insert","path":["headers"],"index":2,"value":{"name":"X-New","value":""}}', `new header row posts insert (got ${JSON.stringify(ins)})`);
  await page.locator('.kv-row:not(.kv-readonly) .kv-enabled').first().click();
  check(hasEdit(await edits(), ['headers', 0, 'enabled']), 'header checkbox posts ["headers", 0, "enabled"]');
  const tags = await page.locator('.kv-readonly .kv-tag').allTextContents();
  check(JSON.stringify(tags) === '["from root","from users"]', `inherited headers name their folder (got ${JSON.stringify(tags)})`);
  const roTitle = await page.locator('.kv-readonly .kv-value').nth(1).getAttribute('title');
  check(/team.*env\/local\.yaml/.test(roTitle ?? ''), `inherited header value has a variable tooltip (got ${JSON.stringify(roTitle)})`);
  await page.evaluate(() => { window.__posted.length = 0; });
  await shot('headers');

  await page.click('.request-tabs .tab:has-text("Body")');
  check(await page.locator('.field-area .tok-missing').count() === 1, 'JSON body underlines the missing variable');

  // Settings: inherited hints; two quick edits on an absent map set the map once, then a sub-key.
  await page.click('.request-tabs .tab:has-text("Settings")');
  const settingsText = await page.locator('.pane-request .tab-body').textContent();
  check(settingsText.includes('inherited from users: false') && settingsText.includes('inherited from the root folder: 30s'), 'settings show inherited values');
  check(!(await page.isChecked('.form-check:has-text("Follow redirects") input')), 'follow redirects shows the inherited false');
  await page.click('.form-check:has-text("Follow redirects") input');
  await page.fill('.form-row:has-text("Timeout") input', '5s');
  await page.click('.pane-request .tab-body', { position: { x: 400, y: 400 } });
  const sOps = (await edits()).map((o) => JSON.stringify(o));
  check(JSON.stringify(sOps) === JSON.stringify(['{"op":"set","path":["settings"],"value":{"followRedirects":true}}', '{"op":"set","path":["settings","timeout"],"value":"5s"}']),
    `settings edits on an absent map (got ${JSON.stringify(sOps)})`);
  await page.evaluate(() => { window.__posted.length = 0; });

  for (const tab of ['Auth', 'Body', 'Settings']) {
    await page.click(`.request-tabs .tab:has-text("${tab}")`);
    await shot(tab.toLowerCase());
  }
  await page.click('.response-tabs .tab:has-text("Headers")');
  await shot('response-headers');
  await page.click('.response-tabs .tab:has-text("Timeline")');
  await shot('timeline');

  // Light theme.
  await open('theme=light');
  await shot('light');

  // Narrow: panes stack.
  await open('theme=dark', 560, 900);
  const [l2, r2] = await Promise.all([page.locator('.pane-request').boundingBox(), page.locator('.pane-response').boundingBox()]);
  check(l2 && r2 && l2.y + l2.height <= r2.y + 1, 'panes stack below 600 px');
  await shot('narrow');

  // Parse error: banner, nothing editable.
  await open('theme=dark&fixture=parseError');
  check(await page.locator('.parse-error').count() === 1, 'parse error shows a banner');
  check(await page.locator('.app input, .app textarea, .app select').count() === 0, 'nothing is editable on parse error');
  await page.click('.parse-error button');
  check((await posted()).some((m) => m.type === 'openText'), '"Open as text" posts openText');
  await shot('parse-error');

  await open('theme=light&fixture=failed');
  check(await page.locator('.response-error').count() === 1, 'failed send shows the error');
  await shot('failed');

  await open('theme=dark&fixture=image');
  check(await page.locator('.response-image img').count() === 1, 'image response renders an <img>');
  await shot('image');

  await open('theme=light&fixture=empty');
  await shot('empty');

  check(pageErrors.length === 0, `no page errors (${pageErrors.join('; ')})`);
} finally {
  await browser.close();
}

console.log(`\nscreenshots: ${out}`);
if (failures.length) {
  console.error(`${failures.length} check(s) failed`);
  process.exit(1);
}
console.log('all checks passed');
