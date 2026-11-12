<?php

namespace App\Services\Licensing;

use Illuminate\Support\Collection;
use Illuminate\Support\Facades\DB;

/**
 * A bibliography entry can point at a source row the reader cannot see: a WebFetch evidence
 * page or a closed work we hold only for citation review are PRIVATE (HostingPolicy). The
 * bibliography reads join `library` through RLS, so for those the join comes back empty and the
 * card would treat the source as readable (`source_has_nodes` null → "true") and offer an
 * "open" link that lands on nothing.
 *
 * This back-fills, via pgsql_admin, only what the citation card needs — whether it is a web
 * stub, its ORIGINAL url, and that it is not readable here — for system-held rows the join
 * missed. Never body text, never a user's own private book.
 */
final class RestrictedSourceRows
{
    /**
     * @param  Collection<int, object>  $refs  rows with source_id / source_type / source_url / source_has_nodes
     */
    public static function fill(Collection $refs): void
    {
        $missing = $refs->filter(fn ($r) => ! empty($r->source_id) && ($r->source_type ?? null) === null && ($r->source_has_nodes ?? null) === null)
            ->pluck('source_id')->unique()->values()->all();
        if (! $missing) {
            return;
        }

        $rows = DB::connection('pgsql_admin')->table('library')
            ->whereIn('book', $missing)
            ->whereIn('creator', LicenseDiscovery::SYSTEM_CREATORS)
            ->where('visibility', '!=', 'public')
            ->get(['book', 'type', 'url'])
            ->keyBy('book');

        foreach ($refs as $r) {
            $row = $rows[$r->source_id ?? ''] ?? null;
            if (! $row) {
                continue;
            }
            $r->source_type = $row->type;
            $r->source_url = $row->url;
            $r->source_has_nodes = false; // held for review, not readable here
        }
    }
}
