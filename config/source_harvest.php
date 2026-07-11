<?php

return [
    // How deep the harvester follows the citation network. 1 = only the root
    // book's own citations (V1). Raising this makes the runner push each
    // newly-created auto-version book onto the frontier and scan ITS
    // bibliography too — no code change needed, but mind OCR cost.
    'max_depth' => env('SOURCE_HARVEST_MAX_DEPTH', 1),

    // Hard cap on works fetched+converted per run (snapshotted onto the
    // harvest row at trigger time). Each work can cost real money (Mistral
    // OCR is billed per page), so the cap is the blast-radius control.
    'max_works_per_run' => env('SOURCE_HARVEST_MAX_WORKS', 25),

    // Politeness gap between per-work fetch+convert cycles (seconds).
    'sleep_between_works' => env('SOURCE_HARVEST_SLEEP', 2),
];
