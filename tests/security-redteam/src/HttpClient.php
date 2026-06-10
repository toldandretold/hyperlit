<?php

namespace RedTeam;

/**
 * A tiny stateful HTTP client built on cURL.
 *
 * One instance == one "browser": it keeps its own cookie jar (in memory) so a
 * login on this client persists across subsequent requests, and it mirrors the
 * way the SPA talks to the Laravel backend:
 *   - sends/stores the `XSRF-TOKEN` cookie and echoes it back as the
 *     `X-XSRF-TOKEN` header (Sanctum stateful + the `web` session guard need it
 *     for any state-changing request),
 *   - sets `X-Requested-With: XMLHttpRequest` and `Accept: application/json` so
 *     Laravel returns JSON error bodies instead of HTML error pages.
 *
 * Deliberately dependency-free (no Guzzle, no composer autoload) so the harness
 * can be dropped onto any box with PHP + ext-curl and pointed at any target.
 */
class HttpClient
{
    private string $baseUrl;
    /** @var array<string,string> cookieName => value */
    private array $cookies = [];
    private int $timeout;
    public bool $verbose = false;

    public function __construct(string $baseUrl, int $timeout = 15)
    {
        $this->baseUrl = rtrim($baseUrl, '/');
        $this->timeout = $timeout;
    }

    public function baseUrl(): string
    {
        return $this->baseUrl;
    }

    /** Forget all cookies — turns this client back into a fresh anonymous visitor. */
    public function resetSession(): void
    {
        $this->cookies = [];
    }

    public function cookie(string $name): ?string
    {
        return $this->cookies[$name] ?? null;
    }

    public function get(string $path, array $headers = []): Response
    {
        return $this->request('GET', $path, null, $headers);
    }

    public function postJson(string $path, array $body = [], array $headers = []): Response
    {
        return $this->request('POST', $path, json_encode($body), $headers + [
            'Content-Type' => 'application/json',
        ]);
    }

    public function postForm(string $path, array $fields = [], array $headers = []): Response
    {
        return $this->request('POST', $path, http_build_query($fields), $headers + [
            'Content-Type' => 'application/x-www-form-urlencoded',
        ]);
    }

    public function send(string $method, string $path, ?string $body = null, array $headers = []): Response
    {
        return $this->request($method, $path, $body, $headers);
    }

    /**
     * Prime the CSRF cookie the way a real browser does on first page load.
     * Sanctum's stateful flow expects the client to read XSRF-TOKEN from the
     * cookie jar and replay it as a header; hitting any GET route populates it.
     */
    public function primeCsrf(string $path = '/'): void
    {
        $this->get($path);
    }

    private function request(string $method, string $path, ?string $body, array $headers): Response
    {
        $url = str_starts_with($path, 'http') ? $path : $this->baseUrl . '/' . ltrim($path, '/');

        $defaultHeaders = [
            'Accept'           => 'application/json',
            'X-Requested-With' => 'XMLHttpRequest',
            'User-Agent'       => 'hyperlit-redteam/1.0',
            // Sanctum's stateful guard only engages the session for API routes
            // when Origin/Referer match a SANCTUM_STATEFUL_DOMAINS entry. Without
            // these, every authenticated request falls back to (absent) token
            // auth and 401s — so we mirror the SPA and send the target origin.
            'Origin'           => $this->baseUrl,
            'Referer'          => $this->baseUrl . '/',
        ];
        // Replay the XSRF token as a header (Laravel url-decodes the cookie value).
        if (isset($this->cookies['XSRF-TOKEN'])) {
            $defaultHeaders['X-XSRF-TOKEN'] = urldecode($this->cookies['XSRF-TOKEN']);
        }
        $headers = array_merge($defaultHeaders, $headers);

        $headerLines = [];
        foreach ($headers as $k => $v) {
            $headerLines[] = "$k: $v";
        }
        if ($this->cookies) {
            $pairs = [];
            foreach ($this->cookies as $k => $v) {
                $pairs[] = "$k=$v";
            }
            $headerLines[] = 'Cookie: ' . implode('; ', $pairs);
        }

        $ch = curl_init($url);
        curl_setopt_array($ch, [
            CURLOPT_CUSTOMREQUEST  => $method,
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_HEADER         => true,
            CURLOPT_HTTPHEADER     => $headerLines,
            CURLOPT_TIMEOUT        => $this->timeout,
            CURLOPT_CONNECTTIMEOUT => 8,
            CURLOPT_FOLLOWLOCATION => false,   // we want to SEE redirects (open-redirect probe)
            CURLOPT_SSL_VERIFYPEER => false,   // dev certs / self-signed targets
            CURLOPT_SSL_VERIFYHOST => false,
        ]);
        if ($body !== null) {
            curl_setopt($ch, CURLOPT_POSTFIELDS, $body);
        }

        $started = microtime(true);
        $raw     = curl_exec($ch);
        $elapsed = (microtime(true) - $started) * 1000.0;

        if ($raw === false) {
            $err = curl_error($ch);
            curl_close($ch);
            return new Response(0, [], '', $elapsed, $err);
        }

        $headerSize = curl_getinfo($ch, CURLINFO_HEADER_SIZE);
        $status     = curl_getinfo($ch, CURLINFO_HTTP_CODE);
        curl_close($ch);

        $rawHeaders = substr($raw, 0, $headerSize);
        $rawBody    = substr($raw, $headerSize);

        $parsedHeaders = $this->parseHeaders($rawHeaders);
        $this->absorbCookies($parsedHeaders);

        if ($this->verbose) {
            fwrite(STDERR, sprintf("[http] %s %s -> %d (%.0fms)\n", $method, $path, $status, $elapsed));
        }

        return new Response($status, $parsedHeaders, $rawBody, $elapsed, null);
    }

    /** @return array<string,string[]> */
    private function parseHeaders(string $rawHeaders): array
    {
        $headers = [];
        // The response may contain multiple header blocks (e.g. 100-continue);
        // keep the last block, which describes the final response.
        $blocks = preg_split("/\r\n\r\n/", trim($rawHeaders));
        $last   = array_pop($blocks) ?: '';
        foreach (explode("\r\n", $last) as $line) {
            if (!str_contains($line, ':')) {
                continue;
            }
            [$name, $value] = explode(':', $line, 2);
            $headers[strtolower(trim($name))][] = trim($value);
        }
        return $headers;
    }

    /** Merge any Set-Cookie headers into the in-memory jar. */
    private function absorbCookies(array $headers): void
    {
        foreach ($headers['set-cookie'] ?? [] as $cookie) {
            $pair = explode(';', $cookie, 2)[0];
            if (!str_contains($pair, '=')) {
                continue;
            }
            [$name, $value] = explode('=', $pair, 2);
            $name  = trim($name);
            $value = trim($value);
            // An expired/blank cookie means "delete me".
            if ($value === '' || $value === 'deleted') {
                unset($this->cookies[$name]);
            } else {
                $this->cookies[$name] = $value;
            }
        }
    }
}

/**
 * Immutable response value object with a few convenience accessors the probes
 * lean on (json(), header(), looksLikeStackTrace()).
 */
class Response
{
    public function __construct(
        public readonly int $status,
        /** @var array<string,string[]> */
        public readonly array $headers,
        public readonly string $body,
        public readonly float $elapsedMs,
        public readonly ?string $error,
    ) {
    }

    public function ok(): bool
    {
        return $this->status >= 200 && $this->status < 300;
    }

    public function json(): mixed
    {
        return json_decode($this->body, true);
    }

    public function header(string $name): ?string
    {
        $vals = $this->headers[strtolower($name)] ?? null;
        return $vals[0] ?? null;
    }

    /** A short, log-friendly slice of the body. */
    public function snippet(int $len = 280): string
    {
        $clean = trim(preg_replace('/\s+/', ' ', $this->body) ?? '');
        return mb_strlen($clean) > $len ? mb_substr($clean, 0, $len) . '…' : $clean;
    }

    /** Heuristic: does the body leak a Laravel/PHP stack trace or SQL error? */
    public function looksLikeStackTrace(): bool
    {
        $needles = [
            'Stack trace', 'vendor/laravel', 'SQLSTATE', 'PDOException',
            'Illuminate\\Database', 'syntax error at or near', 'QueryException',
            'symfony/http-kernel', '#0 /', 'Whoops',
        ];
        foreach ($needles as $n) {
            if (stripos($this->body, $n) !== false) {
                return true;
            }
        }
        return false;
    }
}
