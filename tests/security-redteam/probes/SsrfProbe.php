<?php

namespace RedTeam\Probes;

use RedTeam\Finding;
use RedTeam\Probe;

/**
 * Server-Side Request Forgery: can the attacker make the SERVER fetch a URL of
 * their choosing? The danger targets are cloud metadata (169.254.169.254),
 * loopback/internal services, and `file://`. We aim the url-import and scrape
 * endpoints at those and watch for signs the server actually dialed out
 * (metadata content reflected, or a long delay against an unroutable host).
 *
 * Destructive flag: these endpoints trigger outbound fetches from the server, so
 * only run under --aggressive.
 */
class SsrfProbe extends Probe
{
    public function name(): string
    {
        return 'SSRF';
    }

    public function destructive(): bool
    {
        return true; // makes the server perform outbound requests
    }

    public function run(): array
    {
        if (!$this->ctx->accountsReady) {
            return [$this->inconclusive('SSRF suite skipped', 'Attacker account could not be provisioned (scrape/import need auth).')];
        }

        $client = $this->ctx->attacker;
        $payloads = [
            'http://169.254.169.254/latest/meta-data/',          // AWS metadata
            'http://metadata.google.internal/computeMetadata/v1/',// GCP metadata
            'http://127.0.0.1:6379/',                             // local redis
            'http://localhost/api/auth/session-info',             // internal loopback
            'file:///etc/passwd',                                 // local file
            'gopher://127.0.0.1:6379/_INFO',                      // protocol smuggling
        ];

        // (path, jsonKey-for-url, label)
        $endpoints = [
            ['/import-url/inspect', 'url', 'url-import inspect'],
            ['/api/scrape/novel/chapters', 'url', 'novel scraper'],
        ];

        $findings = [];
        foreach ($endpoints as [$path, $key, $label]) {
            $reflected = false;
            foreach ($payloads as $p) {
                $resp = $client->postJson($path, [$key => $p, 'book' => 'redteam-ssrf']);
                // Signs of a real SSRF: metadata/file contents reflected back, or
                // a 200 that clearly fetched something internal.
                if ($resp->ok() && $this->reflectsInternal($resp->body)) {
                    $findings[] = $this->vuln(
                        "SSRF via $label",
                        Finding::CRITICAL,
                        "The endpoint fetched attacker-supplied URL `$p` and reflected internal content.",
                        "POST $path",
                        "payload: $p\n" . $resp->snippet(160),
                        'Allowlist destinations (scheme + host), resolve DNS and block private/link-local/loopback ranges before fetching.'
                    );
                    $reflected = true;
                    break;
                }
            }
            if (!$reflected) {
                $findings[] = $this->safe(
                    "SSRF blocked: $label",
                    'Internal/metadata/file URLs were rejected or not fetched (identifier-allowlist / host-allowlist held).',
                    "POST $path"
                );
            }
        }

        return $findings;
    }

    private function reflectsInternal(string $body): bool
    {
        foreach (['ami-id', 'instance-id', 'computeMetadata', 'root:x:0:0', 'redis_version', 'user_token'] as $n) {
            if (stripos($body, $n) !== false) {
                return true;
            }
        }
        return false;
    }
}
