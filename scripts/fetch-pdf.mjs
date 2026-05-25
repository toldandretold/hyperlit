#!/usr/bin/env node
// PDF fetcher — spawned by PlaywrightPdfFetcher.php for URL imports that
// need a real browser (Cloudflare JS challenges, JS-rendered PDF links,
// citation_pdf_url meta-tag scrape, session cookies).
//
// Stdin protocol (JSON): { url, dest, landing?, progressFile? }
// Stdout protocol (JSON): { ok: true, bytes, strategy, finalUrl }
//                      or { ok: false, reason, detail?, httpStatus?, finalUrl? }

import { chromium } from 'playwright';
import { writeFile } from 'node:fs/promises';

const HARD_TIMEOUT_MS = 20_000;
const NAV_TIMEOUT_MS = 14_000;
const REQ_TIMEOUT_MS = 14_000;

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

let finished = false;
function output(payload, code) {
    if (finished) return;
    finished = true;
    process.stdout.write(JSON.stringify(payload));
    process.exit(code);
}
const succeed = (payload) => output({ ok: true, ...payload }, 0);
const fail = (reason, extra = {}) => output({ ok: false, reason, ...extra }, 1);

const hardTimeout = setTimeout(() => fail('network_timeout', { detail: 'hard timeout exceeded' }), HARD_TIMEOUT_MS);

async function readStdin() {
    let raw = '';
    for await (const chunk of process.stdin) raw += chunk;
    return raw;
}

async function writeProgress(file, stage, detail, percent) {
    if (!file) return;
    try {
        await writeFile(file, JSON.stringify({
            status: 'processing',
            stage,
            detail,
            percent,
            updated_at: new Date().toISOString(),
        }, null, 2));
    } catch {
        // Progress is best-effort.
    }
}

// Cloudflare's "Just a moment..." interstitial sets a clearance cookie after
// running its JS challenge. The first page load lands on the challenge; we
// have to wait for it to redirect to the real content before scraping.
async function waitOutCloudflare(page, budgetMs = 6000) {
    const start = Date.now();
    while (Date.now() - start < budgetMs) {
        const title = await page.title().catch(() => '');
        if (!/just a moment|attention required|cloudflare/i.test(title)) return;
        await page.waitForTimeout(400);
    }
}

async function main() {
    let raw;
    try {
        raw = await readStdin();
    } catch (e) {
        return fail('bad_input', { detail: 'stdin read failed: ' + e.message });
    }
    let input;
    try {
        input = JSON.parse(raw);
    } catch (e) {
        return fail('bad_input', { detail: 'stdin JSON parse: ' + e.message });
    }
    const { url, dest, landing, progressFile } = input || {};
    if (!url || !dest) return fail('bad_input', { detail: 'missing url or dest' });

    let browser;
    try {
        // channel: 'chromium' uses the full Chromium binary (not headless-shell),
        // which is much harder for Cloudflare to fingerprint as a headless bot.
        browser = await chromium.launch({
            channel: 'chromium',
            headless: true,
            args: [
                '--disable-blink-features=AutomationControlled',
                '--disable-features=IsolateOrigins,site-per-process',
            ],
        });
    } catch (e) {
        return fail('browser_launch_failed', { detail: e.message });
    }

    const context = await browser.newContext({
        userAgent: UA,
        viewport: { width: 1280, height: 800 },
        acceptDownloads: true,
        locale: 'en-US',
        timezoneId: 'America/New_York',
        extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' },
    });

    // Minimal stealth: hide the most obvious headless tells. Cloudflare's challenge
    // runs in the page context, so init scripts override these before its checks fire.
    await context.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
        Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
        Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
        window.chrome = { runtime: {} };
    });

    const page = await context.newPage();

    try {
        await writeProgress(progressFile, 'fetching_pdf_navigating', 'Navigating to publisher…', 15);

        let pdfBytes = null;
        let finalUrl = url;
        let strategy = 'A';

        // Strategy A: fetch the URL directly via context.request (raw HTTP, no page
        // rendering). Avoids Chromium's PDF viewer interception that turns PDF
        // navigations into HTML wrapper responses. Works for arXiv, open repos,
        // and any site that serves PDF without needing browser-set cookies.
        try {
            const resp = await context.request.get(url, { timeout: REQ_TIMEOUT_MS });
            if (resp.ok()) {
                const ct = (resp.headers()['content-type'] || '').toLowerCase();
                const body = await resp.body();
                if (ct.includes('pdf') && body.length > 4 && body[0] === 0x25 && body[1] === 0x50) {
                    pdfBytes = body;
                    finalUrl = resp.url();
                }
            }
        } catch {
            // Network error — fall through to strategy B.
        }

        // Strategy B: browser-navigate the landing page (clears cookies/CF challenge),
        // scrape citation_pdf_url, then fetch that URL with warm session cookies.
        if (!pdfBytes) {
            strategy = 'B';
            await writeProgress(progressFile, 'fetching_pdf_locating', 'Locating PDF link…', 18);

            const targetLanding = landing || url;
            try {
                await page.goto(targetLanding, { waitUntil: 'load', timeout: NAV_TIMEOUT_MS });
            } catch (e) {
                return fail('navigation_failed', { detail: e.message });
            }

            await waitOutCloudflare(page);

            const pdfLink = await page.evaluate(() => {
                const meta = document.querySelector('meta[name="citation_pdf_url"]');
                if (meta?.content) return meta.content;
                const a = document.querySelector('a[href$=".pdf"], a[href*=".pdf?"]');
                return a?.href || null;
            }).catch(() => null);

            if (!pdfLink) {
                const title = await page.title().catch(() => '');
                if (/just a moment|attention required|cloudflare/i.test(title)) {
                    return fail('cloudflare_block', { detail: 'CF challenge not cleared' });
                }
                return fail('no_pdf_link_found', { finalUrl: page.url() });
            }

            await writeProgress(progressFile, 'fetching_pdf_downloading', 'Downloading PDF…', 22);

            const absolute = new URL(pdfLink, page.url()).toString();
            const resp = await context.request.get(absolute, {
                headers: { Referer: page.url() },
                timeout: REQ_TIMEOUT_MS,
            });
            if (!resp.ok()) {
                const status = resp.status();
                return fail(status === 403 || status === 401 ? 'cloudflare_block' : 'http_error', {
                    httpStatus: status,
                    finalUrl: absolute,
                });
            }
            pdfBytes = await resp.body();
            finalUrl = absolute;
        }

        if (!pdfBytes || pdfBytes.length < 5) {
            return fail('not_a_pdf', { detail: 'empty body' });
        }
        // %PDF magic bytes
        if (pdfBytes[0] !== 0x25 || pdfBytes[1] !== 0x50 || pdfBytes[2] !== 0x44 || pdfBytes[3] !== 0x46) {
            return fail('not_a_pdf', { detail: 'magic bytes mismatch', finalUrl });
        }

        await writeFile(dest, pdfBytes);
        clearTimeout(hardTimeout);
        succeed({ bytes: pdfBytes.length, strategy, finalUrl });
    } catch (e) {
        return fail('browser_crash', { detail: e.message });
    } finally {
        await context.close().catch(() => {});
        await browser.close().catch(() => {});
    }
}

main().catch((e) => fail('browser_crash', { detail: e?.message || String(e) }));
