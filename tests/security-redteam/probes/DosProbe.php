<?php

namespace RedTeam\Probes;

use RedTeam\Finding;
use RedTeam\Probe;

/**
 * Availability probes: can a single cheap request make the server do expensive
 * work or fall over?
 *   - oversized body:   POST a multi-MB JSON payload to a parsing endpoint and
 *                       see if it's rejected (413) or swallowed (memory/time risk).
 *   - deep JSON nesting: a deeply-nested structure to stress the JSON/validator
 *                        (stack/recursion blowups).
 *   - search amplification: a pathological search query (huge limit / wildcard)
 *                        to see if pagination caps are enforced.
 *
 * These send heavy requests; flagged destructive, only under --aggressive. The
 * probe never floods (no request storms) — it sends a handful of single heavy
 * requests and reports how the server coped.
 */
class DosProbe extends Probe
{
    public function name(): string
    {
        return 'Denial of Service / Resource Limits';
    }

    public function destructive(): bool
    {
        return true;
    }

    public function run(): array
    {
        $findings = [];
        $client = $this->ctx->accountsReady ? $this->ctx->attacker : $this->ctx->anon;

        // A genuine POST endpoint (so we test body handling, not method routing).
        // /api/anonymous-session is public + accepts POST; it ignores the body,
        // so a huge body exercises the request-size path without side effects.
        $bodyTarget = '/api/anonymous-session';

        // ---- oversized body (~5 MB) ----
        $big  = str_repeat('A', 5 * 1024 * 1024);
        $resp = $client->postJson($bodyTarget, ['blob' => $big]);
        if ($resp->status === 0) {
            $findings[] = $this->inconclusive('Oversized body: connection dropped', "The server closed the connection on a 5MB body to $bodyTarget (proxy limit or crash) — verify.", "POST $bodyTarget");
        } elseif ($resp->status === 413 || ($resp->status >= 400 && $resp->status < 500)) {
            // 413 (payload too large) or any 4xx = the request was refused early.
            $findings[] = $this->safe('Oversized body rejected', "A 5MB payload was rejected with HTTP {$resp->status}.", "POST $bodyTarget");
        } elseif ($resp->status >= 500) {
            $findings[] = $this->vuln(
                'Oversized request body caused a server error',
                Finding::MEDIUM,
                "A 5MB body produced HTTP {$resp->status} — the server tried to process it and failed instead of rejecting it at the edge.",
                "POST $bodyTarget",
                "status={$resp->status}, time={$resp->elapsedMs}ms",
                'Set `client_max_body_size` (nginx) / `post_max_size` (php) so oversized bodies are refused with a 413 before PHP runs.'
            );
        } else {
            $findings[] = $this->vuln(
                'Oversized request body accepted',
                Finding::LOW,
                "A 5MB body was accepted (HTTP {$resp->status}) instead of being rejected early — an attacker can tie up workers/memory cheaply.",
                "POST $bodyTarget",
                "status={$resp->status}, time={$resp->elapsedMs}ms",
                'Set a request-size limit at the web server (`client_max_body_size`) and `post_max_size` in php.ini.'
            );
        }

        // ---- deeply nested JSON ----
        $depth  = 5000;
        $nested = str_repeat('[', $depth) . str_repeat(']', $depth);
        $resp   = $client->send('POST', $bodyTarget, '{"blob":' . $nested . '}', ['Content-Type' => 'application/json']);
        if ($resp->status === 0 || $resp->status >= 500) {
            $findings[] = $this->vuln(
                'Deeply-nested JSON destabilises the server',
                Finding::MEDIUM,
                "A {$depth}-deep nested JSON body caused HTTP {$resp->status} (0 = dropped/crash) — a JSON-depth blowup.",
                "POST $bodyTarget",
                "depth=$depth, status={$resp->status}",
                'Cap JSON nesting depth at the edge before it reaches the validator.'
            );
        } else {
            $findings[] = $this->safe('Nested JSON handled', "A {$depth}-deep payload returned HTTP {$resp->status} without a 5xx.", "POST $bodyTarget");
        }

        // ---- search pagination amplification ----
        $resp = $client->get('/api/search/library?q=a&limit=100000000');
        $count = null;
        $json = $resp->json();
        if (is_array($json)) {
            foreach (['results', 'data', 'library'] as $k) {
                if (isset($json[$k]) && is_array($json[$k])) {
                    $count = count($json[$k]);
                }
            }
        }
        if ($count !== null && $count > 1000) {
            $findings[] = $this->vuln(
                'Search ignores a sane result cap',
                Finding::LOW,
                "limit=100000000 returned $count rows — pagination caps aren't enforced, enabling a cheap amplification.",
                'GET /api/search/library',
                "returned_rows=$count",
                'Clamp `limit` to a hard maximum server-side (the controller has MAX_RESULTS — ensure it applies).'
            );
        } else {
            $findings[] = $this->safe('Search result cap enforced', "An absurd limit returned " . ($count ?? 'a bounded number of') . " rows.", 'GET /api/search/library');
        }

        return $findings;
    }
}
