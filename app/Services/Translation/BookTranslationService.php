<?php

namespace App\Services\Translation;

use App\Http\Controllers\UserHomeServerController;
use App\Models\PgLibrary;
use App\Models\User;
use App\Services\E2ee\EncryptedBookGuard;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\File;
use Illuminate\Support\Facades\Log;

/**
 * Whole-book translation into a NEW book: Chinese ↔ English only, on the
 * fixed services.translation.html model (Kimi K3), requester-pays.
 *
 * WHY A COPY, never an in-place rewrite: hyperlights and hypercites address
 * character offsets in the original text, so a translated node can't stand
 * in for it. The copy is a private book owned by whoever asked for it.
 *
 * WHY THE IDS DON'T CHANGE: nodes are unique per (book, startLine) and
 * (book, node_id), footnotes per (book, footnoteId). So the copy keeps every
 * node_id, startLine and footnoteId and only the `book` column moves — the
 * node HTML's data-node-id / footnote anchors stay valid with no rewriting.
 * Hypercite markers (<u id="hypercite_…">) and stray <mark>s ARE unwrapped:
 * their rows aren't copied, so they would point at nothing.
 *
 * The work is resumable: every finished paragraph lands in a cache file under
 * storage/app/book-translations/, so a job that hands off before its timeout
 * (or fails part-way) costs nothing to resume for what it already did.
 */
final class BookTranslationService
{
    /** Target => how the copy's title says so. */
    public const TARGETS = [
        'en' => ' (English)',
        'zh-Hans' => '（中文）',
    ];

    public function __construct(private readonly HtmlTranslator $translator) {}

    /**
     * Which way this book goes: Chinese → English, English → Chinese
     * (Simplified). Null for anything else (another script, or no text) —
     * Chinese ↔ English is all this offers for now.
     *
     * @return array{source: string, target: string}|null
     */
    public function direction(string $book): ?array
    {
        $sample = '';
        $rows = DB::connection('pgsql_admin')->table('nodes')
            ->where('book', $book)->orderBy('startLine')->limit(80)->pluck('content');
        foreach ($rows as $content) {
            $sample .= ' '.strip_tags((string) $content);
            if (mb_strlen($sample) > 20000) {
                break;
            }
        }

        $han = preg_match_all('/\p{Han}/u', $sample);
        $latin = preg_match_all('/\p{Latin}/u', $sample);
        if ($han === 0 && $latin === 0) {
            return null;
        }

        if ($han >= $latin) {
            return ['source' => 'zh-Hans', 'target' => 'en'];
        }

        // Latin script is assumed to be English. Anything else in Latin script
        // still comes out as Chinese — acceptable while this is EN↔ZH only.
        return $latin > $han * 4 ? ['source' => 'en', 'target' => 'zh-Hans'] : null;
    }

    /** Why this book can't be translated at all, or null when it can. */
    public function unavailableReason(string $book): ?string
    {
        if (str_contains($book, '/')) {
            return 'Footnotes and annotations are translated with their book.';
        }
        if (EncryptedBookGuard::isEncrypted($book)) {
            // Its plaintext must never reach the server.
            return 'Encrypted books cannot be translated on the server.';
        }
        if (! DB::connection('pgsql_admin')->table('nodes')->where('book', $book)->exists()) {
            return 'This book has no text to translate.';
        }

        return null;
    }

    /** Characters of text across the book, its footnotes and their sub-books. */
    public function characterCount(string $book): int
    {
        $db = DB::connection('pgsql_admin');
        $count = 0;
        foreach ([
            $db->table('nodes')->where('book', $book)->pluck('content'),
            $db->table('footnotes')->where('book', $book)->pluck('content'),
            $db->table('nodes')->where('book', 'like', $this->likePrefix($book))->pluck('content'),
        ] as $contents) {
            foreach ($contents as $content) {
                $count += mb_strlen(strip_tags((string) $content));
            }
        }

        return $count;
    }

    /**
     * Raw (pre-tier-multiplier) cost estimate for the reservation and the
     * confirm dialog: a rate per source character PLUS a fixed cost per
     * request. A flat per-character rate under-quoted short books by half —
     * every request pays for Kimi K3's reasoning and a resent prompt however
     * little text it carries, and that dominates a short book.
     *
     * Requests ≈ one per section (each chapter's last batch is partial) plus
     * one per full batch of text. Deliberately errs high: a reservation that
     * holds a little too much is released; a quote that's too low is a broken
     * promise.
     *
     * @return array{characters: int, cost: float}
     */
    public function estimate(string $book, string $target): array
    {
        $characters = $this->characterCount($book);
        $config = config('services.translation.html.estimate');
        $perChar = (float) ($config['per_million_chars'][$target] ?? max($config['per_million_chars'])) / 1_000_000;

        $requests = $this->sectionCount($book) + intdiv($characters, max(1, (int) config('services.translation.html.batch_chars', 4000)));

        return [
            'characters' => $characters,
            'cost' => round($characters * $perChar + $requests * (float) $config['per_request'], 4),
        ];
    }

    /** Sections the translator will make: one per h1–h3 heading node, plus one for the footnotes. */
    private function sectionCount(string $book): int
    {
        $db = DB::connection('pgsql_admin');
        $headings = $db->table('nodes')->where('book', $book)
            ->whereRaw("ltrim(content) ~* '^<h[1-3][ >]'")->count();
        $notes = $db->table('footnotes')->where('book', $book)->exists() ? 1 : 0;

        return max(1, $headings) + $notes;
    }

    /** The requester's existing translation of this book into $target, if any. */
    public function existingCopy(string $book, User $user, string $target): ?object
    {
        return DB::connection('pgsql_admin')->table('library')
            ->where('creator', $user->name)
            ->whereRaw("raw_json->>'translated_from' = ?", [$book])
            ->whereRaw("raw_json->>'translation_target' = ?", [$target])
            ->orderByDesc('created_at')
            ->first(['book', 'title']);
    }

    public static function lockKey(string $book, string $target, int $userId): string
    {
        return "book-translation:{$book}:{$target}:{$userId}";
    }

    /** @return array<string, mixed>|null */
    public function readProgress(string $book, string $target, int $userId): ?array
    {
        $path = $this->dir($book, $target, $userId).'/progress.json';
        if (! is_file($path)) {
            return null;
        }
        $decoded = json_decode((string) file_get_contents($path), true);

        return is_array($decoded) ? $decoded : null;
    }

    /** Merge $fields into the progress file, stamping updated_at (the heartbeat). */
    public function writeProgress(string $book, string $target, int $userId, array $fields): array
    {
        $dir = $this->dir($book, $target, $userId);
        File::ensureDirectoryExists($dir, 0755);
        $progress = array_merge($this->readProgress($book, $target, $userId) ?? [], $fields, [
            'updated_at' => now()->toIso8601String(),
        ]);
        File::put("{$dir}/progress.json", json_encode($progress, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE));

        return $progress;
    }

    /**
     * Translate the book and, once every paragraph is done, write the copy.
     *
     * @param  (callable(array $progress): void)|null  $onProgress  overall percent as work lands
     * @return array{status: 'done', book: string}|array{status: 'continue'}|array{status: 'failed', message: string}
     */
    public function run(string $book, string $target, User $user, ?float $deadline = null, ?callable $onProgress = null): array
    {
        $source = $target === 'en' ? 'zh-Hans' : 'en';
        $db = DB::connection('pgsql_admin');
        $library = $db->table('library')->where('book', $book)->first();
        if (! $library) {
            return ['status' => 'failed', 'message' => 'The book no longer exists.'];
        }

        $nodes = $db->table('nodes')->where('book', $book)->orderBy('startLine')->get();
        $footnotes = $db->table('footnotes')->where('book', $book)->get();
        $subNodes = $db->table('nodes')->where('book', 'like', $this->likePrefix($book))
            ->orderBy('book')->orderBy('startLine')->get();

        $cache = $this->dir($book, $target, $user->id).'/cache.json';
        $about = trim('the book "'.$library->title.'"'.($library->author ? ' by '.$library->author : ''));

        // Pass 1, the text: one document, so chapters become sections and
        // context runs across node boundaries.
        $body = $this->translator->translateFragments(
            $nodes->mapWithKeys(fn ($n, $i) => [$i => (string) $n->content])->all(),
            $target, $source, about: $about, cachePath: $cache, deadline: $deadline,
            onProgress: $this->percentReporter($onProgress, 'text'),
        );
        if ($body->pending > 0) {
            return ['status' => 'continue'];
        }

        // Pass 2, the notes: footnote bodies and their sub-books' nodes.
        $notes = [];
        foreach ($footnotes as $i => $f) {
            $notes["fn{$i}"] = (string) $f->content;
        }
        foreach ($subNodes as $i => $n) {
            $notes["sub{$i}"] = (string) $n->content;
        }
        $notesResult = $notes === [] ? null : $this->translator->translateFragments(
            $notes, $target, $source, about: $about, cachePath: $cache, deadline: $deadline,
            onProgress: $this->percentReporter($onProgress, 'notes'),
        );
        if ($notesResult !== null && $notesResult->pending > 0) {
            return ['status' => 'continue'];
        }

        $failed = $body->failed + ($notesResult->failed ?? 0);
        if ($failed > 0) {
            return [
                'status' => 'failed',
                'message' => "{$failed} paragraph(s) could not be translated. Press Translate again to retry — you won't be charged twice for what's already done.",
            ];
        }

        $copy = $this->writeCopy(
            $library, $user, $target, $nodes, $body->fragments,
            $footnotes, $subNodes, $notesResult?->fragments ?? [],
        );
        File::delete($cache); // the copy holds the translation now

        return ['status' => 'done', 'book' => $copy];
    }

    /**
     * Raw cost of the tokens LlmService recorded (BillingService::charge
     * applies the tier multiplier). Same pricing table as every AI feature.
     */
    public static function costOf(array $usage): float
    {
        $pricing = config('services.llm.pricing');
        $total = 0.0;
        foreach ($usage['by_model'] ?? [] as $model => $tokens) {
            $rate = $pricing[$model] ?? null;
            if (! $rate) {
                Log::warning('BookTranslation: no pricing entry for model — usage uncounted', ['model' => $model]);

                continue;
            }
            $total += ($tokens['prompt_tokens'] / 1_000_000) * $rate['input'];
            $total += ($tokens['completion_tokens'] / 1_000_000) * $rate['output'];
        }

        return $total;
    }

    /** Wraps a progress callback so the job sees one 0–1 figure per pass. */
    private function percentReporter(?callable $onProgress, string $phase): ?callable
    {
        if ($onProgress === null) {
            return null;
        }

        return function (array $event) use ($onProgress, $phase) {
            if ($event['type'] !== 'batch') {
                return;
            }
            $onProgress([
                'phase' => $phase,
                'percent' => $event['total'] > 0 ? min(1, $event['done'] / $event['total']) : 1,
            ]);
        };
    }

    /**
     * Write the translated copy in one transaction and put it on the owner's
     * library page. Returns the new book id.
     */
    private function writeCopy(
        object $library,
        User $user,
        string $target,
        $nodes,
        array $translatedNodes,
        $footnotes,
        $subNodes,
        array $translatedNotes,
    ): string {
        $db = DB::connection('pgsql_admin');
        $now = now();
        $newBook = 'book_'.(int) floor(microtime(true) * 1000);
        while ($db->table('library')->where('book', $newBook)->exists()) {
            $newBook = 'book_'.((int) substr($newBook, 5) + 1);
        }
        $title = mb_substr(($library->title ?: 'Untitled').self::TARGETS[$target], 0, 255);

        $row = (array) $library;
        foreach (['search_vector', 'slug', 'openalex_id', 'open_library_key', 'doi', 'access_granted',
            'wrapped_dek', 'last_sync_token', 'gate_defaults', 'page_settings', 'canonical_source_id',
            'canonical_match_score', 'canonical_match_method', 'canonical_matched_at', 'canonical_matched_by',
            'canonical_metadata_score', 'is_publisher_uploaded', 'human_reviewed_at'] as $dropped) {
            unset($row[$dropped]); // identity, sharing, matching and search state belong to the original
        }
        $row = array_merge($row, [
            'book' => $newBook,
            'title' => $title,
            'language' => $target,
            'creator' => $user->name,
            'creator_token' => $user->user_token,
            'visibility' => 'private',
            'listed' => false,
            'has_nodes' => true,
            'encrypted' => false,
            'timestamp' => (int) floor(microtime(true) * 1000),
            'total_views' => 0,
            'total_citations' => 0,
            'total_highlights' => 0,
            'total_likes' => 0,
            'hypercite_connections' => 0,
            'reference_connections' => 0,
            'created_at' => $now,
            'updated_at' => $now,
        ]);
        $raw = json_decode((string) ($library->raw_json ?? '{}'), true) ?: [];
        $row['raw_json'] = json_encode(array_merge($raw, [
            'book' => $newBook,
            'title' => $title,
            'creator' => $user->name,
            'visibility' => 'private',
            'translated_from' => $library->book,
            'translation_target' => $target,
            'translation_model' => config('services.translation.html.model'),
        ]), JSON_UNESCAPED_UNICODE);

        $db->transaction(function () use ($db, $row, $newBook, $library, $nodes, $translatedNodes, $footnotes, $subNodes, $translatedNotes, $now) {
            $db->table('library')->insert($row);

            foreach (array_chunk($nodes->all(), 500, true) as $chunk) {
                $db->table('nodes')->insert(array_map(
                    fn ($n, $i) => $this->nodeRow($n, $newBook, $translatedNodes[$i] ?? $n->content, $now),
                    $chunk, array_keys($chunk),
                ));
            }

            // Sub-book ids are "<book>/<footnote>": move them under the copy.
            $prefix = $library->book.'/';
            $subBook = fn (?string $id) => $id !== null && str_starts_with($id, $prefix)
                ? $newBook.'/'.substr($id, strlen($prefix))
                : $id;

            $copiedSubNodes = [];
            foreach ($subNodes as $i => $n) {
                $copiedSubNodes[] = $this->nodeRow($n, $subBook($n->book), $translatedNotes["sub{$i}"] ?? $n->content, $now);
            }
            foreach (array_chunk($copiedSubNodes, 500) as $chunk) {
                $db->table('nodes')->insert($chunk);
            }

            foreach ($footnotes as $i => $f) {
                $copy = (array) $f;
                $copy['book'] = $newBook;
                $copy['sub_book_id'] = $subBook($f->sub_book_id);
                $copy['content'] = $translatedNotes["fn{$i}"] ?? $f->content;
                $copy['preview_nodes'] = $f->preview_nodes === null ? null : json_encode($this->previewNodes($copiedSubNodes, $copy['sub_book_id']));
                $copy['created_at'] = $now;
                $copy['updated_at'] = $now;
                $db->table('footnotes')->insert($copy);
            }

            // References are copied untranslated, so in-text citations resolve.
            foreach ($db->table('bibliography')->where('book', $library->book)->get() as $ref) {
                $db->table('bibliography')->insert(array_merge((array) $ref, [
                    'book' => $newBook, 'created_at' => $now, 'updated_at' => $now,
                ]));
            }
        });

        try {
            $copy = PgLibrary::on('pgsql_admin')->where('book', $newBook)->first();
            if ($copy) {
                app(UserHomeServerController::class)->updateBookOnUserPage($user->name, $copy);
            }
        } catch (\Throwable $e) {
            Log::warning('BookTranslation: homepage sync failed', ['book' => $newBook, 'error' => $e->getMessage()]);
        }

        return $newBook;
    }

    private function nodeRow(object $node, string $book, string $content, $now): array
    {
        $row = (array) $node;
        unset($row['id'], $row['sys_period'], $row['embedding']);
        $content = $this->unwrapOrphans($content);

        return array_merge($row, [
            'book' => $book,
            'content' => $content,
            'plainText' => EncryptedBookGuard::plainTextFor($book, $content),
            'created_at' => $now,
            'updated_at' => $now,
        ]);
    }

    /** Same shape BackendHighlightService builds: the first five sub-book nodes. */
    private function previewNodes(array $subNodes, ?string $subBookId): array
    {
        $own = array_values(array_filter($subNodes, fn ($n) => $n['book'] === $subBookId));
        usort($own, fn ($a, $b) => $a['startLine'] <=> $b['startLine']);

        return array_map(fn ($n) => [
            'book' => $n['book'],
            'chunk_id' => (int) $n['chunk_id'],
            'startLine' => (float) $n['startLine'],
            'node_id' => $n['node_id'],
            'content' => $n['content'],
            'footnotes' => json_decode($n['footnotes'] ?? '[]', true),
            'hyperlights' => [],
            'hypercites' => [],
        ], array_slice($own, 0, 5));
    }

    /**
     * Unwrap hypercite markers and highlight marks, keeping their text: the
     * rows that give them meaning belong to the original book.
     */
    private function unwrapOrphans(string $html): string
    {
        if (! str_contains($html, 'hypercite_') && ! str_contains($html, '<mark')) {
            return $html;
        }

        $dom = new \DOMDocument('1.0', 'UTF-8');
        $prev = libxml_use_internal_errors(true);
        $loaded = $dom->loadHTML(
            '<?xml encoding="utf-8"?><div data-unwrap-root="1">'.$html.'</div>',
            LIBXML_HTML_NOIMPLIED | LIBXML_HTML_NODEFDTD | LIBXML_NONET
        );
        libxml_clear_errors();
        libxml_use_internal_errors($prev);
        $root = $loaded ? $dom->getElementsByTagName('div')->item(0) : null;
        if (! $root) {
            return $html;
        }

        $xpath = new \DOMXPath($dom);
        foreach (iterator_to_array($xpath->query('//u[starts-with(@id, "hypercite_")] | //mark') ?: []) as $el) {
            while ($el->firstChild) {
                $el->parentNode->insertBefore($el->firstChild, $el);
            }
            $el->parentNode->removeChild($el);
        }

        $out = '';
        foreach (iterator_to_array($root->childNodes) as $child) {
            $out .= $dom->saveHTML($child);
        }

        return $out;
    }

    private function dir(string $book, string $target, int $userId): string
    {
        $safe = preg_replace('/[^A-Za-z0-9_-]/', '_', "{$book}--{$target}--{$userId}");

        return storage_path("app/book-translations/{$safe}");
    }

    private function likePrefix(string $book): string
    {
        return str_replace(['\\', '%', '_'], ['\\\\', '\\%', '\\_'], $book).'/%';
    }
}
