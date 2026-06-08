<?php

/**
 * Standalone concurrent load probe — answers "what happens when N users hit this
 * endpoint at once?" empirically. Pure PHP + curl_multi: it boots NO test
 * framework and touches NO database, so (unlike a Pest test) it is SAFE to point
 * at a running server — it will never migrate:fresh your dev/prod DB.
 *
 *   php tests/load/loadprobe.php <url> [--levels 1,5,10,20,50] [--per-level 60] [--header "K: V"]
 *
 * Examples:
 *   # Capacity curve of a public read endpoint (watch latency + errors climb):
 *   php tests/load/loadprobe.php http://hyperlit.test/api/vibes/public
 *
 *   # Authenticated endpoint:
 *   php tests/load/loadprobe.php http://hyperlit.test/api/homepage/books \
 *       --header "Authorization: Bearer <token>"
 *
 *   # Reproduce the F12 cache-stampede (public shelf render). First make the cache
 *   # COLD on the server's DB, then burst — concurrent rebuilds collide on the
 *   # nodes unique index and some return 500:
 *   #   psql … -c "DELETE FROM nodes WHERE book = 'shelf_<id>_recent_pub';"
 *   php tests/load/loadprobe.php "http://hyperlit.test/api/public/shelves/<id>/render" --levels 1,10,25
 *
 * Output per concurrency level: requests, 2xx / 4xx / 5xx counts, p50/p95/p99/max
 * latency, and throughput. A non-zero 5xx column as concurrency climbs is the
 * "it falls over under load" signal (e.g. F12).
 */

$args = $argv;
array_shift($args); // script name

$url = null;
$levels = [1, 5, 10, 20, 50];
$perLevel = 60;
$headers = [];

for ($i = 0; $i < count($args); $i++) {
    $a = $args[$i];
    if ($a === '--levels')      { $levels = array_map('intval', explode(',', $args[++$i])); }
    elseif ($a === '--per-level') { $perLevel = max(1, (int) $args[++$i]); }
    elseif ($a === '--header')  { $headers[] = $args[++$i]; }
    elseif ($url === null)      { $url = $a; }
}

if (!$url) {
    fwrite(STDERR, "usage: php tests/load/loadprobe.php <url> [--levels 1,5,10,20] [--per-level 60] [--header \"K: V\"]\n");
    exit(2);
}

/** Fire $total requests at most $concurrency in flight; return per-request [time, code]. */
function runLevel(string $url, int $concurrency, int $total, array $headers): array
{
    $mh = curl_multi_init();
    $active = [];      // handle => start time
    $results = [];
    $launched = 0;

    $launch = function () use (&$mh, &$active, &$launched, $url, $headers) {
        $ch = curl_init($url);
        curl_setopt_array($ch, [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_TIMEOUT        => 30,
            CURLOPT_HTTPHEADER     => array_merge(['Accept: application/json'], $headers),
            CURLOPT_NOBODY         => false,
        ]);
        curl_multi_add_handle($mh, $ch);
        $active[(int) $ch] = ['ch' => $ch, 'start' => microtime(true)];
        $launched++;
    };

    // Prime the window.
    for ($i = 0; $i < min($concurrency, $total); $i++) {
        $launch();
    }

    do {
        curl_multi_exec($mh, $running);
        curl_multi_select($mh, 0.1);

        while ($done = curl_multi_info_read($mh)) {
            $ch = $done['handle'];
            $id = (int) $ch;
            $elapsed = microtime(true) - $active[$id]['start'];
            $code = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
            // curl error (timeout, connection refused) → record as 0
            if ($done['result'] !== CURLE_OK && $code === 0) {
                $code = 0;
            }
            $results[] = ['time' => $elapsed, 'code' => $code];
            curl_multi_remove_handle($mh, $ch);
            curl_close($ch);
            unset($active[$id]);

            if ($launched < $total) {
                $launch();
            }
        }
    } while ($running > 0 || !empty($active));

    curl_multi_close($mh);
    return $results;
}

function pct(array $sorted, float $q): float
{
    if (!$sorted) return 0.0;
    return $sorted[(int) floor($q * (count($sorted) - 1))];
}

echo "Load probe: {$url}\n";
echo str_repeat('─', 92) . "\n";
printf("%-7s %-7s %-7s %-7s %-7s %8s %8s %8s %8s %9s\n",
    'conc', 'reqs', '2xx', '4xx', '5xx/err', 'p50', 'p95', 'p99', 'max', 'req/s');
echo str_repeat('─', 92) . "\n";

foreach ($levels as $conc) {
    $t0 = microtime(true);
    $res = runLevel($url, $conc, $perLevel, $headers);
    $wall = microtime(true) - $t0;

    $times = array_map(fn ($r) => $r['time'], $res);
    sort($times);
    $ok = $cli = $srv = 0;
    foreach ($res as $r) {
        if ($r['code'] >= 200 && $r['code'] < 300) $ok++;
        elseif ($r['code'] >= 400 && $r['code'] < 500) $cli++;
        else $srv++; // 5xx, 0 (curl error), and anything else worth flagging
    }
    $ms = fn ($s) => sprintf('%6.0fms', $s * 1000);
    printf("%-7d %-7d %-7d %-7d %-7d %8s %8s %8s %8s %9.1f\n",
        $conc, count($res), $ok, $cli, $srv,
        $ms(pct($times, 0.50)), $ms(pct($times, 0.95)), $ms(pct($times, 0.99)),
        $ms(end($times) ?: 0), $wall > 0 ? count($res) / $wall : 0);
}

echo str_repeat('─', 92) . "\n";
echo "Rising p95/max = saturation (workers/DB/CPU). A climbing 5xx/err column = the\n";
echo "endpoint failing under concurrency (for /render & /homepage that's F12 — see\n";
echo "docs/api-restructure-findings.md#f12).\n";
