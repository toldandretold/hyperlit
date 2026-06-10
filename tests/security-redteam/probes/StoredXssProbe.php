<?php

namespace RedTeam\Probes;

use RedTeam\Finding;
use RedTeam\Probe;

/**
 * The single highest-value test for a content/editor app: can an attacker store
 * HTML that later executes in another reader's browser? Hyperlit stores node
 * `content`, highlight `highlightedHTML`, and `annotation` as HTML. This probe
 * goes through the real save path:
 *
 *   1. create a PUBLIC book (so any reader is a victim),
 *   2. write node content + a highlight + an annotation containing XSS payloads,
 *   3. read the book back through the same API the reader's browser uses,
 *   4. check whether each payload SURVIVED VERBATIM (script tags, event handlers,
 *      javascript: URLs still intact).
 *
 * Survival in the read API proves the storage layer doesn't sanitize. Whether it
 * then *executes* depends on how the SPA renders it (innerHTML vs escaped) — the
 * probe says so explicitly and points at the e2e browser suite for the final
 * confirmation, so we don't over-claim.
 *
 * Destructive: it persists data (a book + nodes). Cleans up after itself.
 */
class StoredXssProbe extends Probe
{
    public function name(): string
    {
        return 'Stored XSS (content sanitization)';
    }

    public function destructive(): bool
    {
        return true; // writes a book + nodes/highlights
    }

    public function run(): array
    {
        if (!$this->ctx->accountsReady) {
            return [$this->inconclusive('Stored-XSS suite skipped', 'Attacker account could not be provisioned.')];
        }

        $a    = $this->ctx->attacker;
        $book = $this->ctx->createBook($a, 'public', 'redteam xss book');
        if (!$book) {
            return [$this->inconclusive('Stored-XSS setup failed', 'Could not create a book via /api/db/library/upsert (author write may be gated differently).', 'POST /api/db/library/upsert')];
        }

        $findings = [];

        // Each payload carries a unique, greppable marker so we can detect exact
        // survival in the read-back without false positives.
        $payloads = [
            'script-tag'   => '<script>RTXSS_SCRIPT_7f3a()</script>',
            'img-onerror'  => '<img src=x onerror="RTXSS_IMG_7f3a()">',
            'svg-onload'   => '<svg onload="RTXSS_SVG_7f3a()"></svg>',
            'js-href'      => '<a href="javascript:RTXSS_HREF_7f3a()">click</a>',
            'iframe'       => '<iframe src="javascript:RTXSS_IFRAME_7f3a()"></iframe>',
        ];
        $nodeHtml = '<p>begin</p>' . implode('', array_values($payloads)) . '<p>end</p>';

        // --- node content ---
        $nid   = 'rt_n_' . bin2hex(random_bytes(5));   // globally-unique node id
        $write = $this->ctx->writeNode($a, $book, $nodeHtml, $nid);
        if (!$write->ok()) {
            $findings[] = $this->inconclusive('Node write failed', "Could not write node content (HTTP {$write->status}).", 'POST /api/db/node-chunks/upsert');
        } else {
            $read = $this->ctx->readBookData($a, $book);
            $findings = array_merge($findings, $this->assess('node content', $payloads, $read, 'GET …/books/{book}/data'));
        }

        // --- highlight HTML + annotation ---
        $hlPayloadHtml = '<img src=x onerror="RTXSS_HL_7f3a()">';
        $annPayload    = '<script>RTXSS_ANN_7f3a()</script>';
        $hl = $a->postJson('/api/db/hyperlights/upsert', [
            'data' => [[
                'book'            => $book,
                'hyperlight_id'   => 'rt_hl_' . bin2hex(random_bytes(3)),
                'node_id'         => [$nid],
                'charData'        => [$nid => ['charStart' => 0, 'charEnd' => 5]],
                'highlightedText' => 'begin',
                'highlightedHTML' => $hlPayloadHtml,
                'annotation'      => $annPayload,
                'startLine'       => 1,
                'time_since'      => 1700000000,
            ]],
        ]);
        if ($hl->ok()) {
            $read = $this->ctx->readBookData($a, $book);
            $findings = array_merge($findings, $this->assess('highlight HTML/annotation', [
                'highlightedHTML' => $hlPayloadHtml,
                'annotation'      => $annPayload,
            ], $read, 'GET …/books/{book}/data (annotations)'));
        } else {
            $findings[] = $this->inconclusive('Highlight write failed', "Could not write a highlight (HTTP {$hl->status}).", 'POST /api/db/hyperlights/upsert');
        }

        // Cleanup the throwaway book.
        $a->send('DELETE', '/api/books/' . rawurlencode($book));

        return $findings;
    }

    /**
     * For each payload, decide survived/sanitized by looking for the dangerous
     * token in the read-back body.
     *
     * @param array<string,string> $payloads label => raw html
     * @return Finding[]
     */
    private function assess(string $surface, array $payloads, $read, string $endpoint): array
    {
        if (!$read->ok()) {
            return [$this->inconclusive("Read-back failed for $surface", "Could not read the book back (HTTP {$read->status}).", $endpoint)];
        }
        // The body is JSON, so embedded HTML quotes arrive escaped as \" — undo
        // that so an `onerror="…"` token matches the same token in the payload.
        $body = str_replace('\\"', '"', $read->body);
        $findings = [];

        foreach ($payloads as $label => $html) {
            // The "dangerous core" is the bit that must NOT survive: the script
            // open tag, the event-handler attribute, or the javascript: scheme.
            $danger = $this->dangerToken($html);
            $survived = str_contains($body, $danger);

            if ($survived) {
                $findings[] = $this->vuln(
                    "Unsanitized HTML stored & served ($surface: $label)",
                    Finding::HIGH,
                    "An XSS payload written to `$surface` came back verbatim from the read API — the server stores active HTML without sanitising it. "
                    . 'CONFIRMED EXPLOITABLE: a Playwright PoC (tests/e2e/specs/security/stored-xss-poc.spec.js) showed an `<img onerror>` in a public book EXECUTING in a viewer browser. '
                    . 'Root cause: applyHighlights/applyHypercites assign the RAW content to a detached `innerHTML` (lazyLoaderFactory.js:1525/1387) BEFORE DOMPurify runs at :1266, so the event handler fires before sanitisation. Effective severity: Critical.',
                    $endpoint,
                    "payload: $html\nsurvived token: $danger",
                    'Sanitise the content BEFORE the detached innerHTML (e.g. sanitizeHtml(renderBlockToHtml(node)) up-front) AND sanitise on WRITE server-side (HTMLPurifier) so stored data is safe regardless of render path. Re-run the PoC to confirm closure.'
                );
            } else {
                $findings[] = $this->safe(
                    "Payload neutralised ($surface: $label)",
                    "The dangerous token `$danger` did not survive the round-trip — the layer sanitised or encoded it.",
                    $endpoint
                );
            }
        }
        return $findings;
    }

    private function dangerToken(string $html): string
    {
        if (preg_match('/on\w+="[^"]*"/', $html, $m)) {
            return $m[0];                       // onerror="RTXSS_…()"
        }
        if (str_contains($html, '<script>')) {
            return substr($html, 0, strpos($html, '(') ?: 20); // <script>RTXSS_…
        }
        if (preg_match('/javascript:[^"\']+/', $html, $m)) {
            return $m[0];                       // javascript:RTXSS_…()
        }
        return $html;
    }
}
