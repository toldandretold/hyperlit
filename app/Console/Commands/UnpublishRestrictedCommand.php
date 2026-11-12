<?php

namespace App\Console\Commands;

use App\Services\Licensing\HostingPolicy;
use App\Services\SourceImport\Content\BodyPresenceAssessor;
use App\Support\Licenses;
use Illuminate\Console\Command;
use Illuminate\Support\Facades\DB;

/**
 * Stop publishing what Hyperlit holds but may not republish (App\Services\Licensing\HostingPolicy).
 *
 *  A. WebFetch pages — news/web pages citation review saved as evidence, created public with the
 *     No-AI default licence. → private, licence Unknown. (2,046 public on prod, 2026-11-11.)
 *  B. Hosted third-party copies whose licence forbids redistribution (all rights reserved) —
 *     mostly closed papers `citation:vacuum` fetched with no open-access check. → private.
 *
 * Dry run by default. `--report` lists every pool-B row with what we actually hold (node count,
 * text length, completeness, the fetched copy's licence/version, source host, and a body-presence
 * verdict recomputed from the nodes) so a table of contents or landing page can be retracted with
 * `harvest:retract` instead of merely hidden. A user's own books are never touched.
 */
class UnpublishRestrictedCommand extends Command
{
    protected $signature = 'library:unpublish-restricted
        {--apply : Write the changes (default: dry run)}
        {--book=* : Only these books}
        {--report : List every hosted all-rights-reserved row with what we hold}';

    protected $description = 'Make web evidence and all-rights-reserved hosted copies private (dry run by default)';

    public function handle(BodyPresenceAssessor $assessor): int
    {
        $db = DB::connection('pgsql_admin');
        $apply = (bool) $this->option('apply');
        $books = array_values(array_filter((array) $this->option('book')));

        $base = fn () => $db->table('library as l')
            ->where(fn ($q) => HostingPolicy::governed($q))
            ->where('l.visibility', 'public')
            ->when($books, fn ($q) => $q->whereIn('l.book', $books));

        // A — web evidence, hosted or not (a stub row with no text still says "this is ours").
        $web = 0;
        foreach ($base()->where('l.creator', HostingPolicy::WEB_CREATOR)->select(['l.book', 'l.license'])->lazyById(1000, 'l.book', 'book') as $row) {
            $web++;
            if ($apply) {
                HostingPolicy::unpublish($row->book, in_array($row->license, [Licenses::DEFAULT_USER, null, ''], true));
            }
        }

        // B — hosted copies the policy forbids publishing.
        $restricted = [];
        foreach ($base()->where('l.creator', '!=', HostingPolicy::WEB_CREATOR)->where('l.has_nodes', true)
            ->select(['l.book', 'l.title', 'l.license', 'l.creator', 'l.type', 'l.completeness', 'l.url', 'l.oa_url', 'l.pdf_url', 'l.doi', 'l.oa_status', 'l.conversion_method'])
            ->lazyById(1000, 'l.book', 'book') as $row) {
            if (HostingPolicy::mayPublish($row)) {
                continue;
            }
            $restricted[] = $row;
            if ($apply) {
                HostingPolicy::unpublish($row->book);
            }
        }

        if ($this->option('report') && $restricted) {
            $this->line('Hosted all-rights-reserved copies (body = recomputed from nodes; "absent" = likely a ToC/landing page → harvest:retract):');
            foreach ($restricted as $row) {
                $texts = $this->nodeTexts($db, $row->book);
                $body = $assessor->assessBlocks($texts, BodyPresenceAssessor::PROFILE_SCHOLARLY);
                $trace = $this->trace($row->book);
                $host = parse_url((string) ($row->pdf_url ?: $row->oa_url ?: $row->url), PHP_URL_HOST) ?: '-';
                $this->line(sprintf(
                    '  %-28s %-16s nodes=%-5d chars=%-7d body=%-7s completeness=%-13s oa=%-7s won=%s/%s host=%s  %s',
                    $row->book, $row->creator, count($texts), array_sum(array_map('mb_strlen', $texts)),
                    $body['verdict'], $row->completeness ?? '-', $row->oa_status ?? '-',
                    $trace['won_license'] ?? '-', $trace['won_version'] ?? '-', $host, mb_substr((string) $row->title, 0, 60),
                ));
            }
            $this->newLine();
        }

        $verb = $apply ? 'Made private' : 'Would make private';
        $this->info("{$verb}: {$web} web evidence page(s), " . count($restricted) . ' hosted all-rights-reserved cop(y/ies).');
        if (! $apply) {
            $this->line('Re-run with --apply to write. A user\'s own books are never touched (see the licence review shelf).');
        }

        return self::SUCCESS;
    }

    /** @return list<string> */
    private function nodeTexts($db, string $book): array
    {
        return $db->table('nodes')->where('book', $book)->orderBy('startLine')->get(['plainText', 'content'])
            ->map(fn ($n) => ($n->plainText ?? '') !== '' ? $n->plainText : strip_tags((string) $n->content))->all();
    }

    private function trace(string $book): array
    {
        $path = resource_path("markdown/{$book}/fetch_trace.json");

        return is_file($path) ? (json_decode((string) file_get_contents($path), true) ?: []) : [];
    }
}
