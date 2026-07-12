// Shared Cloudflare-aware browser plumbing for fetch-pdf.mjs / fetch-html.mjs.
//
// Uses **patchright** (a patched Playwright that removes the CDP-runtime tells
// Cloudflare fingerprints — the thing puppeteer-extra-plugin-stealth no longer
// hides). The Phase 0 spike proved the shippable config: patchright +
// launchPersistentContext + real Chrome channel + a STICKY residential IP +
// HEADED (headless loses managed challenges). Windows only pop for the residual
// Cloudflare-walled publishers; repository PDFs never reach the browser.
//
// On Linux servers "headed" needs a virtual display — wrap the node process in
// `xvfb-run`. Force headless with SOURCE_FETCH_HEADFUL=0 (it will lose managed
// challenges, but is fine for the easy sites).

import { chromium } from 'patchright';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The sticky proxy is computed by PHP (ContentFetchService::stickyProxy) and
// passed in the stdin payload so the browser solve and any Guzzle follow-up
// share ONE IP. Fall back to the raw env proxy (rotating) when absent.
export function proxyFromInput(input) {
    const raw = input?.proxy || process.env.SOURCE_FETCH_PROXY;
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

// Headed by default (managed challenges detect headless even under patchright).
// SOURCE_FETCH_HEADFUL=0/false/no forces headless.
export function isHeadful() {
    const v = process.env.SOURCE_FETCH_HEADFUL;
    if (v === undefined || v === '') return true;
    return !/^(0|false|no|off)$/i.test(v);
}

// Prefer real Google Chrome (best fingerprint); fall back to patchright's
// bundled chromium if the channel isn't installed. Override with
// SOURCE_FETCH_BROWSER_CHANNEL (e.g. 'chromium', or '' for bundled).
export async function launchStealthContext(proxy) {
    const userDataDir = await mkdtemp(join(tmpdir(), 'cf-fetch-'));
    const headless = !isHeadful();
    const base = { headless, proxy, viewport: null, acceptDownloads: true };

    const override = process.env.SOURCE_FETCH_BROWSER_CHANNEL;
    const channels = override !== undefined ? [override || undefined] : ['chrome', 'chromium', undefined];

    let lastErr;
    for (const channel of channels) {
        try {
            const opts = channel ? { ...base, channel } : base;
            const ctx = await chromium.launchPersistentContext(userDataDir, opts);
            return { ctx, userDataDir, channel: channel || 'bundled' };
        } catch (e) {
            lastErr = e;
        }
    }
    await rm(userDataDir, { recursive: true, force: true }).catch(() => {});
    throw lastErr || new Error('no launchable browser channel');
}

export async function cleanupContext(ctx, userDataDir) {
    if (ctx) await ctx.close().catch(() => {});
    if (userDataDir) await rm(userDataDir, { recursive: true, force: true }).catch(() => {});
}

// Cloudflare's "Just a moment…" interstitial runs its JS challenge, sets a
// cf_clearance cookie, then renders the real content. Consider it cleared once
// the title is no longer a challenge string (the spike's headed pass showed a
// "Loading …" title with cf_clearance set — not the final article title, but
// past the wall). Returns { cleared, hasClearance }.
export async function waitOutCloudflare(page, ctx, budgetMs = 28_000) {
    const start = Date.now();
    const challengeRe = /just a moment|attention required|cloudflare|checking (your|if the site)|verify you are human/i;
    while (Date.now() - start < budgetMs) {
        const title = await page.title().catch(() => '');
        if (title && !challengeRe.test(title)) {
            const cookies = await ctx.cookies().catch(() => []);
            return { cleared: true, hasClearance: cookies.some((c) => c.name === 'cf_clearance') };
        }
        await page.waitForTimeout(500);
    }
    const cookies = await ctx.cookies().catch(() => []);
    const hasClearance = cookies.some((c) => c.name === 'cf_clearance');
    return { cleared: hasClearance, hasClearance };
}

// Fetch a URL from INSIDE the cleared page's JS context (carries cf_clearance +
// same-origin), returning the body as base64. This is the capture that beats
// the "raw request re-triggers the challenge" bug — Cloudflare sees a
// legitimate in-page request. Base64 is chunked to survive multi-MB PDFs.
export async function inPageFetchBase64(page, url, referer) {
    return page.evaluate(async ({ u, ref }) => {
        try {
            const headers = ref ? { Referer: ref } : {};
            const r = await fetch(u, { credentials: 'include', headers });
            const ct = (r.headers.get('content-type') || '').toLowerCase();
            if (!r.ok) return { ok: false, status: r.status, ct };
            const buf = new Uint8Array(await r.arrayBuffer());
            let binary = '';
            const CH = 0x8000;
            for (let i = 0; i < buf.length; i += CH) {
                binary += String.fromCharCode.apply(null, buf.subarray(i, i + CH));
            }
            return { ok: true, status: r.status, ct, bytes: buf.length, b64: btoa(binary) };
        } catch (e) {
            return { ok: false, err: String(e && e.message ? e.message : e) };
        }
    }, { u: url, ref: referer || null });
}
