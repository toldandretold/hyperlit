<?php

/**
 * collect.php — the PHP/Laravel backend collector for the full-stack data-flow map.
 *
 * The JS side (visualisation/js/collect.ts) maps DOM ↔ TS ↔ IndexedDB ↔ API route ↔ Postgres
 * table. This script adds the tier the route boxes only gesture at: the Laravel **controllers**
 * that actually read/write those tables. It is the PHP-AST analogue of collect.ts — pure static
 * analysis via nikic/php-parser (already vendored, v5, transitive through laravel/tinker), with
 * NO Laravel boot and NO database. Deterministic (no time/random), so the emitted JSON byte-checks.
 *
 * It emits visualisation/generated/backend.generated.json (the `BackendGraph` contract in
 * ../merge.ts): controller nodes keyed by Class@method, each carrying its normalized endpoint
 * URL(s), the Postgres tables it touches, its data-flow direction, and the row-shape it builds;
 * plus controller→pg:<table> edges. collect.ts reads this and stitches it onto the matching
 * `route:<url>` nodes — see ../js/collect.ts (mergeBackendTier) + ../README.md.
 *
 * Run: `php visualisation/php/collect.php`  (chained ahead of the JS regen by `npm run viz:idb`).
 *
 * Table attribution is DERIVED, not guessed: model→table comes from each Pg* model's `$table`,
 * and raw `DB::table('x')` / `INSERT INTO x` literals are read straight from the AST.
 */

use PhpParser\Node;
use PhpParser\ParserFactory;

require __DIR__ . '/../../vendor/autoload.php';

const REPO_ROOT  = __DIR__ . '/../..';
const OUT_PATH   = __DIR__ . '/../generated/backend.generated.json';

// routes/api.php is mounted under the `api` prefix by app/Providers/RouteServiceProvider.php.
const API_PREFIX = '/api';

// The data spine only — keep the backend tier to the controllers that move book/annotation data,
// mirroring the JS side's data-layer scope. Other controllers (auth, billing, search, …) are
// deliberately out of scope (see ../README.md "Deferred").
const CONTROLLER_ALLOW = '/^(Db[A-Za-z]+Controller|DatabaseToIndexedDBController|UnifiedSyncController|BeaconSyncController)$/';

// Row-shape heuristic: an array literal is "the data row" if it carries one of these keys.
const ROW_MARKER_KEYS = ['content', 'chunk_id', 'hyperlight_id', 'hyperciteId', 'referenceId', 'footnoteId', 'startLine', 'title'];

/* ───────────────────────── generic AST helpers ───────────────────────── */

/** Depth-first walk over every descendant Node, invoking $fn on each. */
function walk(Node $node, callable $fn): void
{
    $fn($node);
    foreach ($node->getSubNodeNames() as $name) {
        $sub = $node->$name;
        foreach (is_array($sub) ? $sub : [$sub] as $child) {
            if ($child instanceof Node) {
                walk($child, $fn);
            }
        }
    }
}

/** Short class name from a Name node (last namespace segment). */
function shortName(?Node $class): ?string
{
    if (!$class instanceof Node\Name) {
        return null;
    }
    $parts = $class->getParts();
    return end($parts) ?: null;
}

/** A method/static call's name as a plain string, or null if dynamic. */
function callName(Node $call): ?string
{
    return ($call->name instanceof Node\Identifier) ? $call->name->toString() : null;
}

/** First argument as a literal string, or null. */
function firstStringArg(Node $call): ?string
{
    $arg = $call->args[0] ?? null;
    if ($arg instanceof Node\Arg && $arg->value instanceof Node\Scalar\String_) {
        return $arg->value->value;
    }
    return null;
}

/* ───────────────────────── 1. model → table map ───────────────────────── */

/** Parse app/Models/Pg*.php and read each class's `protected $table = '…'`. */
function buildModelTableMap($parser): array
{
    $map = [];
    foreach (glob(REPO_ROOT . '/app/Models/Pg*.php') as $file) {
        $ast = $parser->parse(file_get_contents($file)) ?? [];
        foreach ($ast as $node) {
            walk($node, function (Node $n) use (&$map) {
                if (!$n instanceof Node\Stmt\Class_ || !$n->name) {
                    return;
                }
                $class = $n->name->toString();
                foreach ($n->stmts as $stmt) {
                    if (!$stmt instanceof Node\Stmt\Property) {
                        continue;
                    }
                    foreach ($stmt->props as $prop) {
                        if ($prop->name->toString() === 'table'
                            && $prop->default instanceof Node\Scalar\String_) {
                            $map[$class] = $prop->default->value;
                        }
                    }
                }
            });
        }
    }
    return $map;
}

/* ───────────────────────── 2. route → handler map ───────────────────────── */

const ROUTE_VERBS = ['get', 'post', 'put', 'patch', 'delete', 'options', 'any'];

/**
 * Walk routes/api.php, tracking the prefix() stack across nested Route::prefix()->group()
 * blocks, and collect { uri, verb, controller, method } for every route registration.
 */
function collectRoutes($parser): array
{
    $routes = [];
    $ast = $parser->parse(file_get_contents(REPO_ROOT . '/routes/api.php')) ?? [];
    walkRouteStmts($ast, [], $routes);
    return $routes;
}

/** Unwrap a fluent chain (->name()->where()->group()) into its ordered list of calls + the root static call. */
function chainCalls(Node $expr): array
{
    $calls = [];
    $cur = $expr;
    while ($cur instanceof Node\Expr\MethodCall) {
        array_unshift($calls, $cur);
        $cur = $cur->var;
    }
    // $cur is now the root — a StaticCall (Route::prefix(...) / Route::get(...)) or other.
    return [$cur, $calls];
}

function walkRouteStmts(array $stmts, array $prefix, array &$routes): void
{
    foreach ($stmts as $stmt) {
        $expr = $stmt instanceof Node\Stmt\Expression ? $stmt->expr : $stmt;
        if (!$expr instanceof Node) {
            continue;
        }
        [$root, $calls] = chainCalls($expr);

        // ── group construct: Route::prefix('x')->middleware(..)->group(closure) ──
        $groupCall = null;
        foreach ($calls as $c) {
            if (callName($c) === 'group') {
                $groupCall = $c;
            }
        }
        $isRouteRoot = $root instanceof Node\Expr\StaticCall
            && shortName($root->class) === 'Route';

        if ($groupCall && $isRouteRoot) {
            // Gather any prefix() segments declared in the chain (root + method calls).
            $added = [];
            if (callName($root) === 'prefix' && ($p = firstStringArg($root)) !== null) {
                $added[] = $p;
            }
            foreach ($calls as $c) {
                if (callName($c) === 'prefix' && ($p = firstStringArg($c)) !== null) {
                    $added[] = $p;
                }
            }
            $closure = $groupCall->args[0]->value ?? null;
            $body = $closure instanceof Node\Expr\Closure ? $closure->stmts
                : ($closure instanceof Node\Expr\ArrowFunction ? [$closure->expr] : []);
            walkRouteStmts($body, array_merge($prefix, $added), $routes);
            continue;
        }

        // ── route registration: Route::get('uri', [Ctrl::class,'method'])->… ──
        if ($isRouteRoot && in_array(callName($root), ROUTE_VERBS, true)) {
            $uri = firstStringArg($root);
            $handler = $root->args[1]->value ?? null;
            $reg = parseHandler($handler);
            if ($uri !== null && $reg) {
                $routes[] = [
                    'verb'       => callName($root),
                    'uri'        => normalizeUri($prefix, $uri),
                    'controller' => $reg[0],
                    'method'     => $reg[1],
                ];
            }
        }
    }
}

/** [Ctrl::class, 'method'] → ['Ctrl', 'method']. */
function parseHandler(?Node $handler): ?array
{
    if (!$handler instanceof Node\Expr\Array_ || count($handler->items) < 2) {
        return null;
    }
    $classItem = $handler->items[0]->value ?? null;
    $methodItem = $handler->items[1]->value ?? null;
    if (!$classItem instanceof Node\Expr\ClassConstFetch
        || !$methodItem instanceof Node\Scalar\String_) {
        return null;
    }
    return [shortName($classItem->class), $methodItem->value];
}

/** Join the api prefix + group prefixes + the route uri, collapse slashes, normalize {param}→{}. */
function normalizeUri(array $prefix, string $uri): string
{
    $path = API_PREFIX . '/' . implode('/', array_merge($prefix, [$uri]));
    $path = preg_replace('#/+#', '/', $path);              // collapse duplicate slashes
    $path = rtrim($path, '/');                              // no trailing slash
    return preg_replace('#\{[^}]+\}#', '{}', $path);        // {bookId} → {}  (matches the JS key)
}

/* ───────────────────────── 3. per-method data-flow ───────────────────────── */

/**
 * Parse one controller file into a per-method summary:
 *   methodName → { tables: set, write: bool, calls: set(privateMethodNames), shape: [keys] }
 * Tables come from DB::table('x') / join literals, Pg model statics, and raw SQL strings.
 */
function analyzeController(string $file, $parser, array $modelTable): array
{
    $methods = [];
    $ast = $parser->parse(file_get_contents($file)) ?? [];
    foreach ($ast as $node) {
        walk($node, function (Node $n) use (&$methods, $modelTable) {
            if (!$n instanceof Node\Stmt\ClassMethod || !$n->stmts) {
                return;
            }
            $name = $n->name->toString();
            $tables = [];
            $write = false;
            $calls = [];
            $shape = [];

            foreach ($n->stmts as $s) {
                walk($s, function (Node $b) use (&$tables, &$write, &$calls, &$shape, $modelTable) {
                    // intra-class private-helper calls: $this->getHyperlights(...)
                    if ($b instanceof Node\Expr\MethodCall
                        && $b->var instanceof Node\Expr\Variable
                        && $b->var->name === 'this'
                        && ($m = callName($b))) {
                        $calls[$m] = true;
                    }

                    // DB::table('x') / ->table('x') / ->join('x',…) / ->from('x')
                    if (($b instanceof Node\Expr\MethodCall || $b instanceof Node\Expr\StaticCall)
                        && in_array(callName($b), ['table', 'from', 'join', 'leftJoin', 'rightJoin'], true)
                        && ($t = firstStringArg($b)) !== null) {
                        $tables[$t] = true;
                    }

                    // Pg model statics: PgNode::insert(…) etc.
                    if ($b instanceof Node\Expr\StaticCall) {
                        $cls = shortName($b->class);
                        if ($cls && isset($modelTable[$cls])) {
                            $tables[$modelTable[$cls]] = true;
                            if (isWriteCall(callName($b))) {
                                $write = true;
                            }
                        }
                    }

                    // write verbs on query-builder / model instances + raw SQL
                    if ($b instanceof Node\Expr\MethodCall && isWriteCall(callName($b))) {
                        $write = true;
                    }
                    foreach (rawSqlTables($b) as $t) {
                        $tables[$t['table']] = true;
                        if ($t['write']) {
                            $write = true;
                        }
                    }

                    // row-shape: keys of an array literal that looks like a data row. Rank by how many
                    // ROW_MARKER keys it carries (then total keys) so a 4-marker node row beats a long
                    // metadata array that only happens to include `title`.
                    if ($b instanceof Node\Expr\Array_) {
                        $keys = arrayStringKeys($b);
                        if (shapeRank($keys) > shapeRank($shape)) {
                            $shape = $keys;
                        }
                    }
                });
            }

            $methods[$name] = [
                'tables' => array_keys($tables),
                'write'  => $write,
                'calls'  => array_keys($calls),
                'shape'  => $shape,
            ];
        });
    }
    return $methods;
}

function isWriteCall(?string $name): bool
{
    return in_array($name, [
        'insert', 'update', 'updateOrCreate', 'updateOrInsert', 'create', 'firstOrCreate',
        'delete', 'save', 'insertOrIgnore', 'upsert', 'statement',
    ], true);
}

/** Extract table names from a raw-SQL string argument of DB::statement/insert/update/delete/select. */
function rawSqlTables(Node $b): array
{
    if (!($b instanceof Node\Expr\StaticCall || $b instanceof Node\Expr\MethodCall)) {
        return [];
    }
    if (!in_array(callName($b), ['statement', 'insert', 'update', 'delete', 'select', 'raw'], true)) {
        return [];
    }
    $sql = firstStringArg($b);
    if ($sql === null) {
        return [];
    }
    $out = [];
    if (preg_match_all('/INSERT\s+INTO\s+"?(\w+)"?/i', $sql, $m)) {
        foreach ($m[1] as $t) { $out[] = ['table' => $t, 'write' => true]; }
    }
    if (preg_match_all('/UPDATE\s+"?(\w+)"?/i', $sql, $m)) {
        foreach ($m[1] as $t) { $out[] = ['table' => $t, 'write' => true]; }
    }
    if (preg_match_all('/DELETE\s+FROM\s+"?(\w+)"?/i', $sql, $m)) {
        foreach ($m[1] as $t) { $out[] = ['table' => $t, 'write' => true]; }
    }
    if (preg_match_all('/\bFROM\s+"?(\w+)"?/i', $sql, $m)) {
        foreach ($m[1] as $t) { $out[] = ['table' => $t, 'write' => false]; }
    }
    return $out;
}

/** Rank an array-literal's keys as a data row: marker-keys dominate, total keys break ties. */
function shapeRank(array $keys): int
{
    $markers = count(array_intersect($keys, ROW_MARKER_KEYS));
    return $markers * 1000 + count($keys);   // never any row with >1000 keys
}

/** String keys of an array literal (skips spread / int / dynamic keys). */
function arrayStringKeys(Node\Expr\Array_ $arr): array
{
    $keys = [];
    foreach ($arr->items as $item) {
        if ($item instanceof Node\Expr\ArrayItem && $item->key instanceof Node\Scalar\String_) {
            $keys[] = $item->key->value;
        }
    }
    sort($keys);
    return array_values(array_unique($keys));
}

/** tables for a method, following same-class private helper calls (transitive, cycle-guarded). */
function tablesFor(string $method, array $methods, array &$seen = []): array
{
    if (isset($seen[$method]) || !isset($methods[$method])) {
        return [];
    }
    $seen[$method] = true;
    $tables = $methods[$method]['tables'];
    foreach ($methods[$method]['calls'] as $callee) {
        $tables = array_merge($tables, tablesFor($callee, $methods, $seen));
    }
    return array_values(array_unique($tables));
}

/**
 * The data row-shape a method produces — the longest marker-bearing array literal it (or a
 * same-class helper it calls) builds. getBookData builds the row inside getNodes*(), so the
 * shape only surfaces by following the private-helper calls (as with tables).
 */
function shapeFor(string $method, array $methods, array &$seen = []): array
{
    if (isset($seen[$method]) || !isset($methods[$method])) {
        return [];
    }
    $seen[$method] = true;
    $best = $methods[$method]['shape'];
    foreach ($methods[$method]['calls'] as $callee) {
        $s = shapeFor($callee, $methods, $seen);
        if (shapeRank($s) > shapeRank($best)) {
            $best = $s;
        }
    }
    return $best;
}

/* ───────────────────────── 4. assemble ───────────────────────── */

/**
 * The display class IS the real controller class name (the file under app/Http/Controllers/), so a
 * reader can jump straight to the code. No abbreviation — discoverability is the whole point.
 */
function displayClass(string $cls): string
{
    return $cls;
}

/**
 * Build the whole backend graph (nodes/edges/endpointToController/modelTable). Pure — no I/O —
 * so the byte-gate test (tests/Unit/Visualisation/BackendFlowmapTest.php) can `require` this file
 * and call it directly, with no shelling out.
 */
function buildBackendMap(): array
{
    $parser = (new ParserFactory())->createForNewestSupportedVersion();
    $modelTable = buildModelTableMap($parser);
    $routes = collectRoutes($parser);

    // route methods grouped by controller, restricted to the data-spine allowlist
    $byController = [];
    foreach ($routes as $r) {
        if (!preg_match(CONTROLLER_ALLOW, $r['controller'])) {
            continue;
        }
        $byController[$r['controller']][] = $r;
    }
    ksort($byController);

    $nodes = [];
    $edges = [];
    $endpointToController = [];

    foreach ($byController as $controller => $rs) {
        $file = REPO_ROOT . '/app/Http/Controllers/' . $controller . '.php';
        if (!is_file($file)) {
            continue;
        }
        $methods = analyzeController($file, $parser, $modelTable);

        // collapse routes to unique controller methods (a method may serve >1 uri)
        $perMethod = [];
        foreach ($rs as $r) {
            $perMethod[$r['method']]['verbs'][$r['verb']] = true;
            $perMethod[$r['method']]['uris'][$r['uri']] = true;
        }
        ksort($perMethod);

        foreach ($perMethod as $method => $info) {
            $id = "controller:{$controller}@{$method}";
            // direction from HTTP verb: GET = pull (load), write verbs = push (save).
            $dir = isset($info['verbs']['get']) && count($info['verbs']) === 1 ? 'pull' : 'push';
            $tables = tablesFor($method, $methods);
            sort($tables);
            $uris = array_keys($info['uris']);
            sort($uris);

            $nodes[] = [
                'id'         => $id,
                'label'      => displayClass($controller) . '@' . $method,
                'kind'       => 'controller',
                'dir'        => $dir,
                'controller' => $controller,
                'method'     => $method,
                'tables'     => $tables,
                'shape'      => shapeFor($method, $methods),
                'endpoints'  => $uris,
            ];

            foreach ($tables as $t) {
                $edges[] = [
                    'source' => $dir === 'pull' ? "pg:$t" : $id,
                    'target' => $dir === 'pull' ? $id : "pg:$t",
                    'rel'    => $dir === 'pull' ? 'read' : 'write',
                ];
            }
            foreach ($uris as $u) {
                $endpointToController[$u] = $id;
            }
        }
    }

    // deterministic ordering for the byte-gate
    usort($nodes, fn ($a, $b) => strcmp($a['id'], $b['id']));
    usort($edges, fn ($a, $b) => strcmp($a['source'] . '>' . $a['target'] . $a['rel'], $b['source'] . '>' . $b['target'] . $b['rel']));
    $edges = array_values(array_map('unserialize', array_unique(array_map('serialize', $edges))));
    ksort($endpointToController);

    return [
        'generatedBy'          => 'visualisation/php/collect.php',
        'note'                 => 'Static php-parser analysis of routes/api.php + Db* + DatabaseToIndexedDB controllers. Table attribution derived from Pg* $table + DB::table/raw-SQL literals. Do not edit by hand — run `php visualisation/php/collect.php` (chained by `npm run viz:idb`).',
        'modelTable'           => $modelTable,
        'nodes'                => $nodes,
        'edges'                => $edges,
        'endpointToController' => $endpointToController,
    ];
}

/** Canonical JSON serialization of the backend map (single source of truth for file + stdout + gate). */
function backendMapJson(): string
{
    return json_encode(buildBackendMap(), JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES) . "\n";
}

/* ───────────────────────── 5. CLI entry (only when run directly) ───────────────────────── */

if (realpath($_SERVER['SCRIPT_FILENAME'] ?? '') === realpath(__FILE__)) {
    $json = backendMapJson();
    if (in_array('--stdout', $argv ?? [], true)) {
        echo $json;
    } else {
        $map = json_decode($json, true);
        file_put_contents(OUT_PATH, $json);
        fwrite(STDERR, sprintf(
            "✅ backend flow map — %d controller nodes, %d edges\n   %s\n",
            count($map['nodes']),
            count($map['edges']),
            realpath(OUT_PATH) ?: OUT_PATH
        ));
    }
}
