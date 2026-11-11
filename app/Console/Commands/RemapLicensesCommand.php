<?php

namespace App\Console\Commands;

use App\Services\Licensing\LicenseDiscovery;
use App\Services\SourceHarvest\OaLicenseMapper;
use App\Services\Licensing\WorkLicenseResolver;
use App\Support\Licenses;
use Illuminate\Console\Command;
use Illuminate\Support\Facades\DB;

/**
 * Repairs `library.license` on rows the old code mislabelled. Dry-run by default.
 *
 * What it touches, and only when the stored value is one the old code could have produced
 * WITHOUT a decision by a person:
 *  1. Works Hyperlit did not author — system-minted rows (canonicalizer_v1, OpenAlex,
 *     Semantic_scholar, Openlibrary, WebFetch) and URL imports — still carrying the column
 *     default CC-BY-SA-4.0-NO-AI (Hyperlit's licence for a user's OWN writing), or the old
 *     mapper's shouted `custom` text ("HTTPS://CREATIVECOMMONS.ORG/LICENSES/BY NC ND/4.0/").
 *     Re-derived with WorkLicenseResolver from work_license / journal DOAJ licence / OA status.
 *     Also: a third-party row whose CC code says 4.0 only because the old mapper ASSUMED it
 *     (its work_license is a bare slug like `cc-by`, no version anywhere) → the version-less
 *     family code (CC-BY). `library:discover-licenses` then looks for the real version.
 *  2. Any row whose code is a mis-cased vocabulary code (`all-rights-reserved`) → canonical.
 *
 * Every rewritten row gets `license_source`: `status` when the code was inferred from OA
 * status alone (discover-licenses' `status-inferred` scope), `remap` when it came from the
 * row's own evidence. Rows whose licence a person chose (`license_source = 'user'`) are never
 * touched.
 *
 * It never changes a user's own book that carries a valid code: the default on a user-authored
 * book is indistinguishable from a deliberate choice, so it is left alone.
 */
class RemapLicensesCommand extends Command
{
    protected $signature = 'library:remap-licenses
        {--apply : write the changes (default is a dry run)}
        {--limit=0 : stop after this many changed rows (0 = no limit)}
        {--book=* : restrict to these book ids (spot fixes; also keeps tests from touching other rows)}';

    protected $description = 'Re-derive library.license for harvested/imported works mislabelled with the site default';

    public function handle(): int
    {
        $apply = (bool) $this->option('apply');
        $limit = (int) $this->option('limit');
        $books = array_values(array_filter((array) $this->option('book')));
        $db = DB::connection('pgsql_admin');

        $tally = [];
        $changed = 0;

        // ── 1. third-party works ──────────────────────────────────────────────
        $q = $db->table('library as l')
            ->leftJoin('canonical_source as c', 'c.id', '=', 'l.canonical_source_id')
            ->where(fn ($w) => LicenseDiscovery::thirdPartyWorks($w))
            ->where(fn ($w) => $w->whereNull('l.license_source')->orWhere('l.license_source', '!=', LicenseDiscovery::SOURCE_USER))
            ->where(function ($w) {
                $w->where('l.license', Licenses::DEFAULT_USER)
                    ->orWhere(function ($c) {
                        // CC-…-4.0 that the old mapper assumed from a version-less slug.
                        $c->where('l.license', 'like', 'CC-%-4.0')
                            ->whereNull('l.license_source')
                            ->whereNotNull('l.work_license')
                            ->whereRaw("l.work_license !~ '[0-9]'");
                    })
                    ->orWhere(function ($c) {
                        // Old-mapper output: custom + an all-caps copy of the upstream slug/URL.
                        $c->where('l.license', Licenses::CUSTOM)
                            ->whereNull('l.license_book')
                            ->whereRaw('l.custom_license_text = upper(l.custom_license_text)');
                    });
            })
            ->when($books, fn ($w) => $w->whereIn('l.book', $books))
            ->select(['l.book', 'l.license', 'l.custom_license_text', 'l.work_license', 'l.oa_status', 'c.journal_source_id']);

        // Keyset, not offset: an applied row leaves this query's predicate, so lazy()'s
        // OFFSET pages would silently skip as many rows as the previous page changed (a dry
        // run said 5,510 and --apply changed 3,010).
        foreach ($q->lazyById(1000, 'l.book', 'book') as $row) {
            // An assumed-4.0 row only ever loses its version — never changes family. The
            // stored code may not have come from work_license at all (the won copy's licence
            // outranks it in the resolver), so a family that disagrees with work_license, or
            // a version the hosted copy really stated, is left for discovery to settle.
            if ($family = Licenses::ccFamily((string) $row->license)) {
                $slug = OaLicenseMapper::parse((string) $row->work_license);
                if (($slug['license'] ?? null) !== $family || self::wonCopyStatesVersion($row->book)) {
                    continue;
                }
                $new = ['license' => $family, 'custom_license_text' => null, 'license_url' => null];
                $source = LicenseDiscovery::SOURCE_REMAP;
                $key = "{$row->license} → {$family}";
                $tally[$key] = ($tally[$key] ?? 0) + 1;
                $changed++;
                if ($apply) {
                    $db->table('library')->where('book', $row->book)->update(['license' => $family, 'license_source' => $source, 'updated_at' => now(), 'timestamp' => self::nowMs()]);
                    self::invalidate($row->book);
                }
                if ($limit && $changed >= $limit) {
                    break;
                }

                continue;
            }

            $hasEvidence = trim((string) $row->work_license) !== '' || trim((string) $row->oa_status) !== ''
                || ($row->license === Licenses::CUSTOM && trim((string) $row->custom_license_text) !== '');
            if (! $hasEvidence && ! $row->journal_source_id) {
                $new = ['license' => Licenses::UNKNOWN, 'custom_license_text' => null, 'license_url' => null];
                $source = null;
            } else {
                $candidates = [
                    $row->work_license,
                    // The old mapper's shouted text still carries the original licence
                    // (spaces where dashes were) — the new parser reads it.
                    $row->license === Licenses::CUSTOM ? $row->custom_license_text : null,
                    WorkLicenseResolver::journalLicense($row->journal_source_id),
                ];
                $new = WorkLicenseResolver::resolve($candidates, $row->oa_status);
                $recognised = array_filter($candidates, fn ($c) => $c !== null && OaLicenseMapper::parse($c) !== null);
                $source = $recognised ? LicenseDiscovery::SOURCE_REMAP : LicenseDiscovery::SOURCE_STATUS;
                if (! $recognised && array_filter($candidates, fn ($c) => trim((string) $c) !== '')) {
                    $source = LicenseDiscovery::SOURCE_REMAP; // unrecognised upstream text kept as custom
                }
            }

            if ($new['license'] === $row->license && $new['custom_license_text'] === $row->custom_license_text) {
                continue;
            }
            $key = "{$row->license} → {$new['license']}";
            $tally[$key] = ($tally[$key] ?? 0) + 1;
            $changed++;
            if ($apply) {
                $db->table('library')->where('book', $row->book)->update($new + ['license_source' => $source, 'updated_at' => now(), 'timestamp' => self::nowMs()]);
                self::invalidate($row->book);
            }
            if ($limit && $changed >= $limit) {
                break;
            }
        }

        // ── 2. mis-cased codes ───────────────────────────────────────────────
        $codes = Licenses::codes();
        $odd = $db->table('library')->whereNotIn('license', $codes)
            ->when($books, fn ($w) => $w->whereIn('book', $books))
            ->select('license', DB::raw('count(*) as n'))->groupBy('license')->get();
        foreach ($odd as $o) {
            $canon = Licenses::canonicalCode($o->license);
            $target = $canon ?? Licenses::CUSTOM;
            $key = "{$o->license} → {$target}" . ($canon ? '' : ' (text kept)');
            $tally[$key] = ($tally[$key] ?? 0) + (int) $o->n;
            $changed += (int) $o->n;
            if ($apply) {
                $upd = ['license' => $target];
                if (! $canon) {
                    $upd['custom_license_text'] = DB::raw('coalesce(custom_license_text, license)');
                }
                $db->table('library')->where('license', $o->license)
                    ->when($books, fn ($w) => $w->whereIn('book', $books))
                    ->update($upd);
            }
        }

        arsort($tally);
        $this->table(['change', 'rows'], collect($tally)->map(fn ($n, $k) => [$k, $n])->values()->all());
        $this->info(($apply ? 'Updated ' : 'Would update ') . $changed . ' row(s).' . ($apply ? '' : ' Re-run with --apply to write.'));

        return self::SUCCESS;
    }

    /** The hosted copy's own recorded licence states a version (fetch_trace.json `won_license`). */
    private static function wonCopyStatesVersion(string $book): bool
    {
        $path = resource_path("markdown/{$book}/fetch_trace.json");
        if (! is_file($path)) {
            return false;
        }
        $won = (json_decode((string) file_get_contents($path), true) ?: [])['won_license'] ?? null;
        $hit = is_string($won) ? OaLicenseMapper::parse($won) : null;

        return $hit !== null && Licenses::statesVersion($hit['license']);
    }

    /** Move the content clock so open readers re-fetch the library row (and its new licence). */
    private static function nowMs(): int
    {
        return (int) round(microtime(true) * 1000);
    }

    private static function invalidate(string $book): void
    {
        try {
            app(\App\Services\BookCache::class)->invalidate($book);
        } catch (\Throwable) {
            // best effort — the prerender rebuilds once the timestamp moved
        }
    }
}
