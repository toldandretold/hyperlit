<?php

namespace RedTeam\Probes;

use RedTeam\Finding;
use RedTeam\Probe;

/**
 * The core cross-tenant test. The victim creates private resources and gets back
 * their real ids; the attacker — a DIFFERENT authenticated user — then tries to
 * read, modify, and delete those resources by id. Every attempt must fail
 * (403/404). A success is a textbook IDOR (Insecure Direct Object Reference):
 * authorization keyed on "do you know the id?" instead of "do you own it?".
 *
 * Resources exercised (all reachable black-box, all owned by the victim):
 *   - vibes:   private saved CSS themes (PATCH / DELETE by UUID).
 *   - shelves: private collections (GET render, PATCH).
 *
 * Marked non-destructive: it only ever targets the throwaway victim account's
 * own rows, and the whole point is that the writes should be REJECTED.
 */
class IdorProbe extends Probe
{
    public function name(): string
    {
        return 'IDOR / Cross-Tenant Access';
    }

    public function run(): array
    {
        if (!$this->ctx->accountsReady) {
            return [$this->inconclusive('IDOR suite skipped', 'Attacker/victim accounts could not be provisioned on the target.')];
        }

        $findings = [];
        $findings = array_merge($findings, $this->vibeIdor());
        $findings = array_merge($findings, $this->shelfIdor());
        return $findings;
    }

    /** Victim creates a private vibe; attacker tries to hijack/delete it. */
    private function vibeIdor(): array
    {
        $secret = 'victim-secret-' . bin2hex(random_bytes(4));
        $create = $this->ctx->victim->postJson('/api/vibes', [
            'name'          => 'victim-vibe-' . bin2hex(random_bytes(3)),
            'css_overrides' => ['--secret' => $secret],
            'visibility'    => 'private',
        ]);

        $id = $create->json()['vibe']['id'] ?? null;
        if (!$id) {
            return [$this->inconclusive('Vibe IDOR setup failed', "Victim could not create a vibe (HTTP {$create->status}: {$create->snippet(120)}).", 'POST /api/vibes')];
        }

        $findings = [];

        // 1) Attacker tries to OVERWRITE the victim's vibe.
        $patch = $this->ctx->attacker->send(
            'PATCH',
            "/api/vibes/$id",
            json_encode(['name' => 'HIJACKED', 'css_overrides' => ['--pwned' => 'yes']]),
            ['Content-Type' => 'application/json']
        );
        if ($patch->ok()) {
            $findings[] = $this->vuln(
                'IDOR: attacker modified another user\'s vibe',
                Finding::CRITICAL,
                "The attacker PATCHed the victim's private vibe `$id` and got HTTP {$patch->status}.",
                "PATCH /api/vibes/$id",
                $patch->snippet(180),
                'Add an ownership check (`where creator = current user`) before updating; return 404 on mismatch.'
            );
        } else {
            $findings[] = $this->safe('Vibe PATCH blocked cross-tenant', "Attacker PATCH on victim's vibe returned HTTP {$patch->status}.", "PATCH /api/vibes/$id");
        }

        // 2) Attacker tries to DELETE the victim's vibe.
        $del = $this->ctx->attacker->send('DELETE', "/api/vibes/$id");
        if ($del->ok()) {
            // Confirm it actually went: victim re-lists.
            $stillThere = $this->vibeStillExists($id);
            if (!$stillThere) {
                $findings[] = $this->vuln(
                    'IDOR: attacker deleted another user\'s vibe',
                    Finding::CRITICAL,
                    "The attacker DELETEd the victim's vibe `$id` (HTTP {$del->status}) and it is gone from the victim's list.",
                    "DELETE /api/vibes/$id",
                    $del->snippet(160),
                    'Scope the delete to the authenticated owner; return 404 when the row is not theirs.'
                );
            } else {
                $findings[] = $this->safe('Vibe DELETE no-op cross-tenant', "Attacker got HTTP {$del->status} but the vibe still exists for the victim.", "DELETE /api/vibes/$id");
            }
        } else {
            $findings[] = $this->safe('Vibe DELETE blocked cross-tenant', "Attacker DELETE on victim's vibe returned HTTP {$del->status}.", "DELETE /api/vibes/$id");
        }

        // Cleanup: victim removes its own vibe (best-effort).
        $this->ctx->victim->send('DELETE', "/api/vibes/$id");

        return $findings;
    }

    private function vibeStillExists(string $id): bool
    {
        $list = $this->ctx->victim->get('/api/vibes/mine');
        return str_contains($list->body, $id);
    }

    /** Victim creates a private shelf; attacker tries to read/modify it. */
    private function shelfIdor(): array
    {
        $create = $this->ctx->victim->postJson('/api/shelves', [
            'name'        => 'victim-shelf-' . bin2hex(random_bytes(3)),
            'description' => 'private-secret-' . bin2hex(random_bytes(4)),
            'visibility'  => 'private',
        ]);
        $id = $create->json()['shelf']['id'] ?? null;
        if (!$id) {
            return [$this->inconclusive('Shelf IDOR setup failed', "Victim could not create a shelf (HTTP {$create->status}).", 'POST /api/shelves')];
        }

        $findings = [];

        // Attacker reads the victim's private shelf via the owner render route.
        $read = $this->ctx->attacker->get("/api/shelves/$id/render");
        if ($read->ok() && str_contains($read->body, 'private-secret')) {
            $findings[] = $this->vuln(
                'IDOR: attacker read another user\'s private shelf',
                Finding::HIGH,
                "The attacker fetched the victim's private shelf `$id` and the response contained the planted secret.",
                "GET /api/shelves/$id/render",
                $read->snippet(180),
                'Filter the owner render route by `creator = current user`; private shelves should 404 for others.'
            );
        } else {
            $findings[] = $this->safe('Private shelf read blocked', "Attacker render of victim's shelf returned HTTP {$read->status} without the secret.", "GET /api/shelves/$id/render");
        }

        // Attacker renames the victim's shelf.
        $patch = $this->ctx->attacker->send('PATCH', "/api/shelves/$id", json_encode(['name' => 'HIJACKED-SHELF']), ['Content-Type' => 'application/json']);
        if ($patch->ok()) {
            $findings[] = $this->vuln(
                'IDOR: attacker modified another user\'s shelf',
                Finding::HIGH,
                "The attacker PATCHed the victim's shelf `$id` and got HTTP {$patch->status}.",
                "PATCH /api/shelves/$id",
                $patch->snippet(160),
                'Scope shelf updates to the owner; return 404 on a creator mismatch.'
            );
        } else {
            $findings[] = $this->safe('Shelf PATCH blocked cross-tenant', "Attacker PATCH on victim's shelf returned HTTP {$patch->status}.", "PATCH /api/shelves/$id");
        }

        // Cleanup.
        $this->ctx->victim->send('DELETE', "/api/shelves/$id");

        return $findings;
    }
}
