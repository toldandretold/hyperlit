<?php

namespace App\Services;

use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\File;

/**
 * Migrates ONE book's images from the two legacy locations into the unified
 * private store (docs/e2ee.md):
 *   A: storage/app/public/books/{book}/images/  (EPUB, /storage/books/… srcs → rewritten)
 *   B: resources/markdown/{book}/media/         (DOCX/PDF/ZIP, /{book}/media/… srcs → unchanged)
 *
 * Reused by the bulk backfill command AND the encrypt transition (which must
 * migrate a book's images into the store BEFORE its scrub deletes the legacy
 * dirs — otherwise it destroys the only copies). Idempotent: a book with no
 * legacy files is a no-op. All DB work on the admin (BYPASSRLS) connection.
 */
class LegacyImageMigrator
{
    public function __construct(private BookImageStore $store) {}

    private function legacyPublicDir(string $book): string
    {
        return storage_path("app/public/books/{$book}/images");
    }

    private function legacyMediaDir(string $book): string
    {
        return resource_path("markdown/{$book}/media");
    }

    /**
     * @return array{files: int, rewritten_nodes: int, had_public_images: bool}
     */
    public function migrateBook(string $book, bool $dryRun = false): array
    {
        $legacyPublic = $this->legacyPublicDir($book);
        $legacyMedia = $this->legacyMediaDir($book);

        $publicFiles = is_dir($legacyPublic) ? File::files($legacyPublic) : [];
        $mediaFiles = is_dir($legacyMedia) ? File::files($legacyMedia) : [];

        $files = collect()->merge($publicFiles)->merge($mediaFiles)
            ->filter(fn ($f) => in_array(
                strtolower($f->getExtension()), BookImageStore::ALLOWED_EXTENSIONS, true
            ));

        $hasPublicImages = count($publicFiles) > 0;

        // Nothing legacy to do (already migrated / never had images).
        if ($files->isEmpty() && ! $hasPublicImages) {
            return ['files' => 0, 'rewritten_nodes' => 0, 'had_public_images' => false];
        }

        $ingested = $files->count();
        if (! $dryRun && $files->isNotEmpty()) {
            // Stage into a handoff dir so BookImageStore::ingestFromDirectory
            // moves + registers them (media wins collisions: copy media LAST).
            $handoff = storage_path("app/tmp/img-migrate/{$book}");
            File::ensureDirectoryExists($handoff);
            foreach ($publicFiles as $f) {
                File::copy($f->getPathname(), "{$handoff}/{$f->getFilename()}");
            }
            foreach ($mediaFiles as $f) {
                File::copy($f->getPathname(), "{$handoff}/{$f->getFilename()}"); // overwrites → B wins
            }
            $ingested = $this->store->ingestFromDirectory($book, $handoff);
            File::deleteDirectory($handoff);

            // Remove BOTH legacy source dirs — the images now live in the private
            // store (we staged by copy, so the originals here are redundant). The
            // public dir is the unauthenticated leak; the markdown media dir is
            // the old auth-gated copy.
            File::deleteDirectory(storage_path("app/public/books/{$book}"));
            File::deleteDirectory($legacyMedia);
        }

        // Rewrite the public /storage/books/{book}/images/ src shape in content
        // (only legacy-A / EPUB books have it; media-path srcs are already canonical).
        $rewritten = $hasPublicImages ? $this->rewriteSrcs($book, $dryRun) : 0;

        return ['files' => $ingested, 'rewritten_nodes' => $rewritten, 'had_public_images' => $hasPublicImages];
    }

    /**
     * Replace `/storage/books/{book}/images/` with `/{book}/media/` in the
     * book's nodes + nodes_history content, so current and version-history
     * renders point at the canonical media route. Returns the number of rows
     * touched.
     */
    private function rewriteSrcs(string $book, bool $dryRun): int
    {
        $admin = DB::connection('pgsql_admin');
        $from = "/storage/books/{$book}/images/";
        $to = "/{$book}/media/";

        $touched = 0;
        foreach (['nodes', 'nodes_history'] as $table) {
            $rows = $admin->table($table)
                ->where('book', $book)
                ->where('content', 'like', "%{$from}%")
                ->get(['content', $table === 'nodes' ? 'startLine' : 'history_id']);

            foreach ($rows as $row) {
                if ($dryRun) {
                    $touched++;

                    continue;
                }
                $key = $table === 'nodes'
                    ? ['book' => $book, 'startLine' => $row->startLine]
                    : ['history_id' => $row->history_id];

                $admin->table($table)->where($key)->update([
                    'content' => $row->content !== null ? str_replace($from, $to, $row->content) : null,
                ]);
                $touched++;
            }
        }

        return $touched;
    }
}
