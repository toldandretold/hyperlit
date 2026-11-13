<?php

namespace App\Console\Commands;

use App\Services\CanonicalVersions\AutoVersionResolver;
use Illuminate\Console\Command;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Hash;
use Illuminate\Support\Str;

/**
 * Seed (and RESET) the fixture the shelf-owner hypercite workbench e2e spec drives
 * (tests/e2e/specs/workflows/shelf-hypercite-workbench.spec.js).
 *
 * It needs its OWN user, and that user must NOT be an admin: the whole point of the spec is
 * that an ordinary shelf owner gets the workbench at /a/{slug}/hypercites while
 * /maintainer/* stays a 404 for them. The shared e2e user cannot play that part —
 * e2e:seed-hypercite-console permanently promotes it to admin. So this command owns a
 * dedicated account and re-asserts `is_admin = false` on every run.
 *
 * The fixture: a public shelf with an archive page, holding
 *   - the owner's own book, which quotes a commons work  → a candidate they MAY approve;
 *   - a commons book quoting the same work                → a candidate shown view-only.
 * Both candidates are `matched`, shaped exactly as CandidateDetector writes them.
 *
 * Idempotent, and destructive only toward its own fixtures: every run wipes the previous
 * run's hypercites / candidates and restores the node content, so a spec that died
 * mid-approve cannot poison the next run.
 */
class SeedE2eShelfWorkbench extends Command
{
    protected $signature = 'e2e:seed-shelf-workbench';

    protected $description = 'Seed the non-admin owner + shelf + candidates for the shelf hypercite workbench e2e spec (idempotent)';

    public const EMAIL = 'e2e-shelf-owner@hyperlit.test';
    public const PASSWORD = 'e2e-shelf-owner-password';
    public const USERNAME = 'e2eshelfowner';

    public const SHELF_NAME = 'E2E Workbench Shelf';
    public const ARCHIVE_SLUG = 'e2e-workbench-shelf';

    public const OWN_BOOK = 'book_e2e_swb_own';
    public const COMMONS_CITING_BOOK = 'book_e2e_swb_commons_citing';
    public const CITED_BOOK = 'book_e2e_swb_cited';

    public const QUOTE = 'a shelf is a small library and its keeper is a librarian in everything but name';

    public function handle(): int
    {
        $db = DB::connection('pgsql_admin');

        // ── The owner: a real, verified, NON-admin account ──
        $user = $db->table('users')->where('email', self::EMAIL)->first();
        if (! $user) {
            $db->table('users')->insert([
                'name'              => self::USERNAME,
                'email'             => self::EMAIL,
                'email_verified_at' => now(),
                'password'          => Hash::make(self::PASSWORD),
                'user_token'        => (string) Str::uuid(),
                'created_at'        => now(),
                'updated_at'        => now(),
            ]);
            $user = $db->table('users')->where('email', self::EMAIL)->first();
        }
        $db->table('users')->where('id', $user->id)->update([
            'is_admin'          => false,                       // the spec depends on it
            'password'          => Hash::make(self::PASSWORD),
            'email_verified_at' => $user->email_verified_at ?? now(),
        ]);

        // ── Wipe the previous run's artifacts ──
        $books = [self::OWN_BOOK, self::COMMONS_CITING_BOOK, self::CITED_BOOK];
        $db->table('hypercite_candidates')->whereIn('citing_book', $books)->delete();
        $db->table('hypercites')->where('book', self::CITED_BOOK)->delete();
        $db->table('nodes')->whereIn('book', $books)->delete();
        $db->table('bibliography')->whereIn('book', $books)->delete();

        // ── Shelf + archive page ──
        $shelfId = $db->table('shelves')->where('creator', $user->name)->where('name', self::SHELF_NAME)->value('id');
        if (! $shelfId) {
            $shelfId = (string) Str::uuid();
            $db->table('shelves')->insert([
                'id'           => $shelfId,
                'creator'      => $user->name,
                'name'         => self::SHELF_NAME,
                'slug'         => self::ARCHIVE_SLUG,
                'description'  => 'Fixture shelf for the shelf-owner hypercite workbench e2e spec.',
                'visibility'   => 'public',
                'default_sort' => 'recent',
                'created_at'   => now(),
                'updated_at'   => now(),
            ]);
        }
        $db->table('shelves')->where('id', $shelfId)->update(['visibility' => 'public']);
        $db->table('hypercite_runs')->where('shelf_id', $shelfId)->delete();
        if (! $db->table('archive_sources')->where('shelf_id', $shelfId)->exists()) {
            $db->table('archive_sources')->insert([
                'shelf_id' => $shelfId, 'slug' => self::ARCHIVE_SLUG, 'display_name' => null,
                'created_at' => now(), 'updated_at' => now(),
            ]);
        }

        // ── Books ──
        $system = AutoVersionResolver::CREATOR;
        $citedCanonical = $this->book($db, self::CITED_BOOK, 'E2E Workbench Cited Work', $system, null, true);
        $ownCanonical = $this->book($db, self::OWN_BOOK, 'E2E Workbench — My Essay', $user->name, $user->user_token, false);
        $commonsCanonical = $this->book($db, self::COMMONS_CITING_BOOK, 'E2E Workbench Commons Article', $system, null, true);

        foreach ($books as $book) {
            $db->table('shelf_items')->updateOrInsert(
                ['shelf_id' => $shelfId, 'book' => $book],
                ['added_at' => now()],
            );
        }

        // ── Content + candidates ──
        $quote = self::QUOTE;
        $citedNode = self::CITED_BOOK . '_n5';
        $citedHtml = '<p id="5" data-node-id="' . $citedNode . '">It is often said that '
            . $quote . ', and the tools should follow.</p>';
        $this->node($db, self::CITED_BOOK, $citedNode, 5, $citedHtml);

        foreach ([[self::OWN_BOOK, $ownCanonical, 'My essay argues'], [self::COMMONS_CITING_BOOK, $commonsCanonical, 'The article notes']] as [$book, $canonical, $lead]) {
            $nodeId = $book . '_n1';
            $html = '<p id="1" data-node-id="' . $nodeId . '">' . $lead . ' that "' . $quote
                . '" (<a href="#keeper2024" class="in-text-citation">Keeper, 2024</a>: 12). It follows from there.</p>';
            $this->node($db, $book, $nodeId, 1, $html);
            $db->table('bibliography')->insert([
                'book' => $book, 'referenceId' => 'keeper2024',
                'content' => 'Keeper, A. (2024) E2E Workbench Cited Work.',
                'canonical_source_id' => $citedCanonical, 'match_method' => 'doi',
                'created_at' => now(), 'updated_at' => now(),
            ]);

            $plain = html_entity_decode(strip_tags($html), ENT_QUOTES | ENT_HTML5, 'UTF-8');
            $plainCited = html_entity_decode(strip_tags($citedHtml), ENT_QUOTES | ENT_HTML5, 'UTF-8');
            $marker = mb_strlen(html_entity_decode(
                strip_tags(substr($html, 0, (int) strpos($html, '<a href="#keeper2024"'))),
                ENT_QUOTES | ENT_HTML5,
                'UTF-8'
            ));
            $charStart = mb_strpos($plainCited, $quote);

            $db->table('hypercite_candidates')->insert([
                'id'                         => (string) Str::uuid(),
                'shelf_id'                   => $shelfId,
                'citing_canonical_source_id' => $canonical,
                'cited_canonical_source_id'  => $citedCanonical,
                'citing_book'                => $book,
                'cited_book'                 => self::CITED_BOOK,
                'is_internal'                => true,
                'reference_id'               => 'keeper2024',
                'occurrence_index'           => 0,
                'citing_node_id'             => $nodeId,
                'marker_offset'              => $marker,
                'claim_start'                => 0,
                'claim_end'                  => mb_strlen($plain),
                'has_quote'                  => true,
                'quote_kind'                 => 'inline',
                'quote_text'                 => $quote,
                'quote_node_id'              => $nodeId,
                'citing_content_hash'        => sha1($html),
                'match_node_ids'             => json_encode([$citedNode]),
                'match_char_data'            => json_encode([
                    $citedNode => ['charStart' => $charStart, 'charEnd' => $charStart + mb_strlen($quote)],
                ]),
                'match_method'               => 'exact',
                'match_score'                => 1.0,
                'match_occurrences'          => 1,
                'cited_content_hash'         => sha1($citedHtml),
                'status'                     => 'matched',
                'created_at'                 => now(),
                'updated_at'                 => now(),
            ]);
        }

        $this->info('Seeded /a/' . self::ARCHIVE_SLUG . '/hypercites for ' . self::EMAIL
            . ' (non-admin): 1 approvable candidate (own book) + 1 view-only (commons book).');

        return self::SUCCESS;
    }

    /** Upsert a held public book (+ a canonical when $withCanonical); returns the canonical id or null. */
    private function book($db, string $book, string $title, string $creator, ?string $creatorToken, bool $withCanonical): ?string
    {
        $canonicalId = $db->table('library')->where('book', $book)->value('canonical_source_id');
        if ($withCanonical && ! $canonicalId) {
            $canonicalId = (string) Str::uuid();
            $db->table('canonical_source')->insert([
                'id' => $canonicalId, 'title' => $title, 'is_oa' => true, 'auto_version_book' => $book,
                'created_at' => now(), 'updated_at' => now(),
            ]);
        }

        $row = [
            'title'               => $title,
            'author'              => 'E2E Fixtures',
            'creator'             => $creator,
            'creator_token'       => $creatorToken,
            'visibility'          => 'public',
            'listed'              => false,
            'has_nodes'           => true,
            'type'                => 'book',
            'raw_json'            => '[]',
            'timestamp'           => (int) round(microtime(true) * 1000),
            'conversion_method'   => $creator === AutoVersionResolver::CREATOR ? AutoVersionResolver::CONVERSION_METHOD : null,
            'canonical_source_id' => $canonicalId,
        ];
        if ($db->table('library')->where('book', $book)->exists()) {
            $db->table('library')->where('book', $book)->update($row);
        } else {
            $db->table('library')->insert($row + ['book' => $book, 'created_at' => now()]);
        }

        return $canonicalId;
    }

    private function node($db, string $book, string $nodeId, int $line, string $html): void
    {
        $db->table('nodes')->insert([
            'book' => $book, 'node_id' => $nodeId, 'chunk_id' => 1, 'startLine' => $line,
            'content' => $html, 'plainText' => strip_tags($html), 'type' => 'p',
            'created_at' => now(), 'updated_at' => now(),
        ]);
    }
}
