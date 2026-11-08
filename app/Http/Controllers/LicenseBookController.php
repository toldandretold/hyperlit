<?php

namespace App\Http\Controllers;

use App\Mcp\Support\BookContentWriter;
use App\Mcp\Support\InternalCall;
use App\Services\DocumentImport\FileHelpers;
use App\Services\Publishing\PublishGate;
use App\Support\Licenses;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;

/**
 * A custom licence is a BOOK owned by the work's creator — the /license2025content pattern:
 * readers get a real page they can open, cite and highlight, and the owner reuses the same
 * licence across all their works instead of retyping terms into a hidden tooltip.
 *
 * A work points at it via library.license_book, pinned to library.license_book_at (the moment
 * those terms were applied); if the licence book is edited later, readers of the earlier work
 * are sent to /{licenceBook}/timemachine?at=<pin> — the terms it was actually published under.
 *
 * Logged-in only: a licence book must be PUBLIC (readers have to open it), and anonymous
 * actors can never publish (PublishGate).
 */
class LicenseBookController extends Controller
{
    /** Max works a re-apply touches — one user's catalogue, not a fan-out. */
    private const REAPPLY_LIMIT = 5000;

    /**
     * GET /api/license-books — the picker's data: licences this user already uses, plus their
     * other public books that could serve as one.
     */
    public function index(Request $request): JsonResponse
    {
        $user = $request->user();

        $used = DB::table('library as w')
            ->join('library as l', 'l.book', '=', 'w.license_book')
            ->where('w.creator', $user->name)
            ->whereNotNull('w.license_book')
            ->where('l.creator', $user->name)
            ->groupBy('l.book', 'l.title', 'l.slug')
            ->orderByRaw('count(*) desc')
            ->limit(50)
            ->get(['l.book', 'l.title', 'l.slug', DB::raw('count(*) as uses')]);

        $candidates = DB::table('library')
            ->where('creator', $user->name)
            ->where('visibility', 'public')
            ->where(fn ($q) => $q->whereNull('encrypted')->orWhere('encrypted', false))
            ->where('has_nodes', true)
            ->where('book', 'not like', '%/%') // never a sub-book (annotation / footnote)
            ->whereNotIn('book', $used->pluck('book'))
            ->orderByDesc('updated_at')
            ->limit(50)
            ->get(['book', 'title', 'slug']);

        return response()->json(['success' => true, 'used' => $used, 'candidates' => $candidates]);
    }

    /**
     * POST /api/license-books {title, text} — mint a public licence book from typed terms.
     * Each blank-line-separated paragraph becomes one node, under an <h1> of the title.
     */
    public function store(Request $request): JsonResponse
    {
        $validated = $request->validate([
            'title' => 'required|string|max:200',
            'text' => 'required|string|max:50000',
        ]);
        $user = $request->user();

        $perm = PublishGate::check($user);
        if (! $perm['allowed']) {
            return response()->json([
                'success' => false,
                'reason' => $perm['reason'],
                'message' => 'A custom licence has to be a public page, and your account cannot publish yet'
                    . ($perm['reason'] === 'unverified_email' ? ' — verify your email first.' : '.'),
            ], 403);
        }

        $bookId = 'book_' . (int) round(microtime(true) * 1000);
        $now = (int) round(microtime(true) * 1000);

        $create = InternalCall::call(DbLibraryController::class, 'bulkCreate', ['data' => [
            'book' => $bookId,
            'title' => $validated['title'],
            'author' => $user->name,
            'type' => 'misc',
            'visibility' => 'public',
            'timestamp' => $now,
            // The licence text itself is freely reusable; a licence that can't be copied
            // can't be adopted by anyone else.
            'license' => 'CC0',
        ]], $user);
        if (($create['json']['success'] ?? false) !== true) {
            return response()->json(['success' => false, 'message' => 'Could not create the licence page.'], 500);
        }

        $helpers = app(FileHelpers::class);
        $blocks = ['<h1>' . e($validated['title']) . '</h1>'];
        foreach (preg_split('/\R\s*\R/', trim($validated['text'])) as $para) {
            $para = trim($para);
            if ($para !== '') {
                $blocks[] = '<p>' . nl2br(e($para), false) . '</p>';
            }
        }

        $items = [];
        $line = 100;
        foreach ($blocks as $block) {
            $nodeId = $helpers->generateNodeId($bookId);
            preg_match('/^<([a-z0-9]+)/i', $block, $m);
            $items[] = [
                'book' => $bookId,
                'node_id' => $nodeId,
                'startLine' => $line,
                'chunk_id' => 0,
                'content' => $helpers->ensureNodeIdInContent($block, $line, $nodeId),
                'footnotes' => [],
                'type' => strtolower($m[1]),
            ];
            $line += 100;
        }

        $write = BookContentWriter::sync($user, $bookId, $items);
        if (! $write['ok']) {
            return response()->json(['success' => false, 'message' => $write['error']], 500);
        }
        DB::table('library')->where('book', $bookId)->update(['has_nodes' => true]);

        return response()->json([
            'success' => true,
            'book' => $bookId,
            'title' => $validated['title'],
            'url' => '/' . $bookId,
        ]);
    }

    /**
     * GET /api/license-books/{book}/info — PUBLIC: what a reader's licence line needs about a
     * licence book (title, URL, when its terms last changed). Only for public books: a private
     * or encrypted licence book reads as absent and the work falls back to its snapshot text.
     */
    public function info(string $book): JsonResponse
    {
        $row = DB::connection('pgsql_admin')->table('library')
            ->where('book', $book)
            ->first(['book', 'title', 'slug', 'visibility', 'encrypted', 'timestamp']);
        if (! $row || $row->visibility !== 'public' || $row->encrypted) {
            return response()->json(['success' => false, 'available' => false]);
        }

        return response()->json([
            'success' => true,
            'available' => true,
            'book' => $row->book,
            'title' => $row->title,
            'url' => '/' . ($row->slug ?: $row->book),
            'timemachine_base' => '/' . $row->book . '/timemachine',
            'changed_at' => $row->timestamp !== null ? (int) $row->timestamp : null,
        ]);
    }

    /**
     * GET /api/license-books/{book}/usage — how many of the owner's works use this licence
     * book, and how many are pinned to terms OLDER than its latest edit. Drives the deletion
     * warning and the "re-apply to all" banner.
     */
    public function usage(Request $request, string $book): JsonResponse
    {
        $user = $request->user();
        if (! $this->owns($user->name, $book)) {
            return response()->json(['success' => false, 'message' => 'Not your book.'], 403);
        }

        $changedAt = self::lastChangedAt($book);
        $works = DB::table('library')
            ->where('creator', $user->name)
            ->where('license_book', $book)
            ->selectRaw('count(*) as total, count(*) filter (where license_book_at < ?) as outdated', [$changedAt ?? 0])
            ->first();

        return response()->json([
            'success' => true,
            'total' => (int) ($works->total ?? 0),
            'outdated' => (int) ($works->outdated ?? 0),
            'changed_at' => $changedAt,
        ]);
    }

    /**
     * POST /api/license-books/{book}/reapply — move every one of the OWNER's works using this
     * licence book onto its current terms. Never touches anyone else's rows.
     */
    public function reapply(Request $request, string $book): JsonResponse
    {
        $user = $request->user();
        if (! $this->owns($user->name, $book)) {
            return response()->json(['success' => false, 'message' => 'Not your book.'], 403);
        }

        $now = (int) round(microtime(true) * 1000);
        $ids = DB::table('library')
            ->where('creator', $user->name)
            ->where('license_book', $book)
            ->limit(self::REAPPLY_LIMIT)
            ->pluck('book');
        // Bump each work's content clock too: `timestamp` is the freshness signal every client
        // compares against its IndexedDB copy (and BookCache against its prerender) — moving
        // only license_book_at left open readers showing the OLD pinned link (licenses.spec).
        $updated = DB::table('library')->whereIn('book', $ids)->update(['license_book_at' => $now, 'timestamp' => $now]);
        foreach ($ids as $id) {
            try {
                app(\App\Services\BookCache::class)->invalidate($id);
            } catch (\Throwable) {
                // best effort — a stale cache self-corrects on the timestamp check
            }
        }

        return response()->json(['success' => true, 'updated' => $updated, 'license_book_at' => $now]);
    }

    /**
     * When a licence book's terms last changed (ms): its library content clock, which every
     * node sync — including deletions — advances. A metadata-only edit also moves it, which at
     * worst sends a reader to a time-machine view showing the same words: a safe false positive.
     */
    public static function lastChangedAt(string $book): ?int
    {
        $ts = DB::connection('pgsql_admin')->table('library')->where('book', $book)->value('timestamp');

        return $ts !== null ? (int) $ts : null;
    }

    private function owns(string $name, string $book): bool
    {
        return DB::table('library')->where('book', $book)->where('creator', $name)->exists();
    }
}
