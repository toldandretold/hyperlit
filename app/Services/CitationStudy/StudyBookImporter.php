<?php

namespace App\Services\CitationStudy;

use App\Jobs\ProcessDocumentImportJob;
use App\Models\User;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\File;
use RuntimeException;

/**
 * Imports a corpus book into the local library under a deterministic bookId
 * (study_{corpus}_{slug}), owned by the configured study user.
 *
 * Invariant this class exists to uphold: study books NEVER carry canonical
 * identifiers (openalex_id / open_library_key / canonical_source_id). Wave 3
 * local-library matching only considers rows that have them, so a NULL there
 * is what makes it impossible for a fabricated reference to "resolve" against
 * another study book and silently invalidate the ground truth.
 */
class StudyBookImporter
{
    public function studyUser(): User
    {
        $name = config('study.user_name');
        $user = User::on('pgsql_admin')->where('name', $name)->first();
        if (!$user) {
            throw new RuntimeException(
                "Study user '{$name}' not found — create the account first (config/study.php: user_name)."
            );
        }
        return $user;
    }

    public function exists(string $bookId): bool
    {
        return DB::connection('pgsql_admin')->table('library')->where('book', $bookId)->exists();
    }

    public function import(CorpusManifest $manifest, array $book, bool $reimport = false): array
    {
        $slug = $book['slug'];
        $bookId = $manifest->bookIdFor($slug);
        $studyFile = $manifest->studyFile($book);
        if (!is_file($studyFile)) {
            throw new RuntimeException("'{$slug}': study file missing: {$studyFile} (run citation:study:corrupt first?)");
        }

        $user = $this->studyUser();
        $db = DB::connection('pgsql_admin');

        if ($this->exists($bookId)) {
            if (!$reimport) {
                return ['slug' => $slug, 'book_id' => $bookId, 'skipped' => true];
            }
            $this->purge($bookId);
        }

        $provenance = $book['provenance'] ?? [];
        $db->table('library')->updateOrInsert(
            ['book' => $bookId],
            [
                'title' => $provenance['title'] ?? $slug,
                'author' => $provenance['author'] ?? null,
                'year' => $provenance['year'] ?? null,
                'type' => 'article',
                'visibility' => 'private',
                'creator' => $user->name,
                'creator_token' => null,
                'timestamp' => (int) round(microtime(true) * 1000),
                'raw_json' => json_encode(['study_corpus' => $manifest->corpus, 'study_arm' => $book['arm']]),
                'created_at' => now(),
                'updated_at' => now(),
            ]
        );

        // HTML sources are adopted for numbered/Vancouver books whose
        // pre-linked citation anchors a markdown round-trip would destroy.
        $extension = str_ends_with(strtolower($studyFile), '.html') ? 'html' : 'md';
        $path = resource_path("markdown/{$bookId}");
        File::ensureDirectoryExists($path);
        File::copy($studyFile, "{$path}/original.{$extension}");

        $formData = [
            'title' => $provenance['title'] ?? $slug,
            'author' => $provenance['author'] ?? null,
            'year' => $provenance['year'] ?? null,
            'type' => 'article',
        ];
        $creatorInfo = ['creator' => $user->name, 'creator_token' => null, 'valid' => true];

        // Run the import in-process (same pattern as CitationScanBibliographyCommand):
        // the job's handle() has typed processor dependencies, so let the
        // container inject them.
        $job = new ProcessDocumentImportJob($bookId, $extension, $user->id, $formData, $creatorInfo);
        app()->call([$job, 'handle']);

        // The job writes progress.json; a failed import leaves status=failed.
        $progressFile = "{$path}/progress.json";
        $progress = is_file($progressFile) ? json_decode((string) file_get_contents($progressFile), true) : null;
        if (($progress['status'] ?? null) === 'failed') {
            throw new RuntimeException("'{$slug}': import failed — {$progress['detail']}");
        }

        $this->assertNoCanonicalIdentifiers($bookId);

        $nodeCount = $db->table('nodes')->where('book', $bookId)->count();
        $bibCount = $db->table('bibliography')->where('book', $bookId)->count();
        if ($nodeCount === 0) {
            throw new RuntimeException("'{$slug}': import produced no nodes for {$bookId}.");
        }

        return [
            'slug' => $slug,
            'book_id' => $bookId,
            'skipped' => false,
            'nodes' => $nodeCount,
            'bibliography_rows' => $bibCount,
        ];
    }

    /** Remove a study book and its sub-books entirely (for --reimport). */
    public function purge(string $bookId): void
    {
        $db = DB::connection('pgsql_admin');
        // Sub-books live at "{parent}/{itemId}" (SubBookIdHelper::build).
        $ids = $db->table('library')
            ->where('book', $bookId)
            ->orWhere('book', 'like', str_replace(['\\', '%', '_'], ['\\\\', '\%', '\_'], $bookId) . '/%')
            ->pluck('book')
            ->all();
        $ids = array_unique(array_merge($ids, [$bookId]));

        foreach (['nodes', 'bibliography', 'footnotes', 'hyperlights', 'hypercites', 'library'] as $table) {
            $db->table($table)->whereIn('book', $ids)->delete();
        }
        File::deleteDirectory(resource_path("markdown/{$bookId}"));
    }

    /** The anti-self-contamination invariant, asserted rather than assumed. */
    public function assertNoCanonicalIdentifiers(string $bookId): void
    {
        $row = DB::connection('pgsql_admin')
            ->table('library')
            ->where('book', $bookId)
            ->first(['openalex_id', 'open_library_key', 'canonical_source_id']);
        if ($row && ($row->openalex_id || $row->open_library_key || $row->canonical_source_id)) {
            throw new RuntimeException(
                "Study book {$bookId} carries canonical identifiers — it is matchable by Wave 3 local search "
                . 'and would contaminate ground truth. Clear openalex_id/open_library_key/canonical_source_id.'
            );
        }
    }
}
