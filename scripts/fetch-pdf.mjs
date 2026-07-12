#!/usr/bin/env node
// PDF fetcher — spawned by ContentFetchService / PlaywrightPdfFetcher for URL
// imports that need a real browser (Cloudflare managed challenges, JS-rendered
// PDF links, citation_pdf_url scrape, session cookies).
//
// Beats Cloudflare via patchright + a sticky residential IP + HEADED (see
// scripts/lib/cfBrowser.mjs). The KEYSTONE fix over the old script: the PDF is
// captured with an IN-PAGE fetch inside the cleared session (same IP,
// cf_clearance carried), NOT a separate raw request that re-triggers the wall.
//
// Stdin protocol (JSON): { url, dest, landing?, proxy?, progressFile? }
// Stdout protocol (JSON): { ok: true, bytes, strategy, finalUrl, channel }
//                      or { ok: false, reason, detail?, httpStatus?, finalUrl? }

import { writeFile } from 'node:fs/promises';
import {
    proxyFromInput, launchStealthContext, cleanupContext,
    waitOutCloudflare, inPageFetchBase64,
} from './lib/cfBrowser.mjs';

// Headed CF solves run long; keep the hard timeout under the PHP process cap (75s).
const HARD_TIMEOUT_MS = 68_000;
const NAV_TIMEOUT_MS = 30_000;

const rand = (min, max) => min + Math.floor(Math.random() * (max - min));

let finished = false;
function output(payload, code) {
    if (finished) return;
    finished = true;
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

async function writeProgress(file, stage, detail, percent) {
    if (!file) return;
    try {
        await writeFile(file, JSON.stringify({
            status: 'processing', stage, detail, percent,
            updated_at: new Date().toISOString(),
        }, null, 2));
    } catch { /* best-effort */ }
}

const looksLikePdf = (u) => /\.pdf(\?|$)|\/pdf\/|\/pdf(\?|$)|article-pdf|downloadpdf/i.test(u);
const isPdfBytes = (buf) => buf && buf.length > 4 && buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46;

async function main() {
    let input;
    try {
        input = JSON.parse(await readStdin());
    } catch (e) {
        return fail('bad_input', { detail: 'stdin JSON parse: ' + e.message });
    }
    const { url, dest, landing, progressFile } = input || {};
    if (!url || !dest) return fail('bad_input', { detail: 'missing url or dest' });

    let ctx, userDataDir, channel;
    try {
        ({ ctx, userDataDir, channel } = await launchStealthContext(proxyFromInput(input)));
    } catch (e) {
        return fail('browser_launch_failed', { detail: e.message });
    }

    const page = ctx.pages()[0] || await ctx.newPage();

    try {
        await writeProgress(progressFile, 'fetching_pdf_navigating', 'Navigating to publisher…', 15);

        // Navigate the LANDING page (article page / doi.org redirect) to clear
        // Cloudflare for the domain, so the in-page PDF fetch inherits clearance.
        // The PDF endpoint itself is a poor place to solve the challenge.
        const targetLanding = landing || url;
        try {
            await page.goto(targetLanding, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
        } catch (e) {
            return fail('navigation_failed', { detail: e.message });
        }

        const cf = await waitOutCloudflare(page, ctx);
        if (!cf.cleared) {
            const title = await page.title().catch(() => '');
            return fail('cloudflare_block', { detail: 'CF challenge not cleared', finalUrl: page.url(), title });
        }

        // Human-like settle so late CF redirects / lazy content land.
        await page.waitForTimeout(rand(600, 1400));
        await page.mouse.wheel(0, rand(200, 600)).catch(() => {});

        // Resolve the concrete PDF URL: the given url if it's a PDF, else scrape
        // citation_pdf_url from the (now cleared) landing page.
        let pdfUrl = url;
        if (!looksLikePdf(url)) {
            await writeProgress(progressFile, 'fetching_pdf_locating', 'Locating PDF link…', 18);
            const scraped = await page.evaluate(() => {
                const meta = document.querySelector('meta[name="citation_pdf_url"]');
                if (meta?.content) return meta.content;
                const a = document.querySelector('a[href$=".pdf"], a[href*=".pdf?"], a[href*="/pdf/"]');
                return a?.href || null;
            }).catch(() => null);
            if (scraped) pdfUrl = new URL(scraped, page.url()).toString();
        }

        await writeProgress(progressFile, 'fetching_pdf_downloading', 'Downloading PDF…', 22);

        // Capture INSIDE the cleared session (Phase 3 keystone). The in-page
        // fetch carries cf_clearance + same-origin cookies on the sticky IP.
        let strategy = 'in_page_fetch';
        let res = await inPageFetchBase64(page, pdfUrl, page.url());
        let pdfBytes = res.ok && res.b64 ? Buffer.from(res.b64, 'base64') : null;

        // Fallback: navigate the PDF directly and catch the download event
        // (some publishers serve the PDF as a forced download, not fetchable).
        if (!isPdfBytes(pdfBytes)) {
            strategy = 'download_event';
            const dlPromise = page.waitForEvent('download', { timeout: 12_000 }).catch(() => null);
            page.goto(pdfUrl, { waitUntil: 'commit', timeout: NAV_TIMEOUT_MS }).catch(() => {});
            const dl = await dlPromise;
            if (dl) {
                const p = await dl.path().catch(() => null);
                if (p) {
                    const { readFile } = await import('node:fs/promises');
                    const buf = await readFile(p).catch(() => null);
                    if (isPdfBytes(buf)) pdfBytes = buf;
                }
            }
        }

        if (!isPdfBytes(pdfBytes)) {
            const detail = res.ok === false
                ? `in-page fetch ${res.status || res.err || 'failed'}`
                : 'no PDF bytes captured';
            const blocked = res.status === 403 || res.status === 401;
            return fail(blocked ? 'cloudflare_block' : 'not_a_pdf', { detail, finalUrl: pdfUrl });
        }

        await writeFile(dest, pdfBytes);
        clearTimeout(hardTimeout);
        succeed({ bytes: pdfBytes.length, strategy, finalUrl: pdfUrl, channel });
    } catch (e) {
        return fail('browser_crash', { detail: e.message });
    } finally {
        await cleanupContext(ctx, userDataDir);
    }
}

main().catch((e) => fail('browser_crash', { detail: e?.message || String(e) }));
