<?php

/*
|--------------------------------------------------------------------------
| Reading telemetry retention
|--------------------------------------------------------------------------
|
| Raw book_reads / page_views rows carry an identity (user_name or
| anon_token). telemetry:rollup folds rows older than this many days into
| the de-identified rollup tables and deletes them — the privacy page's
| "aggregated and de-identified after N days" promise reads THIS value, so
| changing it means updating docs/privacy-page.md (and the live /privacy
| book) too.
|
| Floor: must stay comfortably above 30 — the creator/maintainer "views this
| month" windows read RAW rows only (their window is inside retention by
| design). The command refuses values below 31.
|
*/

return [
    'raw_retention_days' => (int) env('TELEMETRY_RAW_RETENTION_DAYS', 90),
];
