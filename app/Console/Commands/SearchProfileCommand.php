<?php

namespace App\Console\Commands;

use App\Services\SearchService;
use Illuminate\Console\Command;
use Illuminate\Support\Facades\DB;

/**
 * EXPLAIN the three production search query shapes for a given query, under the
 * app role (RLS-enforced, as requests run) and/or the admin role (BYPASSRLS) —
 * the delta between the two is the measured cost of row-level security.
 *
 * The citation + node shapes come from the SAME builders production uses
 * (SearchService::buildCitationSearchQuery / buildNodeSearchQuery), so the
 * profiled SQL cannot drift from the live queries. The library shape is a
 * deliberate small duplication — keep in sync with
 * SearchController::executeLibraryQuery.
 *
 * Read-only apart from --analyze actually executing the SELECTs (no writes).
 *
 * Examples:
 *   php artisan search:profile "marx capital" --analyze
 *   php artisan search:profile "gramsci" --analyze --role=both --creator=someuser
 *   php artisan search:profile "empire" --mode=nodes --analyze
 *
 * When do you need Elasticsearch instead of this stack? Only if, AFTER the
 * async-ingest/caching fixes: nodes grows past ~5-10M rows with node-FTS p95
 * still >300ms here; or you need typo-tolerant fuzzy matching (try pg_trgm
 * first); or faceted search / offloading search from the transactional DB.
 */
class SearchProfileCommand extends Command
{
    protected $signature = 'search:profile
        {query : The search query to profile}
        {--scope=public : sourceScope for the citation shape (public|mine|shelf)}
        {--shelf-id= : shelf id when --scope=shelf}
        {--creator= : simulate this authed username (affects visibility + RLS context)}
        {--mode=all : which shapes to profile (all|citations|library|nodes)}
        {--role=both : run as app (RLS-enforced), admin (BYPASSRLS), or both}
        {--analyze : EXPLAIN ANALYZE (executes the queries) instead of plain EXPLAIN}';

    protected $description = 'EXPLAIN the production search query shapes, with and without RLS';

    private const LIMIT = 15;

    public function handle(SearchService $search): int
    {
        $query = (string) $this->argument('query');
        $mode = (string) $this->option('mode');
        $role = (string) $this->option('role');
        $creator = $this->option('creator') ?: null;

        if (!in_array($role, ['app', 'admin', 'both'], true)) {
            $this->error("Invalid --role={$role} (app|admin|both)");
            return self::FAILURE;
        }

        $tsQuery = $search->buildTsQuery($query);
        $this->line("<info>query:</info>   {$query}");
        $this->line("<info>tsquery:</info> {$tsQuery}   <comment>(watch for cheap-to-type, expensive-to-expand prefixes like 'xx:*')</comment>");

        if ($tsQuery === '') {
            $this->warn('buildTsQuery produced an empty tsquery — nothing to profile.');
            return self::SUCCESS;
        }

        $shapes = $this->buildShapes($search, $tsQuery, $creator);
        if ($mode !== 'all') {
            $shapes = array_filter($shapes, fn ($k) => str_starts_with($k, $mode), ARRAY_FILTER_USE_KEY);
            if (empty($shapes)) {
                $this->error("Unknown --mode={$mode} (all|citations|library|nodes)");
                return self::FAILURE;
            }
        }

        $roles = $role === 'both' ? ['app', 'admin'] : [$role];
        $summary = [];

        foreach ($shapes as $label => [$sql, $params]) {
            $this->newLine();
            $this->line("<info>━━ {$label} ━━</info>");
            foreach ($roles as $r) {
                $plan = $this->explain($r, $sql, $params, $creator);
                $summary[$label][$r] = $plan['execution_ms'];
                $this->line("  <comment>[{$r}]</comment> planning={$plan['planning_ms']}ms execution={$plan['execution_ms']}ms");
                if ($this->output->isVerbose()) {
                    foreach ($plan['lines'] as $line) {
                        $this->line('    ' . $line);
                    }
                }
            }
            if (!$this->output->isVerbose()) {
                $this->line('  <comment>(-v to print full plans)</comment>');
            }
        }

        if (count($roles) === 2 && $this->option('analyze')) {
            $this->newLine();
            $this->line('<info>━━ RLS cost (app vs admin execution time) ━━</info>');
            foreach ($summary as $label => $times) {
                $app = $times['app'];
                $admin = $times['admin'];
                if ($app === null || $admin === null || $admin <= 0.0) {
                    continue;
                }
                $pct = round((($app - $admin) / max($admin, 0.001)) * 100);
                $this->line(sprintf('  %-28s app=%sms admin=%sms  → RLS overhead %+d%%', $label, $app, $admin, $pct));
            }
        }

        return self::SUCCESS;
    }

    /**
     * @return array<string, array{0: string, 1: array}>
     */
    private function buildShapes(SearchService $search, string $tsQuery, ?string $creator): array
    {
        $scope = (string) $this->option('scope');
        $shelfId = $this->option('shelf-id') ?: null;

        $shapes = [
            'citations (hybrid)' => $search->buildCitationSearchQuery($tsQuery, self::LIMIT, 0, $scope, $creator, $shelfId),
        ];

        // Library shape — keep in sync with SearchController::executeLibraryQuery
        // (legacy public visibility; profiling the anonymous-public common case).
        $shapes['library (title/author)'] = [
            "SELECT
                book, title, author, bibtex, has_nodes,
                ts_rank('{0.05, 0.1, 0.3, 1.0}', search_vector, to_tsquery('simple', ?)) as relevance,
                ts_headline('simple',
                    COALESCE(title, '') || ' ' || COALESCE(author, '') || ' ' ||
                    COALESCE(booktitle, '') || ' ' || COALESCE(chapter, '') || ' ' ||
                    COALESCE(editor, '') || ' ' || COALESCE(year, ''),
                    to_tsquery('simple', ?),
                    'StartSel=<mark>, StopSel=</mark>, MaxWords=50, MinWords=20'
                ) as headline
            FROM library
            WHERE search_vector @@ to_tsquery('simple', ?)
                AND book NOT LIKE '%/%'
                AND (listed = true AND visibility NOT IN ('private', 'deleted'))
            ORDER BY relevance DESC
            LIMIT ?",
            [$tsQuery, $tsQuery, $tsQuery, self::LIMIT],
        ];

        $shapes['nodes (exact/simple)'] = $search->buildNodeSearchQuery($tsQuery, 'simple', 'search_vector_simple', self::LIMIT, $creator, null);
        $shapes['nodes (stemmed/english)'] = $search->buildNodeSearchQuery($tsQuery, 'english', 'search_vector', self::LIMIT, $creator, null);

        return $shapes;
    }

    /**
     * @return array{planning_ms: ?float, execution_ms: ?float, lines: string[]}
     */
    private function explain(string $role, string $sql, array $params, ?string $creator): array
    {
        $connection = $role === 'admin' ? DB::connection('pgsql_admin') : DB::connection();

        if ($role === 'app') {
            // Replay what SetDatabaseSessionContext does per request so the RLS
            // policies see the same session context a real request would.
            $userToken = '';
            if ($creator) {
                $userToken = (string) (DB::connection('pgsql_admin')
                    ->table('users')->where('name', $creator)->value('user_token') ?? '');
            }
            $connection->statement(
                "SELECT set_config('app.current_user', ?, false), set_config('app.current_token', ?, false), set_config('app.session_id', ?, false)",
                [$creator ?? '', $userToken, '']
            );
        }

        $verb = $this->option('analyze') ? 'EXPLAIN (ANALYZE, BUFFERS, VERBOSE)' : 'EXPLAIN (VERBOSE)';
        $rows = $connection->select("{$verb} {$sql}", $params);

        $lines = array_map(fn ($r) => $r->{'QUERY PLAN'}, $rows);
        $pick = function (string $prefix) use ($lines): ?float {
            foreach ($lines as $line) {
                if (str_starts_with($line, $prefix)) {
                    return (float) trim(str_replace([$prefix, 'ms'], '', $line));
                }
            }
            return null;
        };

        return [
            'planning_ms' => $pick('Planning Time:'),
            'execution_ms' => $pick('Execution Time:'),
            'lines' => $lines,
        ];
    }
}
