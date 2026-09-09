<?php

namespace App\Http\Controllers;

use App\Jobs\BuildArchiveExportJob;
use App\Services\Export\ArchiveCorpus;
use App\Services\Export\ArchiveCorpusResolver;
use App\Services\Export\ArchiveExportStore;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Auth;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\Log;

/**
 * The archive panel behind the top-right #archiveRef button on user pages,
 * journal home and archive home: the citation/source container for a WHOLE
 * library or corpus, with bulk downloads (markdown vault zip, SQLite data
 * file) built by BuildArchiveExportJob.
 *
 * All routes are public (the archive ethos: anyone may cite/download the
 * public corpus). The AUDIENCE is computed server-side per request — a
 * signed-in owner of a user scope gets their private books included — and is
 * never accepted as client input: owner artifacts live under a separate
 * server-derived path, so a visitor can never address one.
 */
class ArchiveExportController extends Controller
{
    public function __construct(private readonly ArchiveCorpusResolver $resolver)
    {
    }

    /**
     * GET /api/archive-export/{scopeType}/{scopeId}/panel
     * Panel data: synthesized archive bibtex + counts. Client formats the
     * citation with the same bibtex pipeline as the per-book source panel.
     */
    public function panel(string $scopeType, string $scopeId)
    {
        $scopeId = rawurldecode($scopeId);
        $audience = $this->audienceFor($scopeType, $scopeId);
        $corpus = $this->resolver->resolve($scopeType, $scopeId, $audience === 'owner');

        if (!$corpus) {
            return response()->json(['error' => 'Not found'], 404);
        }

        $publicBooks = count(array_filter($corpus->books, fn ($r) => $r->visibility === 'public'))
            + count(array_filter($corpus->encryptedBooks, fn ($r) => $r->visibility === 'public'));

        return response()->json([
            'displayName' => $corpus->displayName,
            'noun' => $corpus->noun(),
            'pageUrl' => $corpus->pageUrl,
            'bibtex' => $this->archiveBibtex($corpus),
            'librarian' => $this->librarianFor($corpus),
            'audience' => $audience,
            'counts' => [
                'public_books' => $publicBooks,
                'export_books' => count($corpus->books),
                'e2ee_skipped' => count($corpus->encryptedBooks),
            ],
        ]);
    }

    /** A run claiming 'building' with no progress write for this long is dead. */
    private const RUN_STALE_AFTER_SECONDS = 300;

    /**
     * GET /api/archive-export/{scopeType}/{scopeId}/status?kind=markdown|sqlite
     * Mirrors the audiobook status contract so the client button state
     * machine ports cleanly: unavailable | buildable | building | ready.
     */
    public function status(Request $request, string $scopeType, string $scopeId)
    {
        $kind = $this->kindOr422($request);
        if (!is_string($kind)) {
            return $kind;
        }

        $scopeId = rawurldecode($scopeId);
        $audience = $this->audienceFor($scopeType, $scopeId);
        $corpus = app(ArchiveCorpusResolver::class)->resolve($scopeType, $scopeId, $audience === 'owner');
        if (!$corpus) {
            return response()->json(['error' => 'Not found'], 404);
        }
        if ($corpus->books === []) {
            return response()->json(['state' => 'unavailable', 'reason' => 'empty']);
        }

        $store = app(ArchiveExportStore::class);
        $digest = $store->digest($corpus, $audience, $kind);
        $path = $store->artifactPath($scopeType, $scopeId, $audience, $kind, $digest);

        if (is_file($path)) {
            return response()->json([
                'state' => 'ready',
                'bytes' => (int) (filesize($path) ?: 0),
                'audience' => $audience,
            ]);
        }

        // The LOCK, not the progress file, is what says "a build is
        // happening": it's taken before dispatch, so it covers the gap
        // between dispatch and the worker's first progress write (build()
        // deletes stale progress before dispatching). And a stale 'building'
        // record from a killed worker must NOT read as building, or the
        // button spins on a corpse forever (BookAudioController parity).
        $progress = $store->readProgress($scopeType, $scopeId, $audience, $kind);
        $probe = Cache::lock(ArchiveExportStore::lockKey($scopeType, $scopeId, $audience, $kind), 1);
        $free = $probe->get();
        if ($free) {
            $probe->release();
        }

        if ((!$free || ($progress['status'] ?? null) === 'building') && !$this->runIsStale($progress)) {
            return response()->json([
                'state' => 'building',
                'progress' => (float) ($progress['progress'] ?? 0),
                'audience' => $audience,
            ]);
        }

        return response()->json([
            'state' => 'buildable',
            'message' => ($progress['status'] ?? null) === 'failed' ? ($progress['message'] ?? null) : null,
            'audience' => $audience,
        ]);
    }

    /**
     * POST /api/archive-export/{scopeType}/{scopeId}/build {kind}
     * Dispatches the packaging job. A second requester joins the build in
     * flight (the per-scope lock); a stale lock from a dead worker is taken
     * over rather than blocking re-presses for the full TTL.
     */
    public function build(Request $request, string $scopeType, string $scopeId)
    {
        $kind = $this->kindOr422($request);
        if (!is_string($kind)) {
            return $kind;
        }

        $scopeId = rawurldecode($scopeId);
        $audience = $this->audienceFor($scopeType, $scopeId);
        $corpus = app(ArchiveCorpusResolver::class)->resolve($scopeType, $scopeId, $audience === 'owner');
        if (!$corpus) {
            return response()->json(['error' => 'Not found'], 404);
        }
        if ($corpus->books === []) {
            return response()->json(['success' => false, 'message' => 'Nothing to export.'], 422);
        }

        $store = app(ArchiveExportStore::class);
        $digest = $store->digest($corpus, $audience, $kind);
        if (is_file($store->artifactPath($scopeType, $scopeId, $audience, $kind, $digest))) {
            return response()->json(['success' => true, 'state' => 'ready']);
        }

        $lock = Cache::lock(ArchiveExportStore::lockKey($scopeType, $scopeId, $audience, $kind), 3900);
        if (!$lock->get()) {
            if (!$this->runIsStale($store->readProgress($scopeType, $scopeId, $audience, $kind))) {
                return response()->json(['success' => true, 'state' => 'building']);
            }
            Log::warning('ArchiveExport: taking over a stale build lock', ['scope' => "{$scopeType}/{$scopeId}", 'kind' => $kind]);
            $lock->forceRelease();
            if (!$lock->get()) {
                return response()->json(['success' => true, 'state' => 'building']);
            }
        }

        // Stamp a FRESH 'building' heartbeat at dispatch (don't just delete the
        // old progress file): if no worker is listening on archive-export, the
        // lock alone would report 'building 0%' for its full TTL with nothing
        // to go stale against — this timestamp lets runIsStale() flip the
        // button back to buildable after RUN_STALE_AFTER_SECONDS, and a
        // re-press takes over the lock.
        try {
            $store->writeProgress($scopeType, $scopeId, $audience, $kind, 'building', 0);
            BuildArchiveExportJob::dispatch($scopeType, $scopeId, $audience, $kind);
        } catch (\Throwable $e) {
            $lock->forceRelease();
            throw $e;
        }

        return response()->json(['success' => true, 'state' => 'building'], 202);
    }

    /**
     * GET /exports/{scopeType}/{scopeId}/{kind} (web route) — serves the
     * cached artifact. Audience and digest are recomputed HERE, so a visitor
     * can never be handed an owner artifact and a stale digest 404s cleanly.
     */
    public function download(string $scopeType, string $scopeId, string $kind)
    {
        if (!in_array($kind, ArchiveExportStore::KINDS, true)) {
            abort(404);
        }

        $scopeId = rawurldecode($scopeId);
        $audience = $this->audienceFor($scopeType, $scopeId);
        $corpus = app(ArchiveCorpusResolver::class)->resolve($scopeType, $scopeId, $audience === 'owner');
        if (!$corpus || $corpus->books === []) {
            abort(404);
        }

        $store = app(ArchiveExportStore::class);
        $digest = $store->digest($corpus, $audience, $kind);
        $path = $store->artifactPath($scopeType, $scopeId, $audience, $kind, $digest);
        if (!is_file($path)) {
            abort(404);
        }

        $clean = trim(preg_replace('/[<>:"\/\\\\|?*\r\n]+/', ' ', $corpus->displayName) ?? '') ?: $scopeId;
        $ext = $kind === 'markdown' ? 'zip' : 'sqlite';

        return response()->download($path, "{$clean} — Hyperlit {$corpus->noun()}.{$ext}");
    }

    private function kindOr422(Request $request)
    {
        $kind = (string) $request->input('kind', $request->query('kind', ''));
        if (!in_array($kind, ArchiveExportStore::KINDS, true)) {
            return response()->json(['error' => 'kind must be markdown or sqlite'], 422);
        }

        return $kind;
    }

    private function runIsStale(?array $progress): bool
    {
        if (!$progress || ($progress['status'] ?? null) !== 'building') {
            return false;
        }
        $updatedAt = $progress['updated_at'] ?? null;
        if (!is_string($updatedAt)) {
            return true; // claims to be running but can't say since when
        }
        try {
            return now()->diffInSeconds(\Carbon\Carbon::parse($updatedAt), true) > self::RUN_STALE_AFTER_SECONDS;
        } catch (\Throwable) {
            return true;
        }
    }

    /**
     * Owner detection without auth middleware (pattern: publicSystemSearch).
     * Journal/archive corpora are public-shelf-derived, so they only ever
     * have a public audience.
     */
    private function audienceFor(string $scopeType, string $scopeId): string
    {
        if ($scopeType !== 'user') {
            return 'public';
        }

        $viewer = Auth::guard('sanctum')->user();

        return ($viewer && $viewer->name === $scopeId) ? 'owner' : 'public';
    }

    /**
     * The panel's Librarian attribution (book source-panel parity): who keeps
     * this collection. citeAuthor already resolves the right name per scope
     * (username / publisher); only a user scope gets a profile link.
     *
     * @return array{label: string, name: string, url: ?string}
     */
    private function librarianFor(ArchiveCorpus $corpus): array
    {
        return match ($corpus->scopeType) {
            'user' => [
                'label' => 'Curated by',
                'name' => $corpus->citeAuthor,
                'url' => '/u/' . rawurlencode($corpus->citeAuthor),
            ],
            'journal' => ['label' => 'Published by', 'name' => $corpus->citeAuthor, 'url' => null],
            default => ['label' => 'Maintained by', 'name' => $corpus->citeAuthor, 'url' => null],
        };
    }

    /**
     * A whole-archive citation. @misc is the honest entry type for a living
     * collection; the key is URL-ish so pasted bibtex stays legible.
     */
    private function archiveBibtex(ArchiveCorpus $corpus): string
    {
        $key = 'hyperlit-' . $corpus->scopeType . '-' . preg_replace('/[^a-zA-Z0-9_-]+/', '-', $corpus->scopeId);
        $title = $corpus->brandedTitle();
        $year = now()->year;

        return "@misc{{$key},\n"
            . "  author = {{$corpus->citeAuthor}},\n"
            . "  title = {{$title}},\n"
            . "  year = {{$year}},\n"
            . "  url = {{$corpus->pageUrl}}\n"
            . '}';
    }
}
