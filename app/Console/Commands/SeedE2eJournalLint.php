<?php

namespace App\Console\Commands;

use Illuminate\Console\Command;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

/**
 * Seed (and RESET) the fixture the /maintainer/journal-import lint e2e spec drives: a journal
 * with two imported articles — one carrying a page-break fragment wrapped as a blockquote (the
 * 7fa30289 shape, far enough down the book that jumping to it has to scroll), one clean.
 *
 * Two stages, because the thing under test is a before/after:
 *
 *   e2e:seed-journal-lint                 the journal as first imported; wipes any stored lint
 *                                         and snapshot so the spec starts from nothing
 *   e2e:seed-journal-lint --reconverted   what a reconvert would leave: the broken article is
 *                                         repaired, the clean one gains a heading that is really
 *                                         a list lead-in, and both content clocks move. The
 *                                         snapshot is LEFT ALONE — comparing against it is the test.
 *
 * Promotes the e2e user to admin (the console 404s for everyone else). Never in production.
 */
class SeedE2eJournalLint extends Command
{
    protected $signature = 'e2e:seed-journal-lint
        {--reconverted : Apply the "after a reconvert" stage instead of resetting}
        {--email= : e2e user email (default: E2E_USER_EMAIL or what@na.com)}';

    protected $description = 'Seed the journal fixture for the /maintainer/journal-import conversion-lint e2e spec';

    public const JOURNAL_SLUG = 'e2e-lint-journal';
    public const BROKEN_BOOK = 'book_e2e_lint_broken';
    public const CLEAN_BOOK = 'book_e2e_lint_clean';
    /** The node the fragment sits in — below the fold, so a jump must scroll to reach it. */
    public const FRAGMENT_LINE = 4200;

    public function handle(): int
    {
        if (app()->isProduction()) {
            $this->error('e2e fixtures are never seeded in production.');

            return self::FAILURE;
        }

        $email = $this->option('email') ?: env('E2E_USER_EMAIL', 'what@na.com');
        $admin = DB::connection('pgsql_admin');
        $user = $admin->table('users')->where('email', $email)->first();
        if (! $user) {
            $this->error("No user with email {$email} — create the e2e user first (see tests/e2e/README.md).");

            return self::FAILURE;
        }
        if (! ($user->is_admin ?? false)) {
            $admin->table('users')->where('id', $user->id)->update(['is_admin' => true]);
            $this->line("Promoted {$email} to admin (console gate).");
        }

        $reconverted = (bool) $this->option('reconverted');
        $books = [self::BROKEN_BOOK, self::CLEAN_BOOK];

        $journalId = $admin->table('journal_sources')->where('slug', self::JOURNAL_SLUG)->value('id');
        if (! $journalId) {
            $journalId = (string) Str::uuid();
            $admin->table('journal_sources')->insert([
                'id'                 => $journalId,
                'openalex_source_id' => 'SE2ELINT',
                'display_name'       => 'E2E Lint Journal',
                'publisher'          => 'E2E Press',
                'slug'               => self::JOURNAL_SLUG,
                'is_diamond'         => true,
                'created_at'         => now(),
                'updated_at'         => now(),
            ]);
        }

        if (! $reconverted) {
            $admin->table('conversion_lint_snapshots')->where('journal_source_id', $journalId)->delete();
            $admin->table('conversion_lint_results')->whereIn('book', $books)->delete();
        }
        $admin->table('nodes')->whereIn('book', $books)->delete();

        // The broken article is the more-cited one, so the list's default order puts it first
        // and "problems first" has something to prove only on the clean one dropping out.
        $this->work($admin, $user, $journalId, self::BROKEN_BOOK, 'E2E Lint Broken Article', 20);
        $this->work($admin, $user, $journalId, self::CLEAN_BOOK, 'E2E Lint Clean Article', 10);

        $this->seedBroken($admin, $reconverted);
        $this->seedClean($admin, $reconverted);

        $this->info(($reconverted ? 'Applied the reconverted stage to' : 'Seeded')
            . ' /maintainer/journal-import/' . self::JOURNAL_SLUG);

        return self::SUCCESS;
    }

    private function seedBroken($admin, bool $reconverted): void
    {
        $line = 100;
        $this->node($admin, self::BROKEN_BOOK, $line, 'h1', 'E2E Lint Broken Article');
        for ($i = 1; $i <= 39; $i++) {
            $line += 100;
            $this->node($admin, self::BROKEN_BOOK, $line, 'p',
                "Filler paragraph {$i}. It is here so that the paragraph the problem sits in is well below "
                . 'the first screen of the converted output, and a jump to it has to scroll the pane.');
        }

        // Filler ends at 4000; the paragraph that stops mid-sentence is 4100, the fragment 4200.
        if ($reconverted) {
            $this->node($admin, self::BROKEN_BOOK, self::FRAGMENT_LINE - 100, 'p',
                'Alternative voices are less heard or read on the Internet than mainstream ones. The assignment of '
                . 'domain names (such as microsoft.com) has been commodified, and is now in private hands.');
        } else {
            $this->node($admin, self::BROKEN_BOOK, self::FRAGMENT_LINE - 100, 'p',
                'Alternative voices are less heard or read on the Internet than mainstream ones. The assignment of');
            $this->node($admin, self::BROKEN_BOOK, self::FRAGMENT_LINE, 'blockquote',
                'domain names (such as microsoft.com) has been commodified, and is now in private hands.');
        }
        $this->node($admin, self::BROKEN_BOOK, self::FRAGMENT_LINE + 100, 'p',
            'A closing paragraph, complete and ordinary, which ends the article properly.');
    }

    private function seedClean($admin, bool $reconverted): void
    {
        $this->node($admin, self::CLEAN_BOOK, 100, 'h1', 'E2E Lint Clean Article');
        $this->node($admin, self::CLEAN_BOOK, 200, 'p',
            'Emergence and self-organization are two particularly important concepts of the sciences of complexity.');
        if ($reconverted) {
            // The regression: a list lead-in promoted to a heading.
            $this->node($admin, self::CLEAN_BOOK, 300, 'h2', 'Aspects of emergence are:');
        } else {
            $this->node($admin, self::CLEAN_BOOK, 300, 'p', 'Aspects of emergence are several, and each is described below.');
        }
        $this->node($admin, self::CLEAN_BOOK, 400, 'p',
            'Synergism means that emergence is due to the productive interaction between entities.');
    }

    private function work($admin, object $user, string $journalId, string $book, string $title, int $cited): void
    {
        $canonicalId = $admin->table('library')->where('book', $book)->value('canonical_source_id');
        if (! $canonicalId) {
            $canonicalId = (string) Str::uuid();
            $admin->table('canonical_source')->insert([
                'id'                => $canonicalId,
                'title'             => $title,
                'journal_source_id' => $journalId,
                'is_oa'             => true,
                'cited_by_count'    => $cited,
                'auto_version_book' => $book,
                'created_at'        => now(),
                'updated_at'        => now(),
            ]);
        }

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
            'foundation_source'   => 'canonical_pdf_vacuum',
            'conversion_method'   => 'pdf_ocr_auto_raw',
            // The content clock: the lint is stored against it, so the reconverted stage must
            // move it or the console would keep serving the "before" findings.
            'timestamp'           => (int) round(microtime(true) * 1000),
            'canonical_source_id' => $canonicalId,
        ];
        if ($admin->table('library')->where('book', $book)->exists()) {
            $admin->table('library')->where('book', $book)->update($row);
        } else {
            $admin->table('library')->insert($row + ['book' => $book, 'created_at' => now()]);
        }
    }

    private function node($admin, string $book, int $line, string $tag, string $text): void
    {
        $nodeId = "{$book}_n{$line}";
        $inner = $tag === 'blockquote' ? "<p>{$text}</p>" : $text;
        $admin->table('nodes')->insert([
            'book'       => $book,
            'node_id'    => $nodeId,
            'chunk_id'   => 1,
            'startLine'  => $line,
            'content'    => "<{$tag} id=\"{$line}\" data-node-id=\"{$nodeId}\">{$inner}</{$tag}>",
            'plainText'  => $text,
            'type'       => $tag,
            'created_at' => now(),
            'updated_at' => now(),
        ]);
    }
}
