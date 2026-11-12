<?php

namespace App\Services\Archives;

use Illuminate\Support\Facades\DB;

/**
 * An owner-minted archive's About BOOK — `shelf_about_{shelfId}`, a real book
 * rendered inline in the /a/{slug} hero and edited in place with the full
 * editToolbar/divEditor stack (the user page's `{u}About` pattern, see
 * UserHomeServerController::ensureAboutBook + userAboutBook.ts).
 *
 * The id is deliberately under the `shelf_` prefix: every "real books" query
 * (user library feeds, licence discovery, archive corpora) already excludes
 * `shelf_%` as parts-of-a-page, so the About never shows up as a work. It does
 * NOT match the shelf-render patterns — ShelfCacheInvalidator's
 * `shelf_{id}_%` and the client's SHELF_FEED_RE `^shelf_{uuid}_` both need the
 * uuid straight after `shelf_` — so render flushes never wipe it.
 *
 * Minted lazily on the OWNER's visit to a PUBLIC shelf's archive page, seeded
 * from the shelf description (which was public already). Deleted with the shelf.
 */
class ArchiveAboutBook
{
    public const PREFIX = 'shelf_about_';

    public static function bookId(string $shelfId): string
    {
        return self::PREFIX . $shelfId;
    }

    private function db()
    {
        return DB::connection('pgsql_admin');
    }

    /** Create the library row + seed nodes if absent. Idempotent and race-safe. */
    public function ensure(object $shelf): string
    {
        $book = self::bookId($shelf->id);
        if ($this->db()->table('library')->where('book', $book)->exists()) {
            return $book;
        }

        $now = now();
        $inserted = $this->db()->table('library')->insertOrIgnore([
            'book' => $book,
            'title' => ($shelf->name ?? 'Archive') . ' — about',
            'author' => null,
            'creator' => $shelf->creator,
            'creator_token' => null,
            'visibility' => 'public',
            'listed' => false,
            'raw_json' => json_encode(['type' => 'archive_about', 'shelf_id' => $shelf->id]),
            'timestamp' => (int) round(microtime(true) * 1000),
            'created_at' => $now,
            'updated_at' => $now,
        ]);
        if ($inserted === 0) {
            return $book; // a concurrent request minted it
        }

        // Seed: the shelf description's paragraphs (plain text → escaped <p>),
        // else one empty paragraph (the editor's expected empty-book shape).
        $paras = array_values(array_filter(array_map('trim',
            preg_split('/\R{2,}/', (string) ($shelf->description ?? '')))));
        $blocks = $paras
            ? array_map(fn ($p) => '<p>' . nl2br(e($p), false) . '</p>', $paras)
            : ['<p><br></p>'];

        $rows = [];
        foreach ($blocks as $i => $html) {
            $rows[] = [
                'book' => $book,
                'chunk_id' => 0,
                'startLine' => $i + 1,
                'node_id' => $book . '_' . ((int) round(microtime(true) * 1000)) . '_' . bin2hex(random_bytes(3)),
                'footnotes' => null,
                'content' => $html,
                'plainText' => trim(strip_tags(str_replace('<br>', "\n", $html))),
                'type' => 'p',
                'created_at' => $now,
                'updated_at' => $now,
            ];
        }
        $this->db()->table('nodes')->insert($rows);

        return $book;
    }

    /** @return array<int, object{startLine: mixed, node_id: string, content: string}> */
    public function nodes(string $shelfId): array
    {
        return $this->db()->table('nodes')
            ->where('book', self::bookId($shelfId))
            ->orderBy('startLine')
            ->get(['startLine', 'node_id', 'content'])
            ->all();
    }

    /** Does the book say anything (text, or an image/embed)? */
    public static function hasContent(array $nodes): bool
    {
        foreach ($nodes as $n) {
            $html = (string) $n->content;
            if (trim(html_entity_decode(strip_tags($html))) !== '' || preg_match('/<(img|iframe|video|svg|figure)\b/i', $html)) {
                return true;
            }
        }

        return false;
    }

    /**
     * The archive page's customization (logo/background image, background art,
     * show_map) — the user page's page_settings vocabulary, stored on the About
     * book's library row (its media store holds the uploaded images, so
     * `/{aboutBook}/media/{file}` serves them like any book's).
     */
    public function settings(string $shelfId): array
    {
        $raw = $this->db()->table('library')->where('book', self::bookId($shelfId))->value('page_settings');

        return $raw ? (json_decode($raw, true) ?: []) : [];
    }

    /** Merge a validated patch (explicit null clears a key). @return array the stored settings */
    public function saveSettings(string $shelfId, array $patch): array
    {
        $merged = array_filter(array_merge($this->settings($shelfId), $patch), fn ($v) => $v !== null);
        $this->db()->table('library')->where('book', self::bookId($shelfId))->update([
            'page_settings' => $merged ? json_encode($merged) : null,
            'updated_at' => now(),
        ]);

        return $merged;
    }

    public function delete(string $shelfId): void
    {
        $book = self::bookId($shelfId);
        $this->db()->table('nodes')->where('book', $book)->delete();
        $this->db()->table('library')->where('book', $book)->delete();
    }
}
