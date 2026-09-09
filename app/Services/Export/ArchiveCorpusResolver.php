<?php

namespace App\Services\Export;

use App\Models\ArchiveSource;
use App\Models\JournalSource;
use Illuminate\Support\Facades\DB;

/**
 * Resolves the exportable corpus behind an archive panel scope — a user's
 * library (/u/{username}), a journal's article shelf (/j/{slug}) or a scraped
 * archive's shelf (/a/{slug}) — into concrete library rows.
 *
 * All reads go through pgsql_admin with EXPLICIT visibility filters instead of
 * relying on RLS session vars: the corpus is also resolved inside queue
 * workers, where forgotten session vars silently yield an EMPTY corpus — the
 * worst possible failure for a cached export artifact. Callers decide
 * $includePrivate server-side (sanctum owner check); it is never client input.
 *
 * Encrypted (E2EE) books hold ciphertext the server cannot render, so they are
 * split out of the exportable list and surfaced for the artifact manifest.
 * They are forced private while encrypted, so they can only ever appear in an
 * owner-audience corpus in the first place.
 */
class ArchiveCorpusResolver
{
    public const SCOPE_TYPES = ['user', 'journal', 'archive'];

    /** Columns the panel, digest and builders need. */
    private const BOOK_COLUMNS = [
        'book', 'title', 'author', 'year', 'timestamp', 'visibility',
        'encrypted', 'annotations_updated_at',
    ];

    /** @return ArchiveCorpus|null null = unknown scope (caller 404s) */
    public function resolve(string $scopeType, string $scopeId, bool $includePrivate): ?ArchiveCorpus
    {
        return match ($scopeType) {
            'user' => $this->resolveUser($scopeId, $includePrivate),
            'journal' => $this->resolveJournal($scopeId),
            'archive' => $this->resolveArchive($scopeId),
            default => null,
        };
    }

    /**
     * A user's REAL books. Same exclusions as the /u/{username} search corpus
     * (ShelfController::userLibraryBooks delegates here): synthetic user-home
     * rows share creator = username, so name + raw_json-type exclusions keep
     * the library-card lists themselves out of the export.
     */
    private function resolveUser(string $username, bool $includePrivate): ?ArchiveCorpus
    {
        $user = \App\Models\User::findByNamePublic($username);
        if (!$user) {
            return null;
        }

        $rows = $this->userLibraryQuery($user->name, $includePrivate)
            ->select(self::BOOK_COLUMNS)
            ->orderBy('book')
            ->get()
            ->all();

        // The user-home library row's title IS the page's display name — the
        // owner can customize it (generateUserHomeBook preserves it), and the
        // citation must say what the page actually says. Fallback is the bare
        // username: the branded title appends "— Hyperlit library", so a
        // "{name}'s library" fallback would read "…library — Hyperlit library".
        $sanitized = str_replace(' ', '', $user->name);
        $homeTitle = trim((string) DB::connection('pgsql_admin')->table('library')
            ->where('book', $sanitized)->value('title'));
        $displayName = $homeTitle !== '' ? $homeTitle : $user->name;

        return $this->corpus('user', $user->name, $displayName, $user->name, url('/u/' . rawurlencode($user->name)), $rows);
    }

    private function resolveJournal(string $slug): ?ArchiveCorpus
    {
        $journal = JournalSource::where('slug', $slug)->first();
        if (!$journal) {
            return null;
        }

        $rows = $journal->shelf_id ? $this->publicShelfRows($journal->shelf_id) : [];

        return $this->corpus('journal', $slug, $journal->display_name, $journal->publisher ?: $journal->display_name, url('/j/' . $slug), $rows);
    }

    private function resolveArchive(string $slug): ?ArchiveCorpus
    {
        $archive = ArchiveSource::where('slug', $slug)->first();
        if (!$archive) {
            return null;
        }

        $rows = $archive->shelf_id ? $this->publicShelfRows($archive->shelf_id) : [];

        return $this->corpus('archive', $slug, $archive->display_name, $archive->display_name . ' maintainers', url('/a/' . $slug), $rows);
    }

    /**
     * The base query for a user's real library books. Public so
     * ShelfController::userLibraryBooks (the /u search corpus) can delegate —
     * one definition of "a user's books".
     */
    public function userLibraryQuery(string $username, bool $includePrivate): \Illuminate\Database\Query\Builder
    {
        $sanitized = str_replace(' ', '', $username);

        return DB::connection('pgsql_admin')->table('library')
            ->where('creator', $username)
            ->whereIn('visibility', $includePrivate ? ['public', 'private'] : ['public'])
            ->whereNotIn('book', [
                $sanitized,
                $sanitized . 'Private',
                $sanitized . 'All',
                $sanitized . 'Account',
                $sanitized . 'About',
            ])
            ->where('book', 'NOT LIKE', '%/%')
            ->where('book', 'NOT LIKE', 'shelf_%')
            ->whereRaw("COALESCE(raw_json::jsonb->>'type', '') NOT IN ('user_home', 'user_home_sorted', 'user_account', 'user_about')");
    }

    /**
     * A journal/archive shelf's public member books. shelf_items' RLS select
     * policy is owner-only, so this join must run on pgsql_admin; the shelf
     * itself must be public for the corpus to exist at all (mirrors the page
     * controllers' gate).
     */
    private function publicShelfRows(string $shelfId): array
    {
        $isPublic = DB::connection('pgsql_admin')->table('shelves')
            ->where('id', $shelfId)
            ->where('visibility', 'public')
            ->exists();
        if (!$isPublic) {
            return [];
        }

        return DB::connection('pgsql_admin')->table('shelf_items')
            ->join('library', 'shelf_items.book', '=', 'library.book')
            ->where('shelf_items.shelf_id', $shelfId)
            ->where('library.visibility', 'public')
            ->select(array_map(fn ($c) => 'library.' . $c, self::BOOK_COLUMNS))
            ->orderBy('library.book')
            ->get()
            ->all();
    }

    private function corpus(string $scopeType, string $scopeId, string $displayName, string $citeAuthor, string $pageUrl, array $rows): ArchiveCorpus
    {
        $books = array_values(array_filter($rows, fn ($r) => !$r->encrypted));
        $encrypted = array_values(array_filter($rows, fn ($r) => (bool) $r->encrypted));

        return new ArchiveCorpus(
            scopeType: $scopeType,
            scopeId: $scopeId,
            displayName: $displayName,
            citeAuthor: $citeAuthor,
            pageUrl: $pageUrl,
            books: $books,
            encryptedBooks: $encrypted,
        );
    }
}
