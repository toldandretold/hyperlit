<?php

/**
 * GATE: every queue the app dispatches onto has a production consumer.
 *
 * A queue nobody listens on silently never runs. BuildArchiveExportJob shipped
 * on `archive-export` with the queue wired into package.json and queue:probe
 * but no Supervisor program, so on prod every "download my library" press
 * dispatched a job that never ran (2026-09-08 → 2026-11-13). The probe could
 * not see it either: it spawns its OWN workers from the same list.
 *
 * QueueTopologyProbeCommand::QUEUES is the app's declared queue list; each
 * name must appear in a `--queue=` list of a conf under deploy/supervisor/,
 * and so must every literal `onQueue('…')` in app/.
 */
function supervisorServedQueues(): array
{
    $served = [];
    foreach (glob(base_path('deploy/supervisor/*.conf')) ?: [] as $conf) {
        if (preg_match_all('/^command=.*--queue=(\S+)/m', (string) file_get_contents($conf), $m)) {
            foreach ($m[1] as $list) {
                foreach (explode(',', $list) as $queue) {
                    $served[$queue] = basename($conf);
                }
            }
        }
    }

    return $served;
}

it('has a supervisor conf for every queue in the declared topology', function () {
    $declared = (new ReflectionClassConstant(\App\Console\Commands\QueueTopologyProbeCommand::class, 'QUEUES'))->getValue();
    $missing = array_values(array_diff($declared, array_keys(supervisorServedQueues())));

    expect($missing)->toBe([], 'No deploy/supervisor/*.conf serves queue(s): ' . implode(', ', $missing)
        . ' — jobs dispatched there will never run on prod. Add a hyperlit-<name>.conf (+ workers.sh, README).');
});

it('has a supervisor conf for every literal onQueue() name in app/', function () {
    $served = supervisorServedQueues();
    $orphans = [];
    $files = new RecursiveIteratorIterator(new RecursiveDirectoryIterator(app_path(), FilesystemIterator::SKIP_DOTS));
    foreach ($files as $file) {
        if ($file->getExtension() !== 'php') {
            continue;
        }
        if (preg_match_all('/onQueue\(\s*[\'"]([a-z0-9_-]+)[\'"]\s*\)/i', (string) file_get_contents($file->getPathname()), $m)) {
            foreach (array_unique($m[1]) as $queue) {
                if (! isset($served[$queue])) {
                    $orphans[] = $queue . ' (' . str_replace(base_path() . '/', '', $file->getPathname()) . ')';
                }
            }
        }
    }

    expect($orphans)->toBe([], "onQueue() names with no production worker:\n  " . implode("\n  ", $orphans));
});
