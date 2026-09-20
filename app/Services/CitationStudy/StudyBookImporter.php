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
    /**
     * Study-file extension → the extension ProcessDocumentImportJob routes on.
     * This used to be a binary ".html else md" check, which silently fed a
     * .pdf/.docx corpus source to the MARKDOWN processor — the whole
     * multi-pathway corpus hinged on this map existing.
     */
    private const PIPELINE_EXTENSIONS = [
        'pdf' => 'pdf',
        'html' => 'html', 'htm' => 'html',
        'md' => 'md', 'markdown' => 'md',
        'docx' => 'docx', 'doc' => 'doc', 'odt' => 'odt', 'rtf' => 'rtf',
        'epub' => 'epub',
    ];

    /** The pipeline extension for a corpus study file — loud on the unknown. */
    public static function pipelineExtension(string $studyFile): string
    {
        $ext = strtolower(pathinfo($studyFile, PATHINFO_EXTENSION));
        if (!isset(self::PIPELINE_EXTENSIONS[$ext])) {
            throw new RuntimeException(
                "Unsupported study-file extension '.{$ext}' ({$studyFile}) — "
                . 'supported: ' . implode(', ', array_keys(self::PIPELINE_EXTENSIONS)) . '.'
            );
        }
        return self::PIPELINE_EXTENSIONS[$ext];
    }

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

        $path = resource_path("markdown/{$bookId}");
        File::ensureDirectoryExists($path);

        if ($manifest->pathwayFor($book) === 'paste') {
            // The PASTE pathway: the source file is a captured clipboard
            // payload (resources/paste-capture.html). Run it through the SAME
            // engine a publisher-page paste uses (scripts/paste-convert.mjs
            // via ContentFetchService), which persists nodes + bibliography +
            // footnotes itself. Stored as fetched_page.html — the file
            // reconvertHtmlLaneFromStoredPage reads.
            File::copy($studyFile, "{$path}/fetched_page.html");
            $record = $db->table('library')->where('book', $bookId)->first();
            $result = app(\App\Services\ContentFetchService::class)
                ->reconvertHtmlLaneFromStoredPage($record);
            // Success is 'imported' ('partial' = degraded fallback conversion —
            // a legitimate pathway outcome, kept and visible in the results).
            if (($result['status'] ?? null) === 'failed') {
                throw new RuntimeException(
                    "'{$slug}': paste-engine import failed — " . ($result['reason'] ?? 'unknown')
                );
            }
        } else {
            $extension = self::pipelineExtension($studyFile);
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
