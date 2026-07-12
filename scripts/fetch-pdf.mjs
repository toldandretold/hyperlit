#!/usr/bin/env node
// PDF fetcher — spawned by PlaywrightPdfFetcher.php for URL imports that
// need a real browser (Cloudflare JS challenges, JS-rendered PDF links,
// citation_pdf_url meta-tag scrape, session cookies).
//
// Stdin protocol (JSON): { url, dest, landing?, progressFile? }
// Stdout protocol (JSON): { ok: true, bytes, strategy, finalUrl }
//                      or { ok: false, reason, detail?, httpStatus?, finalUrl? }

import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { writeFile } from 'node:fs/promises';

// Full anti-fingerprint stealth (webdriver, plugins, chrome runtime, WebGL,
// permissions, …) — far more thorough than hand-rolled navigator overrides,
// and enough to clear most Cloudflare JS challenges. Note: the REAL blocker
// for a datacenter server IP is IP reputation, fixed by SOURCE_FETCH_PROXY.
chromium.use(StealthPlugin());

const HARD_TIMEOUT_MS = 34_000;
const NAV_TIMEOUT_MS = 20_000;
const REQ_TIMEOUT_MS = 16_000;

// A Cloudflare interstitial can take a good few seconds to run its JS and set
// the clearance cookie; give it real time before giving up.
const CF_WAIT_MS = 18_000;

// Optional residential/rotating proxy — the actual fix for datacenter-IP CF
// blocks. Parsed from SOURCE_FETCH_PROXY (e.g. http://user:pass@host:port).
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

const rand = (min, max) => min + Math.floor(Math.random() * (max - min));

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

// Cloudflare's "Just a moment..." interstitial sets a cf_clearance cookie
// after running its JS challenge, then redirects to the real content. Wait
// for EITHER the challenge to clear from the title OR the clearance cookie to
// appear — polling patiently, since a managed challenge can take 5–15s.
async function waitOutCloudflare(page, context, budgetMs = CF_WAIT_MS) {
    const start = Date.now();
    while (Date.now() - start < budgetMs) {
        const title = await page.title().catch(() => '');
        const challenged = /just a moment|attention required|cloudflare|checking your browser/i.test(title);
        if (!challenged) return true;
        const cookies = await context.cookies().catch(() => []);
        if (cookies.some((c) => c.name === 'cf_clearance')) return true;
        await page.waitForTimeout(500);
    }
    return false;
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
        // The stealth plugin (chromium.use above) patches the rest.
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
        acceptDownloads: true,
        locale: 'en-US',
        timezoneId: 'America/New_York',
        extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' },
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

            await waitOutCloudflare(page, context);

            // A brief human-like pause + scroll before scraping — lets late CF
            // redirects and lazy content settle, and looks less robotic.
            await page.waitForTimeout(rand(600, 1400));
            await page.mouse.wheel(0, rand(200, 600)).catch(() => {});

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
