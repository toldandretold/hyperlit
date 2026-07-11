<?php

namespace App\Services\CanonicalVersions;

use App\Models\CanonicalSource;
use Illuminate\Support\Facades\DB;

/**
 * Resolves "which library version of this canonical should the caller see" —
 * the read-side counterpart of the pointer resolvers. Precedence comes from
 * VersionPointerRegistry; this service adds the visibility/privacy rules and
 * the fallback to any visible linked version.
 *
 * NOTE on connections: reads go through the DEFAULT connection (like the
 * controllers it serves) so RLS/visibility semantics match what the calling
 * user is allowed to see. Do not switch these to pgsql_admin.
 */
class BestVersionService
{
    /**
     * The COALESCE over the pointer columns in precedence order, for embedding
     * in raw SQL (e.g. SearchService::searchForCitations). Deriving it here
     * means SQL consumers can never drift from the registry's order.
     */
    public static function sqlCoalesceExpression(string $tableAlias): string
    {
        $cols = array_map(
            fn (string $col) => "{$tableAlias}.{$col}",
            VersionPointerRegistry::precedenceColumns(),
        );

        return 'COALESCE(' . implode(', ', $cols) . ')';
    }

    /**
     * Best version visible to the caller: walk the precedence pointers,
     * skipping any whose library row the caller may not see, then fall back
     * to any visible linked version. Null = citation-only canonical.
     */
    public function bestVisibleVersion(CanonicalSource $canonical, ?object $user, ?string $anonymousToken): ?string
    {
        foreach (VersionPointerRegistry::precedenceColumns() as $column) {
            $candidate = $canonical->{$column};
            if ($candidate && $this->isBookVisible($candidate, $user, $anonymousToken)) {
                return $candidate;
            }
        }

        return $this->anyVisibleLinkedVersion($canonical, $user, $anonymousToken);
    }

    /**
     * System-context resolution (no caller): the best PUBLIC version that
     * actually has content, for machine consumers like the citation review's
     * passage search. Walks the precedence pointers, then any linked version.
     *
     * Returns ['book' => ..., 'pointer' => 'auto_version_book'|null] or null.
     * Reads via pgsql_admin — this runs in queue workers, where the RLS'd
     * default connection has no HTTP session context.
     */
    public function bestPublicContentVersion(CanonicalSource $canonical): ?array
    {
        if (!$canonical->id) {
            return null;
        }

        $db = DB::connection('pgsql_admin');

        foreach (VersionPointerRegistry::precedenceColumns() as $column) {
            $candidate = $canonical->{$column};
            if (!$candidate) {
                continue;
            }
            $eligible = $db->table('library')
                ->where('book', $candidate)
                ->where('visibility', 'public')
                ->where('has_nodes', true)
                ->exists();
            if ($eligible) {
                return ['book' => $candidate, 'pointer' => $column];
            }
        }

        $book = $db->table('library')
            ->where('canonical_source_id', $canonical->id)
            ->where('visibility', 'public')
            ->where('has_nodes', true)
            ->orderBy('created_at')
            ->value('book');

        return $book ? ['book' => $book, 'pointer' => null] : null;
    }

    private function anyVisibleLinkedVersion(CanonicalSource $canonical, ?object $user, ?string $anonymousToken): ?string
    {
        return DB::table('library')
            ->where('canonical_source_id', $canonical->id)
            // WebFetch scrape stubs are pipeline artifacts, never a human-readable "version" — a
            // canonical whose only version is a stub resolves to citation-only (null). (NULL type
            // is a normal book, so keep it — Postgres `type != x` alone would drop NULLs.)
            ->where(fn ($q) => $q->whereNull('type')->orWhere('type', '!=', 'web_source'))
            ->where(function ($q) use ($user, $anonymousToken) {
                // public is enough — `listed` only governs homepage listings,
                // and auto versions are deliberately public+unlisted.
                $q->where('visibility', 'public');
                if ($user) {
                    $q->orWhere(function ($p) use ($user) {
                        $p->where('creator', $user->name)
                          ->where('visibility', '!=', 'deleted');
                    });
                }
                if ($anonymousToken) {
                    $q->orWhere(function ($p) use ($anonymousToken) {
                        $p->where('creator_token', $anonymousToken)
                          ->where('visibility', '!=', 'deleted');
                    });
                }
            })
            ->orderBy('created_at')
            ->value('book');
    }

    private function isBookVisible(?string $book, ?object $user, ?string $anonymousToken): bool
    {
        if (empty($book)) return false;

        $row = DB::table('library')
            ->where('book', $book)
            ->select('creator', 'creator_token', 'visibility', 'listed', 'type')
            ->first();

        if (!$row || $row->visibility === 'deleted') return false;
        // WebFetch scrape stubs are never surfaced as a readable version (see anyVisibleLinkedVersion).
        if ($row->type === 'web_source') return false;

        // public is enough — `listed` only governs homepage listings, and auto
        // versions are deliberately public+unlisted (link-accessible).
        if ($row->visibility === 'public') return true;
        if ($user && $row->creator === $user->name) return true;
        if ($anonymousToken && $row->creator_token === $anonymousToken) return true;

        return false;
    }
}
