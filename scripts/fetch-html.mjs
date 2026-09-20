#!/usr/bin/env node
// HTML article-page fetcher — sibling of fetch-pdf.mjs, spawned by
// ContentFetchService when a journal's PDF is walled but its HTML reading view
// is reachable (proven: direct.mit.edu serves HTML 200 where the PDF 403s).
// Clears Cloudflare via patchright + sticky IP + headed (scripts/lib/cfBrowser.mjs),
// returns the fully-rendered article DOM for the paste engine.
//
// Stdin protocol (JSON):  { url, proxy?, direct? }
// Stdout protocol (JSON): { ok: true, html, finalUrl, title, httpStatus, channel }
//                      or { ok: false, reason, detail?, httpStatus?, finalUrl? }
// Env: FETCH_HTML_BUDGET_MS caps the whole attempt (see below). It is an env
//      var rather than a stdin field because the timeouts are armed before
//      stdin has been read.

import {
    proxyFromInput, launchStealthContext, cleanupContext, waitOutCloudflare,
} from './lib/cfBrowser.mjs';

// Defaults suit HARVEST, where one article is worth a minute: a Cloudflare
// managed challenge can genuinely take ~25s to clear and the work is queued.
// CITATION resolution is the opposite trade — it runs dozens of URLs inside a
// single review, so a hard-walled page burning the full 62s is 62s of nothing
// (measured: thewalrus.ca and fbi.gov each cost 62.5s to learn "blocked"). Pass
// budgetMs to buy a smaller share of the same ladder; both timeouts scale from
// it, and MAX_ATTEMPTS drops to 1 when there is no room for a second pass.
const DEFAULT_BUDGET_MS = 62_000; // under the PHP process cap (70s)
const requestedBudget = Number(process.env.FETCH_HTML_BUDGET_MS) || 0;
const HARD_TIMEOUT_MS = Math.max(8_000, requestedBudget || DEFAULT_BUDGET_MS);
const NAV_TIMEOUT_MS = Math.min(30_000, Math.round(HARD_TIMEOUT_MS * 0.5));
const MAX_ATTEMPTS = HARD_TIMEOUT_MS >= 40_000 ? 2 : 1; // CF 403s are intermittent — a fresh attempt often clears.

let finished = false;
function output(payload, code) {
    if (finished) return;
    finished = true;
    // Flush the (large) HTML payload before exiting — process.exit would truncate.
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

async function main() {
    let input;
    try {
        input = JSON.parse(await readStdin());
    } catch (e) {
        return fail('bad_input', { detail: 'stdin JSON parse: ' + e.message });
    }
    const { url } = input || {};
    if (!url) return fail('bad_input', { detail: 'missing url' });

    let ctx, userDataDir, channel;
    try {
        ({ ctx, userDataDir, channel } = await launchStealthContext(proxyFromInput(input)));
    } catch (e) {
        return fail('browser_launch_failed', { detail: e.message });
    }

    const page = ctx.pages()[0] || await ctx.newPage();

    try {
        let lastBlock = null;

        for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
            if (attempt > 1) await page.waitForTimeout(2500);

            let resp;
            try {
                resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
            } catch (e) {
                lastBlock = { reason: 'navigation_failed', detail: e.message };
                continue;
            }

            const httpStatus = resp ? resp.status() : null;
            const cf = await waitOutCloudflare(page, ctx);
            // Small settle for late-rendered article bodies (SPA shells, lazy refs).
            await page.waitForTimeout(1500);

            const title = await page.title().catch(() => '');
            const challenged = /just a moment|attention required|cloudflare|checking your browser/i.test(title);
            const blocked = httpStatus === 403 || httpStatus === 401;

            if (!cf.cleared && (challenged || blocked)) {
                lastBlock = { reason: 'cloudflare_block', detail: challenged ? 'CF challenge not cleared' : 'HTTP ' + httpStatus, httpStatus, finalUrl: page.url() };
                continue;
            }
            if (httpStatus && httpStatus >= 400 && !cf.cleared) {
                return fail('http_error', { httpStatus, finalUrl: page.url() });
            }

            const html = await page.content();
            if (!html || html.length < 500) {
                lastBlock = { reason: 'empty_html', detail: `only ${html?.length ?? 0} bytes`, finalUrl: page.url() };
                continue;
            }

            clearTimeout(hardTimeout);
            return succeed({ html, finalUrl: page.url(), title, httpStatus, channel });
        }

        return fail(lastBlock?.reason ?? 'cloudflare_block', lastBlock ?? {});
    } catch (e) {
        return fail('browser_crash', { detail: e.message });
    } finally {
        await cleanupContext(ctx, userDataDir);
    }
}

main().catch((e) => fail('browser_crash', { detail: e?.message || String(e) }));
