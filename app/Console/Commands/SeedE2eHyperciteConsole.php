<?php

namespace App\Console\Commands;

use Illuminate\Console\Command;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

/**
 * Seed (and RESET) the fixture the /maintainer/hypercites e2e spec drives:
 * a journal with a citing article and a cited article, both held, plus a
 * `matched` hypercite candidate between them — the exact shape a detect run
 * produces, so the spec can exercise the whole review loop (select → marks →
 * approve → applied section → reload → revert) against real books in the
 * real reader. Also promotes the e2e user to admin: the console 404s for
 * everyone else.
 *
 * Idempotent AND destructive-by-design for its own fixtures: every run wipes
 * the previous run's hypercites/candidates and restores the node content, so
 * a spec that died mid-approve can't poison the next run.
 */
class SeedE2eHyperciteConsole extends Command
{
    protected $signature = 'e2e:seed-hypercite-console {--email= : e2e user email (default: E2E_USER_EMAIL or what@na.com)}';

    protected $description = 'Seed the journal + candidate fixture for the /maintainer/hypercites e2e spec (idempotent)';

    public const JOURNAL_SLUG = 'e2e-hypercite-journal';
    public const CITING_BOOK = 'book_e2e_hxc_citing';
    public const CITED_BOOK = 'book_e2e_hxc_cited';
    public const QUOTE = 'the dominance of the global north with respect to agenda setting in partnerships';

    /**
     * Extra citing books (each with one candidate against CITED_BOOK) so the
     * list has several rows to WALK — the click-down-the-list e2e needs
     * multiple pane loads in sequence. Named to sort AFTER the primary book,
     * keeping "first row" stable for the approve/revert tests.
     */
    public const EXTRA_CITING = ['book_e2e_hxc_citing2', 'book_e2e_hxc_citing3', 'book_e2e_hxc_citing4'];

    public function handle(): int
    {
        $email = $this->option('email') ?: env('E2E_USER_EMAIL', 'what@na.com');
        $admin = DB::connection('pgsql_admin');

        $user = $admin->table('users')->where('email', $email)->first();
        if (! $user) {
            $this->error("No user with email {$email} — create the e2e user first (see tests/e2e/README.md).");

            return self::FAILURE;
        }

        // The console is admin-gated; the e2e session must clear it.
        if (! ($user->is_admin ?? false)) {
            $admin->table('users')->where('id', $user->id)->update(['is_admin' => true]);
            $this->line("Promoted {$email} to admin (console gate).");
        }

        // ── Wipe the previous run's artifacts ──
        $citingBooks = array_merge([self::CITING_BOOK], self::EXTRA_CITING);
        $allBooks = array_merge($citingBooks, [self::CITED_BOOK]);
        $admin->table('hypercite_candidates')->whereIn('citing_book', $citingBooks)->delete();
        $admin->table('hypercites')->where('book', self::CITED_BOOK)->delete();
        $admin->table('nodes')->whereIn('book', $allBooks)->delete();
        $admin->table('bibliography')->whereIn('book', $allBooks)->delete();

        // ── Journal ──
        $journalId = $admin->table('journal_sources')->where('slug', self::JOURNAL_SLUG)->value('id');
        if (! $journalId) {
            $journalId = (string) Str::uuid();
            $admin->table('journal_sources')->insert([
                'id'                 => $journalId,
                'openalex_source_id' => 'SE2EHXC',
                'display_name'       => 'E2E Hypercite Journal',
                'publisher'          => 'E2E Press',
                'slug'               => self::JOURNAL_SLUG,
                'is_diamond'         => true,
                'created_at'         => now(),
                'updated_at'         => now(),
            ]);
        }

        // ── Held works: the primary citing/cited pair + extra citing books ──
        $citingCanonical = $this->work($admin, $user, $journalId, self::CITING_BOOK, 'E2E Citing Article');
        $citedCanonical = $this->work($admin, $user, $journalId, self::CITED_BOOK, 'E2E Cited Article');

        // Citing node: quote + Flint-style bracketed marker WITH page number —
        // the shape that regressed on prod ((Flint et al, 2022:↗ 81)).
        $quote = self::QUOTE;
        $citingNode = self::CITING_BOOK . '_n1';
        $citingHtml = '<p id="1" data-node-id="' . $citingNode . '">The requirement compounds "'
            . $quote . '" (<a href="#flint2022" class="in-text-citation">Flint et al, 2022</a>: 81). During one FGD it was said.</p>';
        $this->node($admin, self::CITING_BOOK, $citingNode, 1, $citingHtml);

        // The cited work carries the quote TWICE: once in its front matter and
        // once in the body. That is the ordinary shape of an OA article, and it
        // is what the occurrence picker exists for — front matter comes first in
        // document order, so an unranked detector would park the reviewer on the
        // title block. Ranking puts the body node first; the ↑↓ arrows reach the
        // other one.
        $citedFrontNode = self::CITED_BOOK . '_n1';
        $citedFrontHtml = '<p id="1" data-node-id="' . $citedFrontNode . '">E2E Cited Article. '
            . 'This paper examines ' . $quote . ' across the programme.</p>';
        $this->node($admin, self::CITED_BOOK, $citedFrontNode, 1, $citedFrontHtml);

        $citedNode = self::CITED_BOOK . '_n5';
        $citedHtml = '<p id="5" data-node-id="' . $citedNode . '">One criticism is '
            . $quote . ' and its feedback loops.</p>';
        $this->node($admin, self::CITED_BOOK, $citedNode, 5, $citedHtml);

        $admin->table('bibliography')->insert([
            'book'                => self::CITING_BOOK,
            'referenceId'         => 'flint2022',
            'content'             => 'Flint, A. et al (2022) E2E Cited Article.',
            'canonical_source_id' => $citedCanonical,
            'match_method'        => 'doi',
            'created_at'          => now(),
            'updated_at'          => now(),
        ]);

        // ── The matched candidate, exactly as CandidateDetector writes it ──
        $plainCiting = html_entity_decode(strip_tags($citingHtml), ENT_QUOTES | ENT_HTML5, 'UTF-8');
        $plainCited = html_entity_decode(strip_tags($citedHtml), ENT_QUOTES | ENT_HTML5, 'UTF-8');
        $markerOffset = mb_strlen(html_entity_decode(
            strip_tags(substr($citingHtml, 0, (int) strpos($citingHtml, '<a href="#flint2022"'))),
            ENT_QUOTES | ENT_HTML5,
            'UTF-8'
        ));
        $charStart = mb_strpos($plainCited, $quote);

        // Ranked as the detector would rank it: body first, front matter second.
        $plainCitedFront = html_entity_decode(strip_tags($citedFrontHtml), ENT_QUOTES | ENT_HTML5, 'UTF-8');
        $frontStart = mb_strpos($plainCitedFront, $quote);
        $matchLocations = [
            [
                'node_ids'           => [$citedNode],
                'char_data'          => [$citedNode => ['charStart' => $charStart, 'charEnd' => $charStart + mb_strlen($quote)]],
                'method'             => 'exact',
                'score'              => 1.0,
                'cited_content_hash' => sha1($citedHtml),
            ],
            [
                'node_ids'           => [$citedFrontNode],
                'char_data'          => [$citedFrontNode => ['charStart' => $frontStart, 'charEnd' => $frontStart + mb_strlen($quote)]],
                'method'             => 'exact',
                'score'              => 1.0,
                'cited_content_hash' => sha1($citedFrontHtml),
            ],
        ];

        $admin->table('hypercite_candidates')->insert([
            'id'                         => (string) Str::uuid(),
            'journal_source_id'          => $journalId,
            'citing_canonical_source_id' => $citingCanonical,
            'cited_canonical_source_id'  => $citedCanonical,
            'citing_book'                => self::CITING_BOOK,
            'cited_book'                 => self::CITED_BOOK,
            'is_internal'                => true,
            'reference_id'               => 'flint2022',
            'occurrence_index'           => 0,
            'citing_node_id'             => $citingNode,
            'marker_offset'              => $markerOffset,
            'claim_start'                => 0,
            'claim_end'                  => mb_strlen($plainCiting),
            'has_quote'                  => true,
            'quote_kind'                 => 'inline',
            'quote_text'                 => $quote,
            'quote_node_id'              => $citingNode,
            'citing_content_hash'        => sha1($citingHtml),
            'match_node_ids'             => json_encode([$citedNode]),
            'match_char_data'            => json_encode([
                $citedNode => ['charStart' => $charStart, 'charEnd' => $charStart + mb_strlen($quote)],
            ]),
            'match_method'               => 'exact',
            'match_score'                => 1.0,
            'match_occurrences'          => count($matchLocations),
            'match_locations'            => json_encode($matchLocations),
            'match_location_index'       => 0,
            'cited_content_hash'         => sha1($citedHtml),
            'status'                     => 'matched',
            'created_at'                 => now(),
            'updated_at'                 => now(),
        ]);

        // ── Extra citing books, one matched candidate each (list-walking) ──
        foreach (self::EXTRA_CITING as $i => $book) {
            $n = $i + 2;
            $extraCanonical = $this->work($admin, $user, $journalId, $book, "E2E Citing Article {$n}");
            $nodeId = $book . '_n1';
            $html = '<p id="1" data-node-id="' . $nodeId . '">Article ' . $n . ' also quotes "'
                . $quote . '" (<a href="#flint2022" class="in-text-citation">Flint et al, 2022</a>: 81) in passing.</p>';
            $this->node($admin, $book, $nodeId, 1, $html);
            $admin->table('bibliography')->insert([
                'book'                => $book,
                'referenceId'         => 'flint2022',
                'content'             => 'Flint, A. et al (2022) E2E Cited Article.',
                'canonical_source_id' => $citedCanonical,
                'match_method'        => 'doi',
                'created_at'          => now(),
                'updated_at'          => now(),
            ]);
            $extraPlain = html_entity_decode(strip_tags($html), ENT_QUOTES | ENT_HTML5, 'UTF-8');
            $extraMarker = mb_strlen(html_entity_decode(
                strip_tags(substr($html, 0, (int) strpos($html, '<a href="#flint2022"'))),
                ENT_QUOTES | ENT_HTML5,
                'UTF-8'
            ));
            $admin->table('hypercite_candidates')->insert([
                'id'                         => (string) Str::uuid(),
                'journal_source_id'          => $journalId,
                'citing_canonical_source_id' => $extraCanonical,
                'cited_canonical_source_id'  => $citedCanonical,
                'citing_book'                => $book,
                'cited_book'                 => self::CITED_BOOK,
                'is_internal'                => true,
                'reference_id'               => 'flint2022',
                'occurrence_index'           => 0,
                'citing_node_id'             => $nodeId,
                'marker_offset'              => $extraMarker,
                'claim_start'                => 0,
                'claim_end'                  => mb_strlen($extraPlain),
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

        $this->info('Seeded /maintainer/hypercites/' . self::JOURNAL_SLUG
            . ' with ' . (1 + count(self::EXTRA_CITING)) . ' matched candidates across '
            . (1 + count(self::EXTRA_CITING)) . ' citing books → ' . self::CITED_BOOK . '.');

        return self::SUCCESS;
    }

    /** Upsert a canonical + held public version book; returns the canonical id. */
    private function work($admin, object $user, string $journalId, string $book, string $title): string
    {
        $canonicalId = $admin->table('library')->where('book', $book)->value('canonical_source_id');

        if (! $canonicalId) {
            $canonicalId = (string) Str::uuid();
            $admin->table('canonical_source')->insert([
                'id'                => $canonicalId,
                'title'             => $title,
                'journal_source_id' => $journalId,
                'is_oa'             => true,
                'auto_version_book' => $book,
                'created_at'        => now(),
                'updated_at'        => now(),
            ]);
        }

        $existing = $admin->table('library')->where('book', $book)->exists();
        $row = [
            'title'               => $title,
            'author'              => 'E2E Fixtures',
            'creator'             => $user->name,
            'creator_token'       => $user->user_token,
            'visibility'          => 'public',
            'listed'              => false,
            'has_nodes'           => true,
            'type'                => 'book',
            'raw_json'            => '[]',
            'timestamp'           => (int) round(microtime(true) * 1000),
            'canonical_source_id' => $canonicalId,
        ];
        if ($existing) {
            $admin->table('library')->where('book', $book)->update($row);
        } else {
            $admin->table('library')->insert($row + ['book' => $book, 'created_at' => now()]);
        }

        return $canonicalId;
    }

    private function node($admin, string $book, string $nodeId, int $line, string $html): void
    {
        $admin->table('nodes')->insert([
            'book'       => $book,
            'node_id'    => $nodeId,
            'chunk_id'   => 1,
            'startLine'  => $line,
            'content'    => $html,
            'plainText'  => strip_tags($html),
            'type'       => 'p',
            'created_at' => now(),
            'updated_at' => now(),
        ]);
    }
}
