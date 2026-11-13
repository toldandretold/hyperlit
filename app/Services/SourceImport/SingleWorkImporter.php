<?php

namespace App\Services\SourceImport;

use App\Jobs\ImportWorkJob;
use App\Jobs\ProcessDocumentImportJob;
use App\Models\CanonicalSource;
use App\Models\User;
use App\Services\CanonicalSourceMatcher;
use App\Services\CanonicalVersions\BestVersionService;
use App\Services\SourceHarvest\HarvestShelf;
use App\Services\SourceImport\Content\OaLocationResolver;
use App\Services\SourceImport\Identifier\Doi;
use App\Services\SourceImport\Identifier\Identifier;
use App\Services\SourceImport\Identifier\OpenAlexId;
use App\Services\SourceImport\Metadata\SourceMetadata;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\File;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Str;

/**
 * The single front door for "import this ONE work by DOI / OpenAlex id" — used by the web
 * URL importer and MCP `import_document` alike.
 *
 * It exists because there were two unrelated fetchers. The URL importer asked OpenAlex once,
 * refused anything OpenAlex called closed, and could only ever produce a PDF from OpenAlex's
 * one `pdf_url`. The acquisition ladder (ContentFetchService, wrapped per work by
 * AutoVersionCreator) knows every open copy — Europe PMC JATS, Unpaywall, CORE, Semantic
 * Scholar, Crossref, repository landing pages, article HTML — but only the whole-network
 * harvest and admin consoles could reach it. This chains identifier → canonical → ladder for
 * an ordinary user.
 *
 * What the importer ends up with:
 *   commons        the shared system version (creator canonicalizer_v1), on their
 *                  "Imported works" shelf — when HostingPolicy lets us host it publicly
 *   personal_copy  a private book of their own (PersonalCopyMaker) — when the copy we got
 *                  may not be redistributed, so the system version is held
 *
 * State lives in `work_imports`; progress is mirrored to resources/markdown/{id}/progress.json
 * so the existing /api/import-progress/{id} poll and MCP import_status follow it unchanged.
 */
class SingleWorkImporter
{
    public const SURFACE_WEB = 'web';
    public const SURFACE_MCP = 'mcp';

    public function __construct(
        private CanonicalSourceMatcher $matcher,
        private BestVersionService $bestVersion,
        private OaLocationResolver $oaLocations,
        private HarvestShelf $shelves,
    ) {}

    /** Identifier kinds that ride the ladder (arXiv → ar5iv and Gutenberg → EPUB keep their own lanes). */
    public static function handles(Identifier $id): bool
    {
        return $id instanceof Doi || $id instanceof OpenAlexId;
    }

    /**
     * How many open copies the free indexes know for this work. Zero for a work OpenAlex
     * calls closed is the ONLY case we refuse up front — OpenAlex's `is_oa` alone misses
     * repository pre-prints that Unpaywall / CORE / Semantic Scholar list.
     */
    public function openCopyCount(SourceMetadata $metadata, ?string $canonicalId): int
    {
        try {
            return count($this->oaLocations->resolve((object) [
                'canonical_source_id' => $canonicalId,
                'doi'                 => $metadata->doi(),
                'openalex_id'         => $metadata->openalexId(),
                'pdf_url'             => $metadata->pdfUrl(),
                'oa_url'              => $metadata->oaUrl(),
            ]));
        } catch (\Throwable $e) {
            Log::warning('SingleWorkImporter: open-copy lookup failed', ['error' => $e->getMessage()]);

            return 0;
        }
    }

    /**
     * @param  array{creator: ?string, creator_token: ?string}  $creatorInfo
     * @return array{ok: bool, status?: string, import?: string, book?: string, outcome?: string, error?: string}
     */
    public function start(
        Identifier $identifier,
        SourceMetadata $metadata,
        string $importId,
        ?User $user,
        array $creatorInfo,
        string $surface,
    ): array {
        if (!$metadata->doi() && !$metadata->openalexId()) {
            return ['ok' => false, 'error' => 'metadata_unavailable'];
        }

        $canonical = $this->matcher->ingestExternal($metadata->data, 'openalex_ingest');

        // Already readable — the commons copy, or a copy this person already owns. No fetch.
        if ($existing = $this->existingReadableVersion($canonical, $creatorInfo)) {
            // Asking for it is still "add this to my library": a commons copy goes on the
            // importer's shelf whether we fetched it just now or last year.
            if ($existing['outcome'] === 'commons' && !empty($creatorInfo['creator'])) {
                $shelf = $this->shelves->ensureImportShelfFor($creatorInfo['creator']);
                $this->shelves->addBooks($shelf->id, [$existing['book']]);
            }

            return ['ok' => true, 'status' => 'already_available'] + $existing;
        }

        if (!$metadata->isOpenAccess() && $this->openCopyCount($metadata, $canonical->id) === 0) {
            return ['ok' => false, 'error' => 'closed_access_requires_upload'];
        }

        $db = DB::connection('pgsql_admin');

        // One in-flight import per (requester, work): a double click or an agent retry joins it.
        $inFlight = $db->table('work_imports')
            ->where('canonical_source_id', $canonical->id)
            ->whereIn('status', ['queued', 'running', 'awaiting_confirmation'])
            ->where(function ($q) use ($user, $creatorInfo) {
                $user
                    ? $q->where('user_id', $user->id)
                    : $q->whereNull('user_id')->where('creator_token', $creatorInfo['creator_token'] ?? null);
            })
            ->where('updated_at', '>', now()->subHours(2))
            ->first();
        if ($inFlight) {
            return ['ok' => true, 'status' => $inFlight->status, 'import' => $inFlight->id];
        }

        // A finished attempt under the same handle (a retry after a failure keeps its slug)
        // is replaced; anyone else's handle, or a live one, is a collision.
        if ($prior = $db->table('work_imports')->where('id', $importId)->first()) {
            $sameRequester = $user
                ? (int) $prior->user_id === (int) $user->id
                : ($prior->user_id === null && $prior->creator_token !== null
                    && $prior->creator_token === ($creatorInfo['creator_token'] ?? null));
            if (!$sameRequester || !in_array($prior->status, ['failed', 'completed'], true)) {
                return ['ok' => false, 'error' => 'book_id_taken'];
            }
            $db->table('work_imports')->where('id', $importId)->delete();
        }

        $db->table('work_imports')->insert([
            'id'                  => $importId,
            'user_id'             => $user?->id,
            'creator'             => $creatorInfo['creator'] ?? null,
            'creator_token'       => $creatorInfo['creator_token'] ?? null,
            'canonical_source_id' => $canonical->id,
            'identifier'          => mb_substr($identifier->kind() . ':' . $identifier->value(), 0, 300),
            'surface'             => $surface,
            'status'              => 'queued',
            'created_at'          => now(),
            'updated_at'          => now(),
        ]);
        self::writeProgress($importId, 'queued', 'queued', 0, 'Waiting to start…');

        // Interactive lane: a person (or their agent) is waiting on this one work, so it must
        // not queue behind a bulk reconvert or a two-hour harvest slice.
        ImportWorkJob::dispatch($importId)->onQueue(ProcessDocumentImportJob::QUEUE_INTERACTIVE);

        return ['ok' => true, 'status' => 'queued', 'import' => $importId];
    }

    /**
     * MCP confirm leg: the user accepted the OCR estimate. Returns the same shape as start().
     *
     * @return array{ok: bool, status?: string, import?: string, error?: string}
     */
    public function confirm(string $confirmToken, User $user): array
    {
        $db = DB::connection('pgsql_admin');
        $row = $db->table('work_imports')
            ->where('confirm_token', $confirmToken)
            ->where('user_id', $user->id)
            ->where('status', 'awaiting_confirmation')
            ->first();
        if (!$row) {
            return ['ok' => false, 'error' => 'unknown_confirm_token'];
        }

        $db->table('work_imports')->where('id', $row->id)->update([
            'ocr_confirmed' => true,
            'confirm_token' => null,
            'status'        => 'queued',
            'updated_at'    => now(),
        ]);
        self::writeProgress($row->id, 'queued', 'queued', 40, 'OCR confirmed — waiting to start…');

        ImportWorkJob::dispatch($row->id)->onQueue(ProcessDocumentImportJob::QUEUE_INTERACTIVE);

        return ['ok' => true, 'status' => 'queued', 'import' => $row->id];
    }

    /** Is this token one of ours? (Lets the MCP tool route a confirm without guessing.) */
    public function ownsConfirmToken(string $confirmToken, User $user): bool
    {
        return DB::connection('pgsql_admin')->table('work_imports')
            ->where('confirm_token', $confirmToken)
            ->where('user_id', $user->id)
            ->exists();
    }

    /**
     * @param  array{creator: ?string, creator_token: ?string}  $creatorInfo
     * @return array{book: string, outcome: string}|null
     */
    private function existingReadableVersion(CanonicalSource $canonical, array $creatorInfo): ?array
    {
        if ($public = $this->bestVersion->bestPublicContentVersion($canonical)) {
            return ['book' => $public['book'], 'outcome' => 'commons'];
        }

        $creator = $creatorInfo['creator'] ?? null;
        $token = $creatorInfo['creator_token'] ?? null;
        if (!$creator && !$token) {
            return null;
        }

        $own = DB::connection('pgsql_admin')->table('library')
            ->where('canonical_source_id', $canonical->id)
            ->where('has_nodes', true)
            ->where('visibility', '!=', 'deleted')
            ->where(fn ($q) => $creator ? $q->where('creator', $creator) : $q->where('creator_token', $token))
            ->orderBy('created_at')
            ->value('book');

        return $own ? ['book' => $own, 'outcome' => 'personal_copy'] : null;
    }

    /**
     * progress.json in the shape ImportController::importProgress serves, plus the fields a
     * work import adds (`book`, `outcome`, the OCR estimate). Best-effort.
     *
     * @param  array<string, mixed>  $extra
     */
    public static function writeProgress(string $importId, string $status, string $stage, int $percent, string $detail, array $extra = []): void
    {
        try {
            $dir = resource_path('markdown/' . preg_replace('/[^a-zA-Z0-9_-]/', '', $importId));
            File::ensureDirectoryExists($dir);
            File::put("{$dir}/progress.json", json_encode($extra + [
                'status'     => $status,
                'stage'      => $stage,
                'percent'    => $percent,
                'detail'     => $detail,
                'updated_at' => now()->toIso8601String(),
            ], JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES));
        } catch (\Throwable) {
            // Progress is diagnostic — never fail an import over it.
        }
    }

    public static function newConfirmToken(): string
    {
        return Str::lower(Str::random(20));
    }
}
