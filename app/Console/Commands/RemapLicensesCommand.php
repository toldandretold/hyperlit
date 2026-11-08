<?php

namespace App\Console\Commands;

use App\Services\CanonicalVersions\AutoVersionResolver;
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
 *  2. Any row whose code is a mis-cased vocabulary code (`all-rights-reserved`) → canonical.
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

    private const SYSTEM_CREATORS = [AutoVersionResolver::CREATOR, 'OpenAlex', 'Semantic_scholar', 'Openlibrary', 'WebFetch'];

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
            ->where(function ($w) {
                $w->whereIn('l.creator', self::SYSTEM_CREATORS)
                    ->orWhereRaw("l.raw_json->>'imported_via' = 'url'");
            })
            ->where(function ($w) {
                $w->where('l.license', Licenses::DEFAULT_USER)
                    ->orWhere(function ($c) {
                        // Old-mapper output: custom + an all-caps copy of the upstream slug/URL.
                        $c->where('l.license', Licenses::CUSTOM)
                            ->whereNull('l.license_book')
                            ->whereRaw('l.custom_license_text = upper(l.custom_license_text)');
                    });
            })
            ->when($books, fn ($w) => $w->whereIn('l.book', $books))
            ->orderBy('l.book')
            ->select(['l.book', 'l.license', 'l.custom_license_text', 'l.work_license', 'l.oa_status', 'c.journal_source_id']);

        foreach ($q->lazy(1000) as $row) {
            $hasEvidence = trim((string) $row->work_license) !== '' || trim((string) $row->oa_status) !== ''
                || ($row->license === Licenses::CUSTOM && trim((string) $row->custom_license_text) !== '');
            if (! $hasEvidence && ! $row->journal_source_id) {
                $new = ['license' => Licenses::UNKNOWN, 'custom_license_text' => null, 'license_url' => null];
            } else {
                $new = WorkLicenseResolver::resolve([
                    $row->work_license,
                    // The old mapper's shouted text still carries the original licence
                    // (spaces where dashes were) — the new parser reads it.
                    $row->license === Licenses::CUSTOM ? $row->custom_license_text : null,
                    WorkLicenseResolver::journalLicense($row->journal_source_id),
                ], $row->oa_status);
            }

            if ($new['license'] === $row->license && $new['custom_license_text'] === $row->custom_license_text) {
                continue;
            }
            $key = "{$row->license} → {$new['license']}";
            $tally[$key] = ($tally[$key] ?? 0) + 1;
            $changed++;
            if ($apply) {
                $db->table('library')->where('book', $row->book)->update($new + ['updated_at' => now()]);
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
}
