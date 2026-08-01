<?php

/*
|--------------------------------------------------------------------------
| Storage roots
|--------------------------------------------------------------------------
|
| The directories that hold book content. They are CONFIG, not hardcoded
| paths, for one reason: the environment must switch the files the same way it
| switches the database.
|
| The testing environment already uses its own database (my_laravel_db_test).
| It did NOT use its own directories — so a test could read the (nearly empty)
| test database, conclude that every book on disk was orphaned, and delete the
| real files. That is exactly what happened on 2026-08-01, and it cost ~14 GB
| of local dev data.
|
| Under `testing` these therefore point inside storage/framework/testing/, so a
| test that deletes everything it can see deletes only its own fixtures. Test
| database, test folders. Real database, real folders. Never crossed.
|
| Anything that SCANS OR DELETES in bulk must read these values rather than
| calling resource_path()/storage_path() directly — see StorageScanner and
| StorageReclaim, and the guard in tests/Feature/Storage/StorageRootsTest.php.
|
*/

$isTesting = env('APP_ENV') === 'testing';
$sandbox = storage_path('framework/testing/storage-roots');

return [

    'roots' => [
        'markdown' => $isTesting ? "{$sandbox}/markdown" : resource_path('markdown'),
        'books' => $isTesting ? "{$sandbox}/books" : storage_path('app/books'),
        'cache' => $isTesting ? "{$sandbox}/cache-books" : storage_path('app/cache/books'),
        'legacy_images' => $isTesting ? "{$sandbox}/public-books" : storage_path('app/public/books'),
    ],

    /*
    |--------------------------------------------------------------------------
    | Database cluster size limit
    |--------------------------------------------------------------------------
    |
    | In production Postgres is a DigitalOcean MANAGED cluster, so its bytes are
    | not droplet disk and its plan cap is not discoverable from SQL. Set this to
    | the plan's storage limit and /maintainer/storage renders the database meter
    | against it; leave it null and the page shows the size without a ceiling.
    |
    | Example: 30 GB plan → STORAGE_DB_LIMIT_BYTES=32212254720
    |
    */

    'db_limit_bytes' => env('STORAGE_DB_LIMIT_BYTES') ? (int) env('STORAGE_DB_LIMIT_BYTES') : null,

];
