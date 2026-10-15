<?php

namespace App\Services;

use App\Models\User;
use App\Support\UserHomeBookNames;
use App\Support\UsernameKey;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\File;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Facades\Mail;
use Illuminate\Support\Str;

/**
 * Deletes a user account — the whole-account counterpart of BookDeletionService.
 *
 * The users ROW is never hard-deleted: billing_ledger.user_id carries a bare FK
 * with no ON DELETE action, and the ledger is retained as a financial record.
 * Instead the row is TOMBSTONED (renamed to `deleted_{id}`, email/password/
 * preferences scrubbed, user_token ROTATED — which alone severs every RLS
 * owner-write) and the original name is retired forever in `deleted_usernames`
 * (see that migration for why a freed name is an impersonation vector).
 *
 * The caller (DeleteUserAccountJob) passes two user choices made at deletion:
 *   - $booksChoice:       what happens to PUBLISHED public books
 *   - $annotationsChoice: what happens to public annotations on OTHERS' books
 * each one of 'delete' | 'anonymize' | 'keep'. Private, unlisted and encrypted
 * books are ALWAYS deleted; private annotations (sub-book library row private)
 * are ALWAYS deleted. Telemetry is anonymized (user_name → NULL), never
 * deleted — the day-dedup happened at write time, so historical counts stay
 * honest.
 *
 * Runs ENTIRELY on pgsql_admin: almost every phase is a cross-user or bulk
 * write that the caller's RLS context would silently skip (the written-down
 * precedent is BookDeletionService's shelf cleanup). Phases are individually
 * idempotent — a crashed job can be re-run manually and deletes nothing twice.
 *
 * Deleted PUBLIC books (or any book with a slug) keep a scrubbed library row:
 * visibility='deleted', slug retained so the URL stays reserved against
 * squatting, content fields nulled. TextController serves those as a 410
 * tombstone page. Never-linkable books (private/unlisted/encrypted, no slug)
 * are hard-deleted outright.
 */
class UserAccountDeletionService
{
    public const CHOICES = ['delete', 'anonymize', 'keep'];

    private \Illuminate\Database\ConnectionInterface $db;

    private array $stats = [];

    /** Root books whose connection counts changed — ONE refresh at the end. */
    private array $affectedBooks = [];

    public function __construct()
    {
        $this->db = DB::connection('pgsql_admin');
    }

    public function deleteAccount(User $user, string $booksChoice, string $annotationsChoice): array
    {
        if (! in_array($booksChoice, self::CHOICES, true) || ! in_array($annotationsChoice, self::CHOICES, true)) {
            throw new \InvalidArgumentException('Invalid deletion choice');
        }

        // ---- Phase A: capture (the tombstone rename destroys these) --------
        $name = $user->name;
        $email = $user->email;
        $userId = $user->id;
        $sanitized = UserHomeBookNames::sanitize($name);
        $tombstone = 'deleted_'.$userId;
        $generatedNames = UserHomeBookNames::allGeneratedNames($sanitized);

        // Root books only (no '/'), excluding the generated user-home books —
        // those are machinery, handled in phase D, not "books the user wrote".
        $ownedRoots = $this->db->table('library')
            ->where('creator', $name)
            ->where('book', 'not like', '%/%')
            ->whereNotIn('book', $generatedNames)
            ->where('visibility', '!=', 'deleted')
            ->get(['book', 'visibility', 'slug', 'encrypted', 'listed']);

        $alwaysDelete = [];
        $publicSet = [];
        foreach ($ownedRoots as $row) {
            if ($row->visibility === 'public' && empty($row->encrypted)) {
                $publicSet[] = $row;
            } else {
                $alwaysDelete[] = $row; // private, unlisted, encrypted
            }
        }

        $this->stats = [
            'user_id' => $userId,
            'books_choice' => $booksChoice,
            'annotations_choice' => $annotationsChoice,
            'books_deleted' => 0,
            'books_tombstoned' => 0,
            'books_anonymized' => 0,
            'books_kept' => 0,
            'annotations_deleted' => 0,
            'annotations_anonymized' => 0,
        ];

        // ---- Phase B: delete books -----------------------------------------
        $toDelete = $alwaysDelete;
        if ($booksChoice === 'delete') {
            $toDelete = array_merge($toDelete, $publicSet);
        }
        foreach ($toDelete as $row) {
            $this->deleteOwnedBook($row, $name, $tombstone);
        }

        // ---- Phase C: kept public books ------------------------------------
        if ($booksChoice !== 'delete') {
            foreach ($publicSet as $row) {
                if ($booksChoice === 'anonymize') {
                    $this->db->table('library')
                        ->where(function ($q) use ($row) {
                            $q->where('book', $row->book)->orWhere('book', 'like', $this->likePrefix($row->book).'/%');
                        })
                        ->where('creator', $name)
                        ->update(['creator' => $tombstone, 'creator_token' => null]);
                    $this->stats['books_anonymized']++;
                    // The byline is baked into the prerendered chunks.
                    try {
                        app(BookCache::class)->invalidate($row->book);
                    } catch (\Throwable $e) {
                        Log::warning('AccountDeletion: BookCache invalidate failed', ['book' => $row->book, 'error' => $e->getMessage()]);
                    }
                } else {
                    $this->stats['books_kept']++;
                }
            }
            // Public vibes (standalone themes) follow the books choice.
            if ($booksChoice === 'anonymize') {
                $this->db->table('vibes')->where('creator', $name)->where('visibility', 'public')
                    ->update(['creator' => $tombstone, 'creator_token' => null]);
            }
        }

        // ---- Phase D: generated user-home books (always) -------------------
        foreach ($generatedNames as $genName) {
            $this->db->table('nodes')->where('book', $genName)->delete();
            $this->db->table('footnotes')->where('book', $genName)->delete();
            $this->db->table('library')->where('book', $genName)->delete();
            $this->purgeNodesHistory($genName);
            try {
                app(BookCache::class)->invalidate($genName);
            } catch (\Throwable $e) {
                // best-effort
            }
            $this->purgeDiskDirs($genName);
        }

        // ---- Phase E: annotations on other people's books ------------------
        $this->handleForeignAnnotations($name, $tombstone, $annotationsChoice);

        // ---- Phase F: scrubs ----------------------------------------------
        $this->runScrubs($name, $tombstone, $email, $booksChoice);

        // ---- Phase G: connections, once ------------------------------------
        if (! empty($this->affectedBooks)) {
            try {
                app(\App\Services\Connections\ConnectionRefresher::class)
                    ->refresh(array_values(array_unique($this->affectedBooks)));
            } catch (\Throwable $e) {
                Log::warning('AccountDeletion: connection refresh failed', ['error' => $e->getMessage()]);
            }
        }

        // ---- Phase H: tombstone the users row ------------------------------
        $this->tombstoneUser($userId, $name, $email, $tombstone);

        // ---- Phase I: notify ----------------------------------------------
        try {
            Mail::send(new \App\Mail\AccountDeletedMail($email, $name));
        } catch (\Throwable $e) {
            Log::warning('AccountDeletion: completion mail failed', ['error' => $e->getMessage()]);
        }

        Log::info('AccountDeletion: account deleted', $this->stats);

        return $this->stats;
    }

    // ------------------------------------------------------------------ books

    private function deleteOwnedBook(object $row, string $name, string $tombstone): void
    {
        $bookId = $row->book;

        (new BookDeletionService)->useConnection($this->db)->deleteBook($bookId);
        $this->affectedBooks[] = $bookId;

        // Externally linkable (was public, or owns a slug) → keep a scrubbed
        // tombstone row so the URL serves a 410 and the slug stays reserved.
        $linkable = $row->visibility === 'public' || ! empty($row->slug);

        if ($linkable) {
            $this->db->table('library')
                ->where(function ($q) use ($bookId) {
                    $q->where('book', $bookId)->orWhere('book', 'like', $this->likePrefix($bookId).'/%');
                })
                ->where('creator', $name)
                ->update([
                    'title' => null,
                    'author' => null,
                    'note' => null,
                    'abstract' => null,
                    'bibtex' => null,
                    'url' => null,
                    'raw_json' => '{}', // NOT NULL column — empty object, not NULL
                    // search_vector is a GENERATED column — it re-derives from
                    // the nulled fields on its own and cannot be assigned.
                    'creator' => $tombstone,
                    'creator_token' => null,
                ]);
            $this->stats['books_tombstoned']++;
        } else {
            // Never externally linkable — remove the rows outright. Only the
            // user's OWN rows: other users' metadata_only annotation sub-books
            // stay soft-deleted exactly as a single-book delete leaves them.
            $this->db->table('library')
                ->where(function ($q) use ($bookId) {
                    $q->where('book', $bookId)->orWhere('book', 'like', $this->likePrefix($bookId).'/%');
                })
                ->where('creator', $name)
                ->delete();
            $this->stats['books_deleted']++;
        }

        // The user's own annotation rows on this book — BookDeletionService
        // deliberately KEEPS hyperlights (and hypercites for citation display).
        // The owner is being erased: their hyperlights go everywhere; their
        // hypercite rows go only where the book itself is gone (on a tombstoned
        // public book they stay, marked dead, so other users' pastes keep
        // rendering the quotation they legitimately made while it was public).
        $subtree = fn ($q) => $q->where('book', $bookId)->orWhere('book', 'like', $this->likePrefix($bookId).'/%');
        $this->db->table('hyperlights')->where($subtree)->where('creator', $name)->delete();
        if (! $linkable) {
            $this->db->table('hypercites')->where($subtree)->where('creator', $name)->delete();
        }

        $this->purgeNodesHistory($bookId);
        $this->purgeDiskDirs($bookId);
    }

    // ------------------------------------------------------------ annotations

    private function handleForeignAnnotations(string $name, string $tombstone, string $choice): void
    {
        // Rows the book phases didn't consume: annotations whose host root book
        // is NOT one of the user's own (those were handled in deleteOwnedBook).
        $foreignLights = $this->db->table('hyperlights')->where('creator', $name)->get(['id', 'book', 'hyperlight_id', 'sub_book_id']);
        $foreignCites = $this->db->table('hypercites')->where('creator', $name)->get(['id', 'book', 'citedIN']);

        $touchedBooks = [];

        foreach ($foreignLights as $hl) {
            $subBookId = $hl->sub_book_id ?: \App\Helpers\SubBookIdHelper::build($hl->book, $hl->hyperlight_id);

            // Private annotations are ALWAYS deleted, regardless of choice.
            $isPrivate = $this->db->table('library')->where('book', $subBookId)
                ->where('visibility', 'private')->exists();

            if ($choice === 'delete' || $isPrivate) {
                (new BookDeletionService)->useConnection($this->db)->deleteSubBookContent($subBookId);
                // The sub-book rows belong to the deleted user — remove them.
                $this->db->table('library')
                    ->where(function ($q) use ($subBookId) {
                        $q->where('book', $subBookId)->orWhere('book', 'like', $this->likePrefix($subBookId).'/%');
                    })
                    ->where('creator', $name)
                    ->delete();
                $this->purgeNodesHistory($subBookId);
                $this->db->table('hyperlights')->where('id', $hl->id)->delete();
                $this->stats['annotations_deleted']++;
            } elseif ($choice === 'anonymize') {
                $this->db->table('hyperlights')->where('id', $hl->id)
                    ->update(['creator' => $tombstone, 'creator_token' => null]);
                $this->db->table('library')->where('book', $subBookId)->where('creator', $name)
                    ->update(['creator' => $tombstone, 'creator_token' => null]);
                $this->stats['annotations_anonymized']++;
            }
            $touchedBooks[] = $hl->book;
        }

        foreach ($foreignCites as $hc) {
            if ($choice === 'delete') {
                // Tell every citing book its link target changed, then remove.
                $citedIN = json_decode($hc->citedIN ?? '[]', true) ?: [];
                foreach ($citedIN as $ref) {
                    $bookPart = explode('#', ltrim((string) $ref, '/'))[0];
                    if ($bookPart !== '') {
                        $touchedBooks[] = $bookPart;
                        if (str_contains($bookPart, '/')) {
                            $touchedBooks[] = \App\Helpers\SubBookIdHelper::parse($bookPart)['foundation'];
                        }
                    }
                }
                $this->db->table('hypercites')->where('id', $hc->id)->delete();
                $this->stats['annotations_deleted']++;
            } elseif ($choice === 'anonymize') {
                $this->db->table('hypercites')->where('id', $hc->id)
                    ->update(['creator' => $tombstone, 'creator_token' => null]);
                $this->stats['annotations_anonymized']++;
            }
            $touchedBooks[] = $hc->book;
        }

        if ($choice === 'keep') {
            return; // rows untouched; rotated user_token already severs writes
        }

        // Clients re-fetch annotations when the host book's timestamp moves.
        $roots = [];
        foreach (array_unique(array_filter($touchedBooks)) as $book) {
            $roots[] = $book;
            if (str_contains($book, '/')) {
                $roots[] = \App\Helpers\SubBookIdHelper::parse($book)['foundation'];
            }
        }
        $roots = array_values(array_unique($roots));
        $now = round(microtime(true) * 1000);
        foreach ($roots as $book) {
            try {
                // $this->db, not the DB facade — the default connection may sit
                // inside an open transaction (RefreshDatabase in tests) whose
                // row locks would block this service's later admin writes.
                $this->db->select('SELECT update_annotations_timestamp(?, ?)', [$book, $now]);
            } catch (\Throwable $e) {
                // best-effort — a missing book is fine
            }
        }
        $this->affectedBooks = array_merge($this->affectedBooks, $roots);
    }

    // ----------------------------------------------------------------- scrubs

    private function runScrubs(string $name, string $tombstone, string $email, string $booksChoice): void
    {
        // Telemetry: anonymize, never delete — counts were day-deduped at
        // write time, so nulling the name keeps every historical number honest.
        foreach (['book_reads', 'page_views', 'user_reading_positions'] as $table) {
            $this->db->table($table)->where('user_name', $name)->update(['user_name' => null]);
        }

        $this->db->table('notifications')->where('recipient', $name)->delete();
        $this->db->table('notifications')->where('actor', $name)->update(['actor' => $tombstone]);

        $this->db->table('book_likes')->where('creator', $name)->delete();
        $this->db->table('pinned_books')->where('creator', $name)->delete();
        $this->db->table('shelf_pins')->where('creator', $name)->delete();

        $shelfIds = $this->db->table('shelves')->where('creator', $name)->pluck('id');
        if ($shelfIds->isNotEmpty()) {
            $this->db->table('shelf_items')->whereIn('shelf_id', $shelfIds)->delete();
            $this->db->table('shelves')->whereIn('id', $shelfIds)->delete();
            $invalidator = new ShelfCacheInvalidator;
            foreach ($shelfIds as $id) {
                $invalidator->flush((string) $id);
            }
        }

        // Non-public vibes are the user's private drafts — always deleted.
        // (Public ones were handled with the books choice in phase C; under
        // 'delete' they go here too.)
        $vibeQuery = $this->db->table('vibes')->where('creator', $name);
        if ($booksChoice !== 'delete') {
            $vibeQuery->where('visibility', '!=', 'public');
        }
        $vibeQuery->delete();
        $this->db->table('vibes')->where('source_creator', $name)->update(['source_creator' => $tombstone]);

        // BYO-key / inference tickets hold request+completion payloads — purge.
        $this->db->table('inference_tickets')->where('creator', $name)->delete();

        // Operational history keeps its shape, loses its PII.
        $this->db->table('import_batches')->where('creator', $name)
            ->update(['creator' => $tombstone, 'creator_token' => null, 'notify_email' => null]);
        $this->db->table('canonical_source')->where('creator', $name)->update(['creator' => $tombstone]);
        $this->db->table('storage_scan_items')->where('owner', $name)->delete();

        $this->db->table('password_reset_tokens')->where('email', $email)->delete();
    }

    // -------------------------------------------------------------- tombstone

    private function tombstoneUser(int $userId, string $name, string $email, string $tombstone): void
    {
        $this->db->transaction(function () use ($userId, $name, $email, $tombstone) {
            $this->db->table('deleted_usernames')->insertOrIgnore([
                'user_id' => $userId,
                'name' => $name,
                'name_key' => UsernameKey::for($name),
                'deleted_at' => now(),
            ]);

            $update = [
                'name' => $tombstone,
                'email' => $tombstone.'@tombstone.invalid',
                'password' => bcrypt(Str::random(64)),
                'remember_token' => null,
                'email_verified_at' => null,
                'preferences' => null,
                'user_token' => Str::uuid()->toString(), // rotation severs every RLS owner-write
                'status' => 'deleted',
                'is_admin' => false,
            ];

            try {
                $this->db->table('users')->where('id', $userId)->update($update);
            } catch (\Illuminate\Database\QueryException $e) {
                if ($e->getCode() !== '23505') {
                    throw $e;
                }
                // A pre-gate squatter holds `deleted_{id}` — fall back to a
                // random suffix (the deleted_\d registration block stops new ones).
                $update['name'] = $tombstone.'_x'.Str::lower(Str::random(6));
                $update['email'] = $update['name'].'@tombstone.invalid';
                $this->db->table('users')->where('id', $userId)->update($update);
            }
        });

        $this->db->table('passkey_credentials')->where('user_id', $userId)->delete();
        $this->db->table('user_e2ee_vaults')->where('user_id', $userId)->delete();
        $this->db->table('sessions')->where('user_id', $userId)->delete();
        $this->db->table('personal_access_tokens')
            ->where('tokenable_type', User::class)->where('tokenable_id', $userId)->delete();

        // SetDatabaseSessionContext caches the RLS token for 5 minutes.
        Cache::forget("user_token:{$userId}");
    }

    // ---------------------------------------------------------------- helpers

    /** Escape LIKE wildcards in a book-id prefix (ids routinely contain `_`). */
    private function likePrefix(string $id): string
    {
        return str_replace(['\\', '%', '_'], ['\\\\', '\\%', '\\_'], $id);
    }

    /**
     * nodes_history holds a plaintext mirror written by the versioning trigger
     * (no RLS, nothing else cleans it) — precedent: the E2EE lock scrub.
     */
    private function purgeNodesHistory(string $bookId): void
    {
        $this->db->table('nodes_history')
            ->where(function ($q) use ($bookId) {
                $q->where('book', $bookId)->orWhere('book', 'like', $this->likePrefix($bookId).'/%');
            })
            ->delete();
    }

    /**
     * File trees nothing else reclaims: conversion artifacts and legacy public
     * images. Paths come from config/storage.php roots ONLY (the 2026-08-01
     * rule — and what sandboxes these deletes under APP_ENV=testing). Images
     * and audio under the `books` root were already purged by
     * BookDeletionService via their stores.
     */
    private function purgeDiskDirs(string $bookId): void
    {
        $roots = config('storage.roots');
        foreach (['markdown', 'legacy_images'] as $key) {
            $dir = ($roots[$key] ?? null) ? $roots[$key].'/'.$bookId : null;
            if ($dir && File::isDirectory($dir)) {
                try {
                    File::deleteDirectory($dir);
                } catch (\Throwable $e) {
                    Log::warning('AccountDeletion: disk purge failed', ['dir' => $dir, 'error' => $e->getMessage()]);
                }
            }
        }
    }
}
