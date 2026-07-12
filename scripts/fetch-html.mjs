#!/usr/bin/env node
// HTML article-page fetcher — Playwright sibling of fetch-pdf.mjs, spawned by
// ContentFetchService for the citation vacuum when a journal's PDF is walled
// but its HTML reading view is reachable (proven: direct.mit.edu serves HTML
// 200 where the PDF 403s). Clears Cloudflare JS challenges, returns the
// fully-rendered article DOM for the paste engine to convert.
//
// Stdin protocol (JSON):  { url }
// Stdout protocol (JSON): { ok: true, html, finalUrl, title, httpStatus }
//                      or { ok: false, reason, detail?, httpStatus?, finalUrl? }

import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';

// Full anti-fingerprint stealth — clears most Cloudflare JS challenges. The
// real fix for a datacenter server IP is SOURCE_FETCH_PROXY (residential egress).
chromium.use(StealthPlugin());

const HARD_TIMEOUT_MS = 44_000;
const NAV_TIMEOUT_MS = 20_000;
const CF_WAIT_MS = 18_000;
const MAX_ATTEMPTS = 2; // Cloudflare 403s are intermittent — a fresh attempt often clears.

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// Optional residential/rotating proxy (SOURCE_FETCH_PROXY, e.g. http://user:pass@host:port).
function proxyOption() {
    const raw = process.env.SOURCE_FETCH_PROXY;
    if (!raw) return undefined;
    try {
        const u = new URL(raw);
        const opt = { server: `${u.protocol}//${u.host}` };
        if (u.username) opt.username = decodeURIComponent(u.username);
        if (u.password) opt.password = decodeURIComponent(u.password);
        return opt;
    } catch {
        return undefined;
    }
}

let finished = false;
function output(payload, code) {
    if (finished) return;
    finished = true;
    // Wait for the (potentially large) HTML payload to flush before exiting —
    // process.exit() would otherwise truncate stdout mid-write.
    process.stdout.write(JSON.stringify(payload), () => process.exit(code));
}
const succeed = (payload) => output({ ok: true, ...payload }, 0);
const fail = (reason, extra = {}) => output({ ok: false, reason, ...extra }, 1);

const hardTimeout = setTimeout(() => fail('network_timeout', { detail: 'hard timeout exceeded' }), HARD_TIMEOUT_MS);

async function readStdin() {
    let raw = '';
    for await (const chunk of process.stdin) raw += chunk;
    return raw;
}

// Cloudflare's "Just a moment..." interstitial sets a cf_clearance cookie
// after its JS challenge. Wait for the title to clear OR the cookie to appear.
async function waitOutCloudflare(page, context, budgetMs = CF_WAIT_MS) {
    const start = Date.now();
    while (Date.now() - start < budgetMs) {
        const title = await page.title().catch(() => '');
        if (!/just a moment|attention required|cloudflare|checking your browser/i.test(title)) return;
        const cookies = await context.cookies().catch(() => []);
        if (cookies.some((c) => c.name === 'cf_clearance')) return;
        await page.waitForTimeout(500);
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
    const { url } = input || {};
    if (!url) return fail('bad_input', { detail: 'missing url' });

    let browser;
    try {
        // Full Chromium (not headless-shell) — much harder for Cloudflare to
        // fingerprint as a headless bot.
        browser = await chromium.launch({
            channel: 'chromium',
            headless: true,
            proxy: proxyOption(),
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
        locale: 'en-US',
        timezoneId: 'America/New_York',
        extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' },
    });

    const page = await context.newPage();

    try {
        let lastBlock = null;

        for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
            if (attempt > 1) {
                // Cloudflare's challenge is intermittent — pause and retry fresh.
                await page.waitForTimeout(2500);
            }

            let resp;
            try {
                resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
            } catch (e) {
                lastBlock = { reason: 'navigation_failed', detail: e.message };
                continue;
            }

            const httpStatus = resp ? resp.status() : null;

            await waitOutCloudflare(page, context);
            // Small settle for late-rendered article bodies (SPA shells, lazy refs).
            await page.waitForTimeout(1500);

            const title = await page.title().catch(() => '');
            const challenged = /just a moment|attention required|cloudflare|checking your browser/i.test(title);
            const blocked = httpStatus === 403 || httpStatus === 401;

            if (challenged || blocked) {
                lastBlock = { reason: 'cloudflare_block', detail: challenged ? 'CF challenge not cleared' : 'HTTP ' + httpStatus, httpStatus, finalUrl: page.url() };
                continue; // retry
            }
            if (httpStatus && httpStatus >= 400) {
                return fail('http_error', { httpStatus, finalUrl: page.url() });
            }

            const html = await page.content();
            if (!html || html.length < 500) {
                lastBlock = { reason: 'empty_html', detail: `only ${html?.length ?? 0} bytes`, finalUrl: page.url() };
                continue;
            }

            clearTimeout(hardTimeout);
            return succeed({ html, finalUrl: page.url(), title, httpStatus });
        }

        return fail(lastBlock?.reason ?? 'cloudflare_block', lastBlock ?? {});
    } catch (e) {
        return fail('browser_crash', { detail: e.message });
    } finally {
        await context.close().catch(() => {});
        await browser.close().catch(() => {});
    }
}

main().catch((e) => fail('browser_crash', { detail: e?.message || String(e) }));
