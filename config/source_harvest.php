<?php

return [
    // Default depth when a caller doesn't specify one. Depth is how far the
    // harvester follows the citation network: 1 = only the root book's own
    // citations; 2 = also the works THOSE cite; etc. The runner walks the
    // frontier outward, so any depth works with no code change.
    'max_depth' => env('SOURCE_HARVEST_MAX_DEPTH', 1),

    // Sentinel stored in max_depth for the "unlimited" choice — recurse until
    // the frontier dries up (bounded in practice by open-access availability
    // and the work cap below). Kept under the signed-smallint ceiling (32767).
    'unlimited_depth' => 30000,

    // Hard cap on works fetched+converted per run for the shallow default
    // (depth 1), snapshotted onto the harvest row at trigger time. Each work
    // can cost real money (Mistral OCR is billed per page), so the cap is the
    // blast-radius control.
    'max_works_per_run' => env('SOURCE_HARVEST_MAX_WORKS', 25),

    // Per-run work cap for deep / unlimited harvests — larger, since the whole
    // point is to pull the reachable network. Still a ceiling so a runaway
    // network can't run forever.
    'max_works_deep' => env('SOURCE_HARVEST_MAX_WORKS_DEEP', 500),

    // Politeness gap between per-work fetch+convert cycles (seconds).
    'sleep_between_works' => env('SOURCE_HARVEST_SLEEP', 2),
];
