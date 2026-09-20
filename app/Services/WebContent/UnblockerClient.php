<?php

namespace App\Services\WebContent;

use Illuminate\Support\Facades\Http;
use Symfony\Component\Process\Process;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Str;

/**
 * A MANAGED unblocking endpoint: we send a URL through it and get HTML back.
 *
 * ── RENDERING IS OPT-IN, AND IT MATTERS ─────────────────────────────────────
 * By default the unblocker issues a plain HTTP request and returns whatever
 * came back. For a client-rendered site that is an empty app shell at HTTP 200
 * — measured: thewire.in came back BYTE-IDENTICAL to a direct fetch (11,192
 * bytes of shell) — and a JS anti-bot page is forwarded unsolved
 * (digitallibrary.un.org's AWS WAF arrived as `HTTP 202` +
 * `X-Amzn-Waf-Action: challenge`, empty body).
 *
 * Rendering is requested by SUFFIXING THE PASSWORD with `_render-1`, exactly
 * the mechanism ContentFetchService::stickyProxy() already uses for sticky
 * sessions on the residential product. Headers do nothing (`X-Render`,
 * `X-Js-Render` and friends were all no-ops). See password() and
 * `services.unblocker.render`.
 *
 * Even without rendering it earns its place — a residential IP plus
 * browser-header spoofing recovered 6 of chacko's blocked citations (ft.com,
 * thewalrus.ca, qz.com, thequint.com, georgesoros.com, theprint.in), all sites
 * that simply refuse datacenter IPs. Rendering is what the remaining JS-shell
 * and JS-challenge hosts need.
 *
 * Why this exists as a separate rung. Over chacko's 59 unresolved citation
 * URLs, roughly 21 are managed Cloudflare/PerimeterX challenges that our own
 * patchright stack loses regardless of exit IP, headless or headed — tested
 * directly (thewire.in, qz.com, thewalrus.ca, ft.com, fbi.gov,
 * georgesoros.com). A live residential proxy recovered ZERO of them: 24/59
 * usable going direct, 23/59 through the proxy. Bot-check evasion is a
 * full-time arms race, and buying it is cheaper than losing it — these
 * endpoints bill per SUCCESSFUL retrieval (~$0.70/1000), so the ~21 blocked
 * references cost about a penny and failures are free.
 *
 * ── Dormant until configured ─────────────────────────────────────────────────
 * Exactly the FlareSolverrClient pattern: with no credentials, isConfigured()
 * is false and the rung no-ops, so dev and prod behave precisely as they do
 * now. Set UNBLOCKER_URL (+ UNBLOCKER_USERNAME / UNBLOCKER_PASSWORD, or
 * UNBLOCKER_TOKEN) to switch it on.
 *
 * Two shapes are supported because vendors differ:
 *  - PROXY mode (`services.unblocker.mode = 'proxy'`, the IPRoyal Web
 *    Unblocker / Bright Data shape): the endpoint IS an HTTP proxy that renders
 *    upstream, so the request goes through it like any other proxy.
 *  - API mode (`'api'`): POST the target URL as JSON and read HTML from the
 *    response body.
 *
 * NOTE: unverified against a live account. The seam and its gating are real;
 * the response shape in API mode is a best guess from vendor docs and should be
 * confirmed against one paid call before being relied on — which is why
 * `citation:web:bench` is the intended way to switch it on.
 */
class UnblockerClient
{
    public function isConfigured(): bool
    {
        return (bool) config('services.unblocker.url');
    }

    /**
     * Fetch a page through the unblocker.
     *
     * @return array{html: ?string, reason: ?string, status: ?int}
     */
    public function fetch(string $url, bool $render = false): array
    {
        $base = (string) config('services.unblocker.url');
        if ($base === '') {
            return ['html' => null, 'reason' => 'unblocker not configured', 'status' => null];
        }

        return config('services.unblocker.mode', 'proxy') === 'api'
            ? $this->viaApi($base, $url)
            : $this->viaProxy($base, $url, $render);
    }

    /**
     * Proxy mode, over CURL rather than Guzzle — deliberately.
     *
     * Measured 2026-09-17 against IPRoyal's Web Unblocker: the SAME url, the
     * same credentials and the same headers return the rendered ARTICLE to
     * curl (305,036 bytes, `<title>` = the piece) and a different, larger page
     * to Guzzle (344,917 bytes, `<title>` = the site homepage) — reproducibly,
     * three times each. The target definitely receives the right URL either way
     * (verified by echoing the request back through httpbin), and neither
     * forcing HTTP/1.1 nor matching curl's Accept header changed it, so the
     * trigger is something in the Guzzle request shape their edge keys off.
     *
     * Rather than keep guessing at a third party's behaviour, this uses the
     * transport that provably works. Shelling out is already how the browser
     * and paste-engine rungs work, so it is not a new kind of dependency.
     *
     * @return array{html: ?string, reason: ?string, status: ?int}
     */
    private function viaProxy(string $base, string $url, bool $render = false): array
    {
        $timeout = (int) config('services.unblocker.timeout', 90);
        $marker = '@@UNBLOCKER_STATUS:';

        $command = [
            'curl', '-sS', '--max-time', (string) $timeout,
            '-x', $base,
            '-L', '--max-redirs', '5',
            '-w', "\n{$marker}%{http_code}",
        ];

        // Credentials as an argument, never interpolated into the proxy URL, so
        // they cannot end up in a log line or an exception message.
        $user = (string) config('services.unblocker.username', '');
        if ($user !== '') {
            $command[] = '-U';
            $command[] = $user.':'.$this->password($render);
        }

        // These endpoints terminate TLS themselves — that IS the mechanism —
        // so their certificate is not the target's.
        if (! (bool) config('services.unblocker.verify_tls', false)) {
            $command[] = '-k';
        }

        $command[] = $url;

        try {
            $proc = new Process($command);
            $proc->setTimeout($timeout + 15);
            $proc->run();
        } catch (\Throwable $e) {
            Log::warning('UnblockerClient: curl failed to run', ['error' => Str::limit($e->getMessage(), 200)]);

            return ['html' => null, 'reason' => 'unblocker request failed: '.Str::limit($e->getMessage(), 120), 'status' => null];
        }

        $output = $proc->getOutput();
        $at = strrpos($output, $marker);
        if ($at === false) {
            return [
                'html' => null,
                'status' => null,
                'reason' => 'unblocker returned nothing usable: '.Str::limit(trim($proc->getErrorOutput()), 120),
            ];
        }

        $status = (int) trim(substr($output, $at + strlen($marker)));
        $body = rtrim(substr($output, 0, $at), "\n");

        return $this->interpret($body, $status);
    }

    /**
     * The password, plus the render flag when rendering is wanted.
     *
     * IPRoyal signals per-request options by SUFFIXING THE PASSWORD — the same
     * mechanism ContentFetchService::stickyProxy() uses for sticky sessions on
     * the residential product. Without `_render-1` the unblocker does a plain
     * HTTP request, so a client-rendered site returns an empty shell at HTTP
     * 200 and a JS anti-bot page is forwarded unsolved.
     */
    private function password(bool $render): string
    {
        $password = (string) config('services.unblocker.password', '');
        $suffix = (string) config('services.unblocker.render_suffix', '');

        if (! $render || ! (bool) config('services.unblocker.render', true) || $suffix === '') {
            return $password;
        }

        return str_contains($password, $suffix) ? $password : $password.$suffix;
    }

    /**
     * @return array{html: ?string, reason: ?string, status: ?int}
     */
    private function viaApi(string $base, string $url): array
    {
        $request = Http::timeout((int) config('services.unblocker.timeout', 90))->acceptJson();

        if ($token = config('services.unblocker.token')) {
            $request = $request->withToken((string) $token);
        } elseif ($user = config('services.unblocker.username')) {
            $request = $request->withBasicAuth((string) $user, (string) config('services.unblocker.password'));
        }

        try {
            $response = $request->post($base, ['url' => $url, 'render' => true]);
        } catch (\Throwable $e) {
            Log::warning('UnblockerClient: API request failed', ['error' => Str::limit($e->getMessage(), 200)]);

            return ['html' => null, 'reason' => 'unblocker request failed: '.Str::limit($e->getMessage(), 120), 'status' => null];
        }

        return $this->interpret($response->body(), $response->status());
    }

    /**
     * @return array{html: ?string, reason: ?string, status: ?int}
     */
    private function interpret(string $body, int $status): array
    {
        if ($status < 200 || $status >= 300) {
            // A 402 here is the same class of silent killer as Brave's: the
            // service is up, the balance is not, and every citation quietly
            // stops resolving. Named loudly for that reason.
            if ($status === 402) {
                Log::error('UnblockerClient: PAYMENT REQUIRED (HTTP 402) — the unblocker rung is dark until the balance is topped up.');
            }

            return ['html' => null, 'reason' => "unblocker returned HTTP {$status}", 'status' => $status];
        }

        $html = $this->htmlFrom($body);

        if ($html === null || strlen($html) < 500) {
            return ['html' => null, 'reason' => 'the unblocker returned no usable page', 'status' => $status];
        }

        return ['html' => $html, 'reason' => null, 'status' => $status];
    }

    /**
     * Proxy mode returns the page directly; API mode wraps it in JSON under a
     * key that varies by vendor. Tolerate both rather than assuming.
     */
    private function htmlFrom(string $body): ?string
    {
        $trimmed = ltrim($body);
        if ($trimmed === '') {
            return null;
        }

        if ($trimmed[0] === '{' || $trimmed[0] === '[') {
            $decoded = json_decode($body, true);
            if (is_array($decoded)) {
                foreach (['html', 'content', 'body', 'data'] as $key) {
                    if (! empty($decoded[$key]) && is_string($decoded[$key])) {
                        return $decoded[$key];
                    }
                }

                return null;
            }
        }

        return $body;
    }
}
