<?php

namespace App\Services\Archives;

use App\Models\ArchiveSource;
use App\Support\UsernameKey;
use Illuminate\Database\QueryException;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

/**
 * Gives an owner's public shelf a global /a/{slug} archive page.
 *
 * The slug is SET ONCE, exactly like a book slug (DbLibraryController::setSlug):
 * there is no slug history and no redirect, so changing it would kill every
 * link to the archive and free the old address for someone else. The owner
 * picks it at creation (prefilled with suggest()); after that mint() returns
 * the existing row unchanged whatever slug it is asked for. The maintainer
 * console (ShelfImportController::saveArchive) remains the escape hatch.
 *
 * Owner-minted rows carry display_name = NULL (ArchiveIdentity borrows the
 * shelf's live name) and certified_at = NULL — certification is a human
 * operator judgement, so a self-made archive never reaches the homepage list.
 */
class ShelfArchiveMinter
{
    public const SLUG_PATTERN = '/^[a-z0-9]+(?:-[a-z0-9]+)*$/';

    public const SLUG_MAX = 100;

    public function existing(string $shelfId): ?ArchiveSource
    {
        return ArchiveSource::where('shelf_id', $shelfId)->first();
    }

    public function isAvailable(string $slug): bool
    {
        return self::isValidSlug($slug) && !ArchiveSource::where('slug', $slug)->exists();
    }

    public static function isValidSlug(string $slug): bool
    {
        return strlen($slug) <= self::SLUG_MAX && preg_match(self::SLUG_PATTERN, $slug) === 1;
    }

    /**
     * First free candidate: the shelf's own slug, then {slug}-{username},
     * then {slug}-{username}-2, -3 …
     */
    public function suggest(object $shelf): string
    {
        $base = $this->clip((string) ($shelf->slug ?? '') !== '' ? (string) $shelf->slug : Str::slug((string) $shelf->name));
        if ($base === '') {
            $base = 'archive';
        }
        if ($this->isAvailable($base)) {
            return $base;
        }

        $user = Str::slug(UsernameKey::for((string) $shelf->creator)) ?: 'shelf';
        $withUser = $this->clip($base . '-' . $user);
        if ($this->isAvailable($withUser)) {
            return $withUser;
        }

        for ($n = 2; ; $n++) {
            $candidate = $this->clip($base . '-' . $user, strlen('-' . $n)) . '-' . $n;
            if ($this->isAvailable($candidate)) {
                return $candidate;
            }
        }
    }

    /**
     * Mint the shelf's archive at $slug, or return the one it already has.
     *
     * @return array{archive: ArchiveSource, created: bool}|null  null = slug taken
     */
    public function mint(object $shelf, string $slug): ?array
    {
        if ($existing = $this->existing($shelf->id)) {
            return ['archive' => $existing, 'created' => false];
        }

        try {
            $archive = new ArchiveSource();
            $archive->shelf_id = $shelf->id;
            $archive->slug = $slug;
            $archive->display_name = null;
            $archive->about = null;
            $archive->certified_at = null;
            // Own (sub)transaction: a 23505 must roll back to a savepoint, not
            // poison an enclosing transaction for the re-read below.
            DB::transaction(fn () => $archive->save());

            // id is DB-defaulted (gen_random_uuid) and the model doesn't mint it,
            // so re-read by the unique shelf_id rather than fresh().
            return ['archive' => $this->existing($shelf->id), 'created' => true];
        } catch (QueryException $e) {
            if (($e->errorInfo[0] ?? null) !== '23505') {
                throw $e;
            }
            // A double click raced us to this shelf's row → that row is the answer.
            if ($existing = $this->existing($shelf->id)) {
                return ['archive' => $existing, 'created' => false];
            }

            return null; // the slug itself was taken between check and insert
        }
    }

    private function clip(string $slug, int $reserve = 0): string
    {
        return rtrim(substr($slug, 0, self::SLUG_MAX - $reserve), '-');
    }
}
