<?php

namespace App\Services\Archives;

use App\Models\ArchiveSource;
use Illuminate\Support\Facades\DB;

/**
 * What an archive is CALLED and what its about copy says. A maintainer-made
 * archive carries both on its own row; an owner-minted one (ShelfArchiveMinter)
 * leaves them NULL and borrows its shelf's live name/description, so a shelf
 * rename never needs syncing. Every reader of display_name/about goes through
 * here — the page, the corpus export, the homepage list.
 *
 * Shelves are RLS'd (owner-only for private rows, and a guest has no context),
 * so the shelf read is on pgsql_admin; callers gate on visibility themselves.
 */
class ArchiveIdentity
{
    /** @var array<string, object|null> shelf_id => row */
    private array $shelves = [];

    public function name(ArchiveSource $archive): string
    {
        $own = trim((string) $archive->display_name);
        if ($own !== '') {
            return $own;
        }
        $shelfName = trim((string) ($this->shelf($archive)->name ?? ''));

        return $shelfName !== '' ? $shelfName : $archive->slug;
    }

    public function about(ArchiveSource $archive): ?string
    {
        if (trim((string) $archive->about) !== '') {
            return $archive->about;
        }
        if ($archive->display_name !== null) {
            // A maintainer archive with no copy stays copy-less — its shelf's
            // description is an import note, not public prose.
            return null;
        }
        $desc = trim((string) ($this->shelf($archive)->description ?? ''));

        return $desc !== '' ? $desc : null;
    }

    /** Owner-minted = no name of its own; its author is the shelf's creator. */
    public function isOwnerMinted(ArchiveSource $archive): bool
    {
        return $archive->display_name === null;
    }

    public function creator(ArchiveSource $archive): ?string
    {
        return $this->shelf($archive)->creator ?? null;
    }

    private function shelf(ArchiveSource $archive): ?object
    {
        $id = (string) $archive->shelf_id;
        if (!array_key_exists($id, $this->shelves)) {
            $this->shelves[$id] = DB::connection('pgsql_admin')->table('shelves')
                ->where('id', $id)
                ->first(['id', 'name', 'description', 'creator', 'visibility']);
        }

        return $this->shelves[$id];
    }
}
