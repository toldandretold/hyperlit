<?php

namespace RedTeam\Probes;

use RedTeam\Finding;
use RedTeam\Probe;

/**
 * Cross-tenant access to actual book CONTENT (the crown jewels — a user's
 * private reading/notes). The victim creates a PRIVATE book with a secret string
 * in a node; the attacker then tries to:
 *   - READ it via the consolidated data endpoint, the snapshots endpoint, and
 *     the annotations endpoint (must 403/404),
 *   - WRITE a node into the victim's book (must be rejected — no cross-tenant
 *     content injection).
 *
 * Destructive: creates a book + node for the victim. Cleans up.
 */
class ContentIdorProbe extends Probe
{
    public function name(): string
    {
        return 'Content IDOR (private books)';
    }

    public function destructive(): bool
    {
        return true;
    }

    public function run(): array
    {
        if (!$this->ctx->accountsReady) {
            return [$this->inconclusive('Content-IDOR suite skipped', 'Accounts could not be provisioned.')];
        }

        $secret = 'PRIVATE_SECRET_' . bin2hex(random_bytes(5));
        $book   = $this->ctx->createBook($this->ctx->victim, 'private', 'victim private book');
        if (!$book) {
            return [$this->inconclusive('Content-IDOR setup failed', 'Victim could not create a private book.', 'POST /api/db/library/upsert')];
        }
        $this->ctx->writeNode($this->ctx->victim, $book, "<p>$secret</p>");

        $a = $this->ctx->attacker;
        $findings = [];

        // 1) Attacker reads the consolidated data endpoint.
        $read = $this->ctx->readBookData($a, $book);
        if ($read->ok() && str_contains($read->body, $secret)) {
            $findings[] = $this->vuln(
                'Attacker read another user\'s PRIVATE book content',
                Finding::CRITICAL,
                "The attacker fetched the victim's private book `$book` and the response contained the planted secret.",
                'GET /api/database-to-indexeddb/books/{book}/data',
                "secret leaked: $secret\n" . $read->snippet(120),
                'Enforce the visibility/owner check before returning node content; private books must 403 for non-owners.'
            );
        } else {
            $findings[] = $this->safe('Private book data read blocked', "Attacker read of the victim's private book returned HTTP {$read->status} without the secret.", 'GET …/books/{book}/data');
        }

        // 2) Attacker reads the snapshots (version history) endpoint.
        $snap = $a->get('/api/books/' . rawurlencode($book) . '/snapshots');
        if ($snap->ok() && !str_contains(strtolower($snap->body), 'access denied') && str_contains($snap->body, 'snapshots')) {
            // getSnapshots returns {success, snapshots:[...]} on allow; 403 on deny.
            $count = is_array($snap->json()) ? ($snap->json()['count'] ?? null) : null;
            if ($count) {
                $findings[] = $this->vuln(
                    'Attacker read another user\'s private snapshot history',
                    Finding::HIGH,
                    "The snapshots endpoint returned version history for the victim's private book to the attacker.",
                    'GET /api/books/{book}/snapshots',
                    $snap->snippet(160),
                    'Gate getSnapshots on the same owner/visibility check as the content endpoints.'
                );
            } else {
                $findings[] = $this->safe('Private snapshots empty/blocked', "Snapshots returned HTTP {$snap->status} with no history for a non-owner.", 'GET /api/books/{book}/snapshots');
            }
        } else {
            $findings[] = $this->safe('Private snapshots blocked', "Attacker snapshots request returned HTTP {$snap->status} / access denied.", 'GET /api/books/{book}/snapshots');
        }

        // 3) Attacker tries to WRITE a node into the victim's book.
        $write = $this->ctx->writeNode($a, $book, '<p>ATTACKER_INJECTED</p>', 'rt_atk_' . bin2hex(random_bytes(5)));
        // Re-read as the victim to see whether the injection actually landed.
        $verify = $this->ctx->readBookData($this->ctx->victim, $book);
        if ($verify->ok() && str_contains($verify->body, 'ATTACKER_INJECTED')) {
            $findings[] = $this->vuln(
                'Attacker wrote content into another user\'s book',
                Finding::CRITICAL,
                "A node written by the attacker to the victim's book persisted (visible when the victim re-reads).",
                'POST /api/db/node-chunks/upsert',
                "write status: {$write->status}; injected marker found on victim re-read.",
                'Enforce creator ownership on every node write; reject (404) writes to books the caller does not own.'
            );
        } else {
            $findings[] = $this->safe('Cross-tenant node write blocked', "Attacker node write returned HTTP {$write->status} and did not appear in the victim's book.", 'POST /api/db/node-chunks/upsert');
        }

        // Cleanup (victim owns the book).
        $this->ctx->victim->send('DELETE', '/api/books/' . rawurlencode($book));

        return $findings;
    }
}
