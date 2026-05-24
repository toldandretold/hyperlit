<?php

namespace App\Http\Controllers;

use App\Jobs\ProcessDocumentImportJob;
use App\Models\PgLibrary;
use App\Services\CanonicalSourceMatcher;
use App\Services\SourceImport\CanonicalRegistry;
use App\Services\SourceImport\ImportOrchestrator;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Auth;
use Illuminate\Support\Facades\File;
use Illuminate\Support\Facades\Log;

/**
 * URL/identifier-based imports (arXiv URL, DOI, etc.). Delegates all the
 * identifier→metadata→content work to ImportOrchestrator; this layer is
 * Laravel-shaped glue (auth, library row, queue dispatch).
 *
 * Two endpoints, mirroring the orchestrator's two phases:
 *   POST /import-url/inspect — preview (no side effects)
 *   POST /import-url         — commit (fetch content + dispatch processor)
 */
class UrlImportController extends Controller
{
    public function __construct(
        private readonly ImportOrchestrator $orchestrator,
        private readonly CanonicalRegistry $registry,
        private readonly CanonicalSourceMatcher $matcher,
    ) {}

    public function inspect(Request $request)
    {
        $request->validate([
            'url' => 'required|string|max:2048',
        ]);

        $result = $this->orchestrator->inspect($request->input('url'));

        if (!$result->ok) {
            return response()->json([
                'ok'    => false,
                'error' => $result->error,
            ], 422);
        }

        // Find any existing library versions of this work. Falls back to library.doi
        // matching when no canonical exists yet — so books imported before this
        // pathway started auto-creating canonicals still surface as duplicates.
        $existingVersions = $this->registry->findVersionsByIdentifier($result->identifier);

        return response()->json([
            'ok'         => true,
            'identifier' => [
                'kind'  => $result->identifier->kind(),
                'value' => $result->identifier->value(),
                'url'   => $result->identifier->url(),
            ],
            'metadata' => [
                'title'     => $result->metadata->title(),
                'author'    => $result->metadata->author(),
                'year'      => $result->metadata->year(),
                'doi'       => $result->metadata->doi(),
                'is_oa'     => $result->metadata->isOpenAccess(),
                'oa_status' => $result->metadata->oaStatus(),
                'license'   => $result->metadata->license(),
                'pdf_url'   => $result->metadata->pdfUrl(),
                'source'    => $result->metadata->source,
                'bibtex'    => $result->metadata->data['bibtex'] ?? null,
            ],
            'plan' => [
                'create_canonical' => $result->plan->createCanonicalVersion,
                'allow_publish'    => $result->plan->allowPublish,
                'charge_user'      => $result->plan->chargeUser,
                'access'           => $result->plan->access,
                'reason'           => $result->plan->reason,
            ],
            'existing_canonical' => $result->existingCanonical ? [
                'id'    => $result->existingCanonical->id,
                'title' => $result->existingCanonical->title,
                'doi'   => $result->existingCanonical->doi,
            ] : null,
            'existing_versions' => array_map(fn (PgLibrary $v) => [
                'book'      => $v->book,
                'title'     => $v->title,
                'author'    => $v->author,
                'year'      => $v->year,
                'has_nodes' => (bool) $v->has_nodes,
                'creator'   => $v->creator,
            ], $existingVersions),
            'suggested_slug' => $this->suggestUniqueSlug($result->metadata->data),
        ]);
    }

    /**
     * Suggest a /url slug from work metadata that is guaranteed not to collide with
     * an existing library row at lookup time. Race-prone (another import could
     * grab it before commit), but covers 99% of cases and the commit endpoint still
     * 409s on a true collision.
     */
    private function suggestUniqueSlug(array $metadata): string
    {
        $author = (string) ($metadata['author'] ?? '');
        $firstSurname = trim(strtolower(preg_replace('/^[^A-Za-z\']+/', '', explode(';', $author)[0] ?? '')));
        $firstSurname = explode(' ', $firstSurname);
        $firstSurname = array_pop($firstSurname) ?: 'work';

        $year = (string) ($metadata['year'] ?? '');
        $title = (string) ($metadata['title'] ?? '');
        $titleSlug = strtolower(preg_replace('/[^a-z0-9]+/i', '-', $title));
        $titleSlug = trim($titleSlug, '-');
        $titleSlug = implode('-', array_slice(explode('-', $titleSlug), 0, 4));

        $base = trim(implode('-', array_filter([$firstSurname, $year, $titleSlug])), '-');
        $base = preg_replace('/[^a-z0-9_-]/', '', $base);
        if ($base === '') {
            $base = 'work-' . substr(md5((string) microtime(true)), 0, 6);
        }

        if (!PgLibrary::where('book', $base)->exists()) {
            return $base;
        }
        for ($i = 2; $i < 100; $i++) {
            $candidate = "{$base}-{$i}";
            if (!PgLibrary::where('book', $candidate)->exists()) {
                return $candidate;
            }
        }
        return $base . '-' . substr(md5((string) microtime(true)), 0, 6);
    }

    public function commit(Request $request)
    {
        $request->validate([
            'url'  => 'required|string|max:2048',
            'book' => 'required|string|regex:/^[a-zA-Z0-9_-]+$/',
        ]);

        $bookId = preg_replace('/[^a-zA-Z0-9_-]/', '', $request->input('book'));
        if (empty($bookId)) {
            return response()->json(['ok' => false, 'error' => 'invalid_book_id'], 422);
        }

        // Re-resolve from scratch — never trust client-passed metadata.
        $result = $this->orchestrator->inspect($request->input('url'));
        if (!$result->ok) {
            return response()->json(['ok' => false, 'error' => $result->error], 422);
        }

        // Existing versions are surfaced at inspect time so the user can pick
        // "view existing" vs "create my own version". We don't block at commit
        // anymore — if the user explicitly chose to import another version, honour
        // it. The /url collision check below still protects against slug clashes.

        // v1: closed-access works can't be auto-fetched. The UI should redirect
        // the user to the file-upload flow with metadata pre-filled.
        if ($result->plan->access !== 'open') {
            return response()->json([
                'ok'    => false,
                'error' => 'closed_access_requires_upload',
                'metadata' => [
                    'title'  => $result->metadata->title(),
                    'author' => $result->metadata->author(),
                    'year'   => $result->metadata->year(),
                    'doi'    => $result->metadata->doi(),
                ],
            ], 422);
        }

        $creatorInfo = app(DbLibraryController::class)->getCreatorInfo($request);
        if (!$creatorInfo['valid']) {
            return response()->json(['ok' => false, 'error' => 'invalid_session'], 401);
        }

        // bookId collision: refuse rather than overwrite.
        if (PgLibrary::where('book', $bookId)->exists()) {
            return response()->json(['ok' => false, 'error' => 'book_id_taken'], 409);
        }

        $path = resource_path("markdown/{$bookId}");
        if (!File::exists($path)) {
            File::makeDirectory($path, 0755, true);
        }

        $fetch = $this->orchestrator->fetchContent($result->identifier, $result->metadata, $path);
        if (!$fetch->ok) {
            Log::warning('URL import content fetch failed', [
                'book'       => $bookId,
                'identifier' => $result->identifier->kind() . ':' . $result->identifier->value(),
                'reason'     => $fetch->reason,
                'status'     => $fetch->httpStatus,
            ]);
            return response()->json([
                'ok'     => false,
                'error'  => 'content_fetch_failed',
                'reason' => $fetch->reason,
            ], 502);
        }

        // Create library row with metadata pre-filled, mirroring the shape used by
        // ImportController::store() so the rest of the pipeline (preview cards,
        // citation pipeline, etc.) sees an identical record.
        $now = round(microtime(true) * 1000);
        $createdRecord = PgLibrary::updateOrCreate(
            ['book' => $bookId],
            [
                'title'          => $result->metadata->title(),
                'author'         => $result->metadata->author(),
                'year'           => $result->metadata->year(),
                'doi'            => $result->metadata->doi(),
                'openalex_id'    => $result->metadata->openalexId(),
                'is_oa'          => $result->metadata->isOpenAccess(),
                'oa_status'      => $result->metadata->oaStatus(),
                'oa_url'         => $result->metadata->oaUrl(),
                'pdf_url'        => $result->metadata->pdfUrl(),
                'work_license'   => $result->metadata->license(),
                'url'            => $result->identifier->url(),
                'type'           => $result->metadata->data['type'] ?? 'article',
                'journal'        => $result->metadata->data['journal'] ?? null,
                'publisher'      => $result->metadata->data['publisher'] ?? null,
                'volume'         => $result->metadata->data['volume'] ?? null,
                'issue'          => $result->metadata->data['issue'] ?? null,
                'pages'          => $result->metadata->data['pages'] ?? null,
                'abstract'       => $result->metadata->data['abstract'] ?? null,
                'bibtex'         => $result->metadata->data['bibtex'] ?? null,
                'language'       => $result->metadata->data['language'] ?? null,
                'cited_by_count' => $result->metadata->data['cited_by_count'] ?? null,
                'timestamp'      => $now,
                'visibility'     => 'public',
                'creator'        => $creatorInfo['creator'],
                'creator_token'  => $creatorInfo['creator_token'],
                'raw_json'       => json_encode([
                    'imported_via'        => 'url',
                    'identifier_kind'     => $result->identifier->kind(),
                    'identifier_value'    => $result->identifier->value(),
                    'metadata_source'     => $result->metadata->source,
                    'plan'                => [
                        'access'         => $result->plan->access,
                        'allow_publish'  => $result->plan->allowPublish,
                    ],
                ]),
            ]
        );

        // Promote OpenAlex metadata into a canonical_source row + link this library
        // version to it. We already have the normalised work in hand from the
        // inspect step, so this is essentially free (no extra API call).
        // The result: subsequent imports of the same arXiv URL/DOI hit a canonical
        // row on the very first lookup, no waiting for the async matcher to run.
        try {
            $this->matcher->linkFromNormalisedWork($createdRecord, $result->metadata->data);
        } catch (\Throwable $e) {
            Log::warning('Canonical link from URL import failed (continuing)', [
                'book'  => $bookId,
                'error' => $e->getMessage(),
            ]);
        }

        File::put("{$path}/progress.json", json_encode([
            'status'     => 'queued',
            'percent'    => 0,
            'stage'      => 'queued',
            'detail'     => 'Waiting to start...',
            'updated_at' => now()->toIso8601String(),
        ], JSON_PRETTY_PRINT));

        ProcessDocumentImportJob::dispatch(
            $bookId,
            $fetch->extension,
            Auth::id(),
            [
                'title'  => $result->metadata->title(),
                'author' => $result->metadata->author(),
                'year'   => $result->metadata->year(),
                'url'    => $result->identifier->url(),
            ],
            $creatorInfo,
        );

        Log::info('URL import dispatched', [
            'book'       => $bookId,
            'extension'  => $fetch->extension,
            'identifier' => $result->identifier->kind() . ':' . $result->identifier->value(),
            'access'     => $result->plan->access,
        ]);

        return response()->json([
            'ok'      => true,
            'bookId'  => $bookId,
            'status'  => 'processing',
            'library' => $createdRecord,
        ]);
    }
}
