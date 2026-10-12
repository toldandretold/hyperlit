<?php

namespace App\Console\Commands;

use App\Models\PgLibrary;
use App\Models\PgNode;
use App\Services\BookCache;
use App\Services\SourceImport\Content\JatsFullText;
// NOTE: all queries run on the BYPASSRLS `pgsql_admin` connection — the CLI has
// no app.current_user session var, so default-connection reads under RLS
// silently see a subset (the queue-worker billing no-op class of bug).
use Illuminate\Console\Command;
use Illuminate\Support\Facades\DB;

/**
 * Repair bare-identifier anchors minted by the pre-fix JATS converter.
 *
 * JatsFullText used to copy <ext-link xlink:href="..."> verbatim into
 * <a href="...">, and PMC encodes DOIs / PMIDs / PMCIDs SCHEMELESS — so stored
 * node HTML carries relative anchors like href="10.1371/journal.pone.0144717",
 * which browsers (and Googlebot, via the prerendered <main>) resolve against
 * hyperlit.io. GSC crawled them as real pages (404 / noindex-shell, 2026-10).
 *
 * The repair mirrors JatsFullText::absoluteExtLinkUrl: unambiguous identifiers
 * (DOI, PMC-prefixed PMCID, www.-prefixed hosts) get their canonical resolver
 * prefix; a bare NUMBER's type (pmid vs pmcid) was lost when the ext-link-type
 * attribute was dropped at conversion, so those anchors are UNWRAPPED — the
 * text stays, the broken link goes.
 *
 * Does the two things a bulk content rewrite must do (StripNoDeleteMarkers
 * precedent): bump `library.timestamp` per touched book (open readers learn of
 * the change) and invalidate the BookCache (stale chunk files would keep
 * serving the bad hrefs to crawlers — the whole point of the sweep).
 *
 * E2EE books hold ciphertext; the patterns can't match them, but they are
 * excluded explicitly for parity with the precedent.
 *
 * USAGE:
 * php artisan content:fix-bare-ext-links --dry-run        # preview, all books
 * php artisan content:fix-bare-ext-links {book} --dry-run # preview, one book
 * php artisan content:fix-bare-ext-links                  # apply
 */
class FixBareExtLinkHrefs extends Command
{
    protected $signature = 'content:fix-bare-ext-links {book?} {--dry-run}';

    protected $description = 'Rewrite/unlink bare DOI/PMID/PMCID hrefs left in stored node HTML by the pre-fix JATS converter (bumps timestamps + busts BookCache)';

    /**
     * Damage shapes, as they appear inside stored HTML (Postgres ARE regex;
     * AREs support the (?!…) lookahead). Relative hrefs only — the lookahead
     * keeps `=`-carrying ABSOLUTE urls (every query string on the web) out.
     * Shapes: doi:-prefixed / bare DOI / PMCID / bare number / www. host /
     * scholar-lookup query strings and pct-encoded citation text (`title=…`,
     * `Lock%20S.%20…` — PMC self-closed ext-links).
     * Deliberately NOT matched: web-scrape relics like ../contents.html —
     * repairing those needs the source site's base URL (a different sweep) —
     * and ANY scheme'd href (https:, mailto:, whatsapp:, tel:, …): a scheme
     * means the browser never resolves it against hyperlit.io. doi: is the
     * one scheme'd shape we repair, as its own alternation branch.
     */
    private const NODE_PATTERN = 'href="(?![a-zA-Z][a-zA-Z0-9+.-]*:|#|/)(10\.\d{4,9}/|PMC\d|www\.|\d{1,9}"|[^"]*(=|%20))|href="doi:10\.';

    public function handle(BookCache $cache)
    {
        $book = $this->argument('book');
        $dryRun = $this->option('dry-run');

        if ($dryRun) {
            $this->info('🔍 DRY RUN MODE - No changes will be made');
        }

        $encryptedBooks = PgLibrary::on('pgsql_admin')->where('encrypted', true)->pluck('book')->all();

        $affectedNodes = PgNode::on('pgsql_admin')->whereRaw('content ~ ?', [self::NODE_PATTERN])
            ->when($book, fn ($q) => $q->where('book', $book))
            ->when($encryptedBooks !== [], fn ($q) => $q->whereNotIn('book', $encryptedBooks))
            ->get();

        // preview_nodes blobs hold copies of node HTML; inside JSON text the
        // quotes are backslash-escaped, so the needle is href=\"...
        $jsonPattern = 'href=\\\\"(?![a-zA-Z][a-zA-Z0-9+.-]*:|#|/)(10\\.\\d{4,9}/|PMC\\d|www\\.|\\d{1,9}\\\\"|[^"]*(=|%20))|href=\\\\"doi:10\\.';
        // footnotes has a composite key (book, footnoteId); hyperlights has id.
        $previewKeys = ['footnotes' => ['book', 'footnoteId'], 'hyperlights' => ['id']];
        $previewRows = [];
        foreach ($previewKeys as $table => $keys) {
            $previewRows[$table] = DB::connection('pgsql_admin')->table($table)
                ->whereRaw('preview_nodes::text ~ ?', [$jsonPattern])
                ->when($book, fn ($q) => $q->where('book', $book))
                ->when($encryptedBooks !== [], fn ($q) => $q->whereNotIn('book', $encryptedBooks))
                ->get(array_unique([...$keys, 'book', 'preview_nodes']));
        }

        $touchedBooks = collect($affectedNodes->pluck('book'))
            ->merge(collect($previewRows['footnotes'])->pluck('book'))
            ->merge(collect($previewRows['hyperlights'])->pluck('book'))
            ->unique()
            ->values();

        $this->info("Found {$affectedNodes->count()} node(s), "
            . count($previewRows['footnotes']) . ' footnote preview blob(s), '
            . count($previewRows['hyperlights']) . ' hyperlight preview blob(s) '
            . "across {$touchedBooks->count()} book(s)");

        if ($touchedBooks->isEmpty()) {
            $this->info('✅ No bare ext-link hrefs found!');
            return 0;
        }

        if ($dryRun) {
            $this->newLine();
            $this->info('📋 Sample of affected nodes (with the hrefs they carry):');
            foreach ($affectedNodes->take(10) as $node) {
                preg_match_all('#href="((?:doi:|(?![a-zA-Z][a-zA-Z0-9+.\-]*:|\#|/))[^"]+)"#i', $node->content, $m);
                $hrefs = implode(', ', array_slice(array_unique($m[1]), 0, 5));
                $this->line("  Book: {$node->book} | Line: {$node->startLine} | {$hrefs}");
            }
            $this->newLine();
            $this->info('📚 Affected books: ' . $touchedBooks->implode(', '));
            $this->newLine();
            $this->warn('⚠️  To actually repair, run without --dry-run flag');
            return 0;
        }

        if (! $this->confirm("Repair bare hrefs across {$touchedBooks->count()} book(s)?", true)) {
            $this->info('❌ Cancelled');
            return 1;
        }

        // 1. nodes.content
        $bar = $this->output->createProgressBar($affectedNodes->count());
        $bar->start();
        $totals = ['removed' => 0, 'rewritten' => 0, 'unlinked' => 0];
        $changedBooks = [];
        foreach ($affectedNodes as $node) {
            [$repaired, $stats] = self::repairHtml($node->content);
            if ($repaired !== $node->content) {
                $node->content = $repaired;
                $node->save();
                $changedBooks[$node->book] = true;
            }
            foreach ($stats as $k => $v) {
                $totals[$k] += $v;
            }
            $bar->advance();
        }
        $bar->finish();
        $this->newLine();
        $this->info("✅ Nodes: {$totals['removed']} empty anchor(s) removed, "
            . "{$totals['rewritten']} href(s) absolutized, {$totals['unlinked']} junk anchor(s) unwrapped");

        // 2. preview_nodes jsonb — decode, repair every string, re-encode.
        foreach ($previewKeys as $table => $keys) {
            $updated = 0;
            foreach ($previewRows[$table] as $row) {
                $decoded = json_decode($row->preview_nodes, true);
                if (!is_array($decoded)) {
                    continue;
                }
                $changed = false;
                array_walk_recursive($decoded, function (&$value) use (&$changed) {
                    if (is_string($value) && str_contains($value, 'href=')) {
                        [$repaired] = self::repairHtml($value);
                        if ($repaired !== $value) {
                            $value = $repaired;
                            $changed = true;
                        }
                    }
                });
                if ($changed) {
                    $query = DB::connection('pgsql_admin')->table($table);
                    foreach ($keys as $key) {
                        $query->where($key, $row->{$key});
                    }
                    $query->update(['preview_nodes' => json_encode($decoded, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES)]);
                    $changedBooks[$row->book] = true;
                    $updated++;
                }
            }
            $this->info("✅ Repaired {$updated} {$table} preview blob(s)");
        }

        // 3. Per CHANGED book (selection can over-match — e.g. a scheme'd href
        //    the repair correctly leaves alone): advance library.timestamp so
        //    open clients learn of the change, bust the BookCache so stale
        //    chunk files can't keep serving the bad hrefs, and queue a rewarm
        //    so crawlers don't meet a cold, empty <main> until a human visits.
        $changedBooks = array_keys($changedBooks);
        $nowMs = (int) round(microtime(true) * 1000);
        foreach ($changedBooks as $changed) {
            DB::connection('pgsql_admin')->table('library')->where('book', $changed)->update([
                'timestamp' => DB::raw('GREATEST(' . $nowMs . ', COALESCE(timestamp, 0) + 1)'),
            ]);
            $cache->invalidate($changed);
            \App\Jobs\WarmBookCacheJob::dispatch($changed);
        }
        $this->info('✅ Bumped timestamps, invalidated BookCache + queued rewarm for ' . count($changedBooks) . ' changed book(s)');

        return 0;
    }

    /**
     * Repair one HTML string. Returns [html, stats] where stats =
     * {removed, rewritten, unlinked}.
     *
     * Pass A deletes EMPTY relative-href anchors — the converter's output for
     * PMC's self-closed <ext-link/> (scholar query strings, pub-ids): nothing
     * to link, invisible dead weight that crawlers still followed.
     * Pass B absolutizes every relative href the converter's resolver can now
     * classify (DOI, PMC-prefixed PMCID, www. hosts).
     * Pass C unwraps anchors still carrying JATS-junk hrefs — a bare number
     * (pmid vs pmcid unknowable once ext-link-type is gone), a query string,
     * pct-encoded citation text — keeping the text: an unlinked citation
     * beats a link to a page that doesn't exist.
     * Anything else relative (../page.html web-scrape relics) is left alone,
     * and anything with a SCHEME (https:, mailto:, whatsapp:, tel:, …) is not
     * relative at all — doi: is the one scheme'd shape repaired (pass B).
     */
    public static function repairHtml(string $html): array
    {
        $stats = ['removed' => 0, 'rewritten' => 0, 'unlinked' => 0];

        // "No scheme, no fragment, not root-relative" — the hrefs browsers
        // would resolve against hyperlit.io.
        $rel = '(?![a-zA-Z][a-zA-Z0-9+.\-]*:|\#|/)';

        $html = preg_replace_callback(
            '#<a\b[^>]*\bhref="(?:doi:[^"]*|' . $rel . '[^"]*)"[^>]*>\s*</a>#i',
            function () use (&$stats) {
                $stats['removed']++;
                return '';
            },
            $html
        );

        $html = preg_replace_callback(
            '#href="(doi:[^"]+|' . $rel . '[^"]+)"#i',
            function ($m) use (&$stats) {
                $url = JatsFullText::absoluteExtLinkUrl(html_entity_decode($m[1], ENT_QUOTES));
                if ($url === null) {
                    return $m[0];
                }
                $stats['rewritten']++;
                return 'href="' . htmlspecialchars($url) . '"';
            },
            $html
        );

        $html = preg_replace_callback(
            '#<a\b[^>]*\bhref="' . $rel . '(?:\d{1,9}|[^"]*(?:=|%20)[^"]*)"[^>]*>(.*?)</a>#is',
            function ($m) use (&$stats) {
                $stats['unlinked']++;
                return $m[1];
            },
            $html
        );

        return [$html, $stats];
    }
}
