<?php

use Illuminate\Http\Request;
use Illuminate\Support\Facades\Route;

use App\Http\Controllers\DbNodeController;
use App\Http\Controllers\SubBookController;
use App\Http\Controllers\DbHyperlightController;
use App\Http\Controllers\DbHyperciteController;
use App\Http\Controllers\DbLibraryController;
use App\Http\Controllers\DatabaseToIndexedDBController;
use App\Http\Controllers\HomePageServerController;
use App\Http\Controllers\BeaconSyncController;
use App\Http\Controllers\DbReferencesController;
use App\Http\Controllers\DbFootnoteController;
use App\Http\Controllers\AuthController;
use App\Http\Controllers\UnifiedSyncController;
use App\Http\Controllers\SearchController;
use App\Http\Controllers\NodeHistoryController;
use App\Http\Controllers\OpenAlexController;
use App\Http\Controllers\CitationScannerController;
use App\Http\Controllers\ImportController;
use App\Http\Controllers\BillingController;
use App\Http\Controllers\StripeController;
use App\Http\Controllers\UserHomeServerController;
use App\Http\Controllers\AiBrainController;
use App\Http\Controllers\VibeCSSController;
use App\Http\Controllers\InferenceTicketController;
use App\Http\Controllers\VibeConvertController;
use App\Http\Controllers\UserPreferencesController;
use App\Http\Controllers\VibesController;
use App\Http\Controllers\IntegrityReportController;
use App\Http\Controllers\ScrapeController;
use App\Http\Controllers\ShelfController;
use App\Http\Controllers\PasskeyController;
use App\Http\Controllers\E2eeVaultController;


// Import progress polling — lightweight, no auth needed (bookId is unguessable)
Route::get('/import-progress/{bookId}', [ImportController::class, 'importProgress'])
    ->where('bookId', '[a-zA-Z0-9_-]+')
    ->middleware('throttle:120,1');

// Opt-in email notification for imports
Route::post('/import-progress/{bookId}/notify', [ImportController::class, 'requestEmailNotification'])
    ->where('bookId', '[a-zA-Z0-9_-]+')
    ->middleware('throttle:10,1');

// Stripe webhook — must be outside auth (Stripe calls it directly)
Route::post('/stripe/webhook', [StripeController::class, 'handleWebhook']);

// Public routes with rate limiting to prevent brute force and spam.
//
// In the LOCAL env — the Herd-served e2e target (http://hyperlit.test) — a single
// full e2e run legitimately registers + logs in ~20 throwaway users from one IP
// (stripe/security/e2ee specs). That blows the production per-IP window and makes
// the suite non-deterministic: `/register` 429s outright (stored-xss-poc) and the
// billing helper's 62s Retry-After backoff overruns the 30s test timeout
// (stripe/spend-gates). Relax the window in `local` ONLY — production keeps the
// strict anti-brute-force limit, and PHPUnit (APP_ENV=testing) still exercises the
// real numbers in tests/Feature/Security/RateLimitingTest.php.
$isLocal = app()->environment('local');
$loginThrottle = $isLocal ? 'throttle:1000,1' : 'throttle:20,1';
$registerThrottle = $isLocal ? 'throttle:1000,1' : 'throttle:10,1';

Route::post('/login', [AuthController::class, 'login'])
    ->middleware($loginThrottle) // 20/min in prod; relaxed in local for the e2e suite
    ->name('login');

Route::post('/register', [AuthController::class, 'register'])
    ->middleware($registerThrottle); // 10/min in prod; relaxed in local for the e2e suite

// Search routes - public access with rate limiting
Route::prefix('search')->middleware('throttle:60,1')->group(function () {
    Route::get('/library', [SearchController::class, 'searchLibrary']);
    Route::get('/nodes', [SearchController::class, 'searchNodes']);
    Route::get('/openalex', [OpenAlexController::class, 'search']);
    Route::get('/combined', [SearchController::class, 'searchWithOpenAlex']);
});

// Canonical-source resolver used by the bibliography click handler to find the
// best library version (or surface a citation-only card when no version exists).
Route::get('/canonical/{id}/best-version', [App\Http\Controllers\CanonicalSourceController::class, 'bestVersion'])
    ->middleware('throttle:120,1')
    ->where('id', '[0-9a-f-]{36}');

// OpenAlex: save a work as a library stub — no auth required (anonymous users can cite too)
Route::post('/openalex/save-to-library', [OpenAlexController::class, 'saveToLibrary'])
    ->middleware('throttle:10,1');

// OpenAlex citation lookup — requires authentication
Route::middleware('auth:sanctum')->group(function () {
    Route::post('/openalex/lookup-citation', [OpenAlexController::class, 'lookupCitation']);

    // Billing
    Route::get('/billing/balance', [BillingController::class, 'balance']);
    Route::get('/billing/ledger', [BillingController::class, 'ledger']);
    Route::get('/billing/ledger/{id}', [BillingController::class, 'show'])->whereUuid('id');
    Route::post('/billing/credits', [BillingController::class, 'addCredits']);
    Route::post('/billing/checkout', [StripeController::class, 'createCheckoutSession']);
    Route::post('/billing/tier', [UserHomeServerController::class, 'updateTier']);

    // User home sorted rendering
    Route::post('/user-home/render', [UserHomeServerController::class, 'renderSorted']);

    // Citation scanner
    Route::post('/citation-scanner/scan', [CitationScannerController::class, 'scan']);
    Route::get('/citation-scanner/status/{scanId}', [CitationScannerController::class, 'status'])->whereUuid('scanId');
    Route::get('/citation-scanner/history/{book}', [CitationScannerController::class, 'history']);
    Route::post('/citation-pipeline/trigger', [CitationScannerController::class, 'triggerPipeline']);
    Route::get('/citation-pipeline/status/{pipelineId}', [CitationScannerController::class, 'pipelineStatus'])->whereUuid('pipelineId');
    Route::get('/citation-pipeline/running/{book}', [CitationScannerController::class, 'pipelineRunning']);
    Route::post('/citation-pipeline/resume/{pipelineId}', [CitationScannerController::class, 'resumePipeline'])->whereUuid('pipelineId');
    Route::get('/citation-pipeline/map', [CitationScannerController::class, 'pipelineMap']);

    // AI Brain
    Route::post('/ai-brain/query', [AiBrainController::class, 'query']);
    Route::get('/ai-brain/status/{highlightId}', [AiBrainController::class, 'status']);

    // Vibe CSS
    Route::post('/vibe-css/generate', [VibeCSSController::class, 'generate']);
    Route::post('/vibe-css/complete', [VibeCSSController::class, 'complete']);
    Route::get('/vibe-css/can-proceed', [VibeCSSController::class, 'canProceed']);

    // BYO-key inference tickets — the native client claims parked prompts, runs
    // them with the user's own key, and posts completions back.
    Route::post('/inference/claim', [InferenceTicketController::class, 'claim']);
    Route::post('/inference/{id}/complete', [InferenceTicketController::class, 'complete'])->whereUuid('id');

    // Vibe Conversion — per-document LLM re-conversion (background job + poll + cancel + accept)
    Route::post('/vibe-convert/start', [VibeConvertController::class, 'start']);
    Route::get('/vibe-convert/progress/{book}', [VibeConvertController::class, 'progress']);
    Route::post('/vibe-convert/cancel/{book}', [VibeConvertController::class, 'cancel']);
    Route::post('/vibe-convert/use-now/{book}', [VibeConvertController::class, 'useNow']);
    Route::post('/vibe-convert/notify/{book}', [VibeConvertController::class, 'notify']);
    Route::post('/vibe-convert/accept', [VibeConvertController::class, 'accept']);
    // Post-auto-apply review: the reader polls review/{book} on load; keep clears it, reject reverts.
    Route::get('/vibe-convert/review/{book}', [VibeConvertController::class, 'review']);
    Route::post('/vibe-convert/review/{book}/keep', [VibeConvertController::class, 'keepReview']);
    Route::post('/vibe-convert/review/{book}/reject', [VibeConvertController::class, 'rejectReview']);

    // Book audio (per-node TTS) — the WRITE half: generate is requester-pays,
    // cancel is owner/requester-side. Reads (status/progress/manifest) live in
    // the public throttled block below — anonymous readers of a public book
    // play audio too; RLS gates visibility either way.
    Route::post('/book-audio/{book}/generate', [\App\Http\Controllers\BookAudioController::class, 'generate']);
    Route::post('/book-audio/{book}/cancel', [\App\Http\Controllers\BookAudioController::class, 'cancel']);

    // User preferences
    Route::get('/user/preferences', [UserPreferencesController::class, 'show']);
    Route::post('/user/preferences', [UserPreferencesController::class, 'update']);

    // Saved vibes
    Route::get('/vibes/mine', [VibesController::class, 'mine']);
    Route::post('/vibes', [VibesController::class, 'store']);
    // F11: constrain UUID params so a malformed id 404s (route miss) instead of
    // reaching the controller and 500ing on a Postgres uuid cast error.
    Route::patch('/vibes/{id}', [VibesController::class, 'update'])->whereUuid('id');
    Route::delete('/vibes/{id}', [VibesController::class, 'destroy'])->whereUuid('id');

    // Shelves — whereUuid('id') on the group constrains the {id} routes; the
    // {shelfKey} (shelf:uuid) and {book} routes are unaffected (F11).
    Route::prefix('shelves')->whereUuid('id')->group(function () {
        Route::get('/', [ShelfController::class, 'index']);
        Route::post('/', [ShelfController::class, 'store']);
        Route::patch('/{id}', [ShelfController::class, 'update']);
        Route::delete('/{id}', [ShelfController::class, 'destroy']);
        Route::post('/{id}/items', [ShelfController::class, 'addItem']);
        Route::delete('/{id}/items/{book}', [ShelfController::class, 'removeItem']);
        Route::post('/{shelfKey}/pins', [ShelfController::class, 'pin']);
        Route::delete('/{shelfKey}/pins/{book}', [ShelfController::class, 'unpin']);
        Route::get('/{id}/render', [ShelfController::class, 'render']);
        Route::get('/{id}/search', [ShelfController::class, 'search']);
    });
});

// Public shelf endpoints — no auth, throttled
Route::prefix('public/shelves')->middleware('throttle:60,1')->whereUuid('id')->group(function () {
    Route::get('/{id}/render', [ShelfController::class, 'publicRender']);
    Route::get('/{id}/search', [ShelfController::class, 'publicSearch']);
});

// Public system shelf endpoints — no auth, throttled
Route::prefix('public/library')->middleware('throttle:60,1')->group(function () {
    Route::get('/{username}/render', [UserHomeServerController::class, 'publicRenderSorted']);
    Route::get('/{username}/search', [ShelfController::class, 'publicSystemSearch']);
});

// Public vibes gallery — no auth, throttled
Route::get('/vibes/public', [VibesController::class, 'publicIndex'])
    ->middleware('throttle:60,1');

// Book audio reads — no auth (RLS decides what's visible), throttled
Route::middleware('throttle:120,1')->where(['book' => '[a-zA-Z0-9_-]+'])->group(function () {
    Route::get('/book-audio/{book}/status', [\App\Http\Controllers\BookAudioController::class, 'status']);
    Route::get('/book-audio/{book}/progress', [\App\Http\Controllers\BookAudioController::class, 'progress']);
    Route::get('/book-audio/{book}/manifest', [\App\Http\Controllers\BookAudioController::class, 'manifest']);
});

// Password reset routes (throttled to prevent abuse)
Route::post('/password/forgot', [AuthController::class, 'forgotPassword'])
    ->middleware('throttle:5,1');
Route::post('/password/reset', [AuthController::class, 'resetPassword'])
    ->middleware('throttle:5,1');

// Email verification routes
Route::post('/email/resend', [AuthController::class, 'resendVerificationEmail'])
    ->middleware(['auth:sanctum', 'throttle:5,1']);
Route::post('/email/change', [AuthController::class, 'changeEmail'])
    ->middleware(['auth:sanctum', 'throttle:5,1']);

Route::post('/auth/associate-content', [AuthController::class, 'associateContent'])->middleware('auth:sanctum');

// E2EE passkeys + vault (docs/e2ee.md) — unlock ceremony for encrypted books.
// Wrapped blobs only; the PRF output / keys never reach the server.
Route::middleware(['auth:sanctum', 'throttle:30,1'])->group(function () {
    Route::get('/passkeys', [PasskeyController::class, 'index']);
    Route::post('/passkeys/registration-options', [PasskeyController::class, 'registrationOptions']);
    Route::post('/passkeys/register', [PasskeyController::class, 'register']);
    Route::post('/passkeys/assertion-options', [PasskeyController::class, 'assertionOptions']);
    Route::post('/passkeys/assert', [PasskeyController::class, 'assert']);
    Route::post('/passkeys/{id}/vault-key', [PasskeyController::class, 'storeVaultKey'])->whereNumber('id');
    Route::patch('/passkeys/{id}', [PasskeyController::class, 'update'])->whereNumber('id');
    Route::delete('/passkeys/{id}', [PasskeyController::class, 'destroy'])->whereNumber('id');
    Route::get('/e2ee/vault', [E2eeVaultController::class, 'show']);
    Route::post('/e2ee/vault/recovery', [E2eeVaultController::class, 'rotateRecovery']);
});

Route::get('/auth/session-info', [AuthController::class, 'getSessionInfo']);

Route::post('/anonymous-session', [AuthController::class, 'createAnonymousSession']);
// Auth check (works for both authenticated and guest)
Route::get('/auth-check', [AuthController::class, 'checkAuth']);

Route::middleware(['author', 'throttle:120,1'])->group(function () {

    /* ----------------  Integrity Report  ---------------- */
    Route::post('/integrity/report', [IntegrityReportController::class, 'report'])
        ->middleware('throttle:120,1');
    Route::post('/integrity/paste-glitch', [IntegrityReportController::class, 'pasteGlitchReport'])
        ->middleware('throttle:120,1');
    Route::post('/integrity/conversion-feedback', [IntegrityReportController::class, 'conversionFeedback'])
        ->middleware('throttle:10,1');
    // Auto-fired by the frontend when an import fails — a machine diagnostic, not a
    // user spamming a form. A tight 10/min meant a burst of failures (or a user
    // retrying) got 429'd ("Throttled — try again in a minute") on top of the failure
    // itself. 60/min still bounds abuse while letting the auto-report through.
    Route::post('/integrity/import-failure', [IntegrityReportController::class, 'importFailureReport'])
        ->middleware('throttle:60,1');
    Route::post('/integrity/claim-premium', [IntegrityReportController::class, 'claimPremium'])
        ->middleware(['auth:sanctum', 'throttle:5,1']);

    /* ----------------  Unified Sync Endpoint  ---------------- */
    Route::post(
        '/db/unified-sync',
        [UnifiedSyncController::class, 'sync']
    );

    /* ----------------  Homepage / library stats  ---------------- */
    Route::get(
        '/homepage/books',
        [HomePageServerController::class, 'getHomePageBooks']
    );
    
    Route::post(
        '/homepage/books/update',
        [HomePageServerController::class, 'updateHomePageBooks']
    );

    Route::post(
        '/library/{book}/update-stats',
        [DbLibraryController::class, 'updateBookStats']
    );

    Route::post(
        '/library/update-all-stats',
        [DbLibraryController::class, 'updateAllLibraryStats']
    );

    /* ----------------  Bulk-create  ---------------- */
    Route::post(
        '/db/nodes/bulk-create',
        [DbNodeController::class, 'bulkCreate']
    );

    Route::post(
        '/db/hyperlights/bulk-create',
        [DbHyperlightController::class, 'bulkCreate']
    );

    Route::post(
        '/db/hypercites/bulk-create',
        [DbHyperciteController::class, 'bulkCreate']
    );

    Route::post(
        '/db/library/bulk-create',
        [DbLibraryController::class, 'bulkCreate']
    );


    /* ----------------  Upsert / targeted / delete  ---------------- */
    Route::post(
        '/db/nodes/upsert',
        [DbNodeController::class, 'upsert']
    );

    Route::post(
        '/db/nodes/targeted-upsert',
        [DbNodeController::class, 'targetedUpsert']
    );

    Route::post(
        '/db/hyperlights/upsert',
        [DbHyperlightController::class, 'upsert']
    );

    Route::post(
        '/db/hyperlights/delete',
        [DbHyperlightController::class, 'delete']
    );

    Route::post(
        '/db/hyperlights/hide',
        [DbHyperlightController::class, 'hide']
    );

    Route::post(
        '/db/hypercites/upsert',
        [DbHyperciteController::class, 'upsert']
    );

    Route::post(
        '/db/library/upsert',
        [DbLibraryController::class, 'upsert']
    );

    /* ----------------  Source verification ([check source])  ---------------- */
    // Owner-gated in-controller (mirrors /db/library/upsert). Look a book's citation identity up
    // against canonicals + external APIs (lookup), then link + overwrite on confirmation (verify).
    Route::post('/library/{book}/source/lookup', [\App\Http\Controllers\SourceVerificationController::class, 'lookup']);
    Route::post('/library/{book}/source/verify', [\App\Http\Controllers\SourceVerificationController::class, 'verify']);
    Route::post('/library/{book}/source/reject', [\App\Http\Controllers\SourceVerificationController::class, 'reject']);

    // Reference-level (bibliography) "Check source": lookup is read-only (any valid session) so the
    // button works for everyone; verify/reject are owner-gated writes (author confirms a picked
    // candidate or the existing auto match). refIds are authoryear slugs (no '/'), safe as path segs.
    Route::post('/library/{book}/reference/{refId}/source/lookup', [\App\Http\Controllers\ReferenceSourceVerificationController::class, 'lookup']);
    Route::post('/library/{book}/reference/{refId}/source/verify', [\App\Http\Controllers\ReferenceSourceVerificationController::class, 'verify']);
    Route::post('/library/{book}/reference/{refId}/source/reject', [\App\Http\Controllers\ReferenceSourceVerificationController::class, 'reject']);

    /* ----------------  Source Network Harvester ("Import Knowledge Network")  ---------------- */
    // Owner-gated: scan the book's bibliography, then fetch + convert every eligible open-access
    // cited work into its canonical's auto_version_book. estimate/trigger are owner-only (writes
    // happen via pgsql_admin in the job, so the controller check is the authorization boundary);
    // status/running are id-scoped polls. See app/Services/SourceHarvest/README.md.
    Route::post('/library/{book}/harvest/estimate', [\App\Http\Controllers\SourceHarvestController::class, 'estimate']);
    Route::post('/library/{book}/harvest/trigger', [\App\Http\Controllers\SourceHarvestController::class, 'trigger']);
    Route::get('/source-harvest/map', [\App\Http\Controllers\SourceHarvestController::class, 'map']);
    Route::get('/source-harvest/status/{harvestId}', [\App\Http\Controllers\SourceHarvestController::class, 'status']);
    Route::get('/source-harvest/running/{book}', [\App\Http\Controllers\SourceHarvestController::class, 'running']);
    Route::get('/source-harvest/latest/{book}', [\App\Http\Controllers\SourceHarvestController::class, 'latest']);
    Route::post('/source-harvest/{harvestId}/notify', [\App\Http\Controllers\SourceHarvestController::class, 'notify'])
        ->middleware('throttle:10,1');
    Route::post('/source-harvest/{harvestId}/cancel', [\App\Http\Controllers\SourceHarvestController::class, 'cancel'])
        ->middleware('throttle:10,1');
    Route::post('/source-harvest/{harvestId}/finish', [\App\Http\Controllers\SourceHarvestController::class, 'finish'])
        ->middleware('throttle:10,1');


    Route::post(
        '/db/library/update-timestamp',
        [DbLibraryController::class, 'updateTimestamp']
    );

    Route::post(
        '/db/library/set-slug',
        [DbLibraryController::class, 'setSlug']
    );

    // E2EE transition (docs/e2ee.md): mark a book encrypted (client re-uploads
    // ciphertext) or published (flags off; client re-uploads plaintext).
    Route::post(
        '/db/library/{book}/encryption',
        [DbLibraryController::class, 'setEncryption']
    )->where('book', '.*');

    Route::post(
        '/validate-book-id',
        [DbLibraryController::class, 'validateBookId']
    );

    Route::post(
        '/db/sync/beacon', 
        [BeaconSyncController::class, 'handleSync']
        );

    Route::delete('/books/{book}', [DbLibraryController::class, 'destroy'])->middleware('auth:sanctum');

    Route::get('/books/{book}/reconvert-info', [ImportController::class, 'reconvertInfo']);
    Route::post('/books/{book}/reconvert', [ImportController::class, 'reconvert']);

    // E2EE image blobs (docs/e2ee.md): list images + replace one image's bytes
    // (lock encrypts, publish decrypts). Owner-only + magic guard in-controller.
    // `throttle:blob-swap` REPLACES the group's shared 120/min bucket: the
    // swaps are one PUT per file, and an audiobook lock fires hundreds — on the
    // shared per-user bucket they starved against the tree pull/push and 429'd.
    Route::get('/books/{book}/images', [\App\Http\Controllers\BookImageController::class, 'index'])
        ->withoutMiddleware('throttle:120,1')->middleware('throttle:blob-swap');
    Route::put('/books/{book}/images/{filename}', [\App\Http\Controllers\BookImageController::class, 'update'])
        ->where('filename', '[a-zA-Z0-9\-_.]+\.(jpg|jpeg|png|gif|webp|svg)')
        ->withoutMiddleware('throttle:120,1')->middleware('throttle:blob-swap');

    // E2EE audio blobs (docs/audio.md §E2EE): list audio rows + replace one
    // file's bytes (lock encrypts, publish decrypts) — the book_images pattern.
    // Owner-only + HLENC1 magic guard in-controller.
    Route::get('/books/{book}/audio', [\App\Http\Controllers\BookAudioController::class, 'index'])
        ->withoutMiddleware('throttle:120,1')->middleware('throttle:blob-swap');
    Route::put('/books/{book}/audio/{filename}', [\App\Http\Controllers\BookAudioController::class, 'update'])
        ->where('filename', '[a-zA-Z0-9\-_.]+\.mp3')
        ->withoutMiddleware('throttle:120,1')->middleware('throttle:blob-swap');

     // {book} is greedy ('.+') so sub-book ids containing '/' (book_x/Fn1) route; the
     // strictly-constrained trailing {hyperciteId} anchors where the book id ends.
     Route::get(
        '/db/hypercites/find/{book}/{hyperciteId}',
        [DbHyperciteController::class, 'find']
    )->where('book', '.+')->where('hyperciteId', 'hypercite_[A-Za-z0-9]+');

    Route::post('/db/footnotes/upsert', [DbFootnoteController::class, 'upsert']);
    Route::post('/db/references/upsert', [DbReferencesController::class, 'upsertReferences']);

    /* ----------------  Sub-Books  ---------------- */
    Route::post('/db/sub-books/create', [SubBookController::class, 'create']);
    Route::post('/db/sub-books/migrate-existing', [SubBookController::class, 'migrateExisting']);

    /* ----------------  Node History / Version Control  ---------------- */
    // Get all versions of a specific node
    Route::get(
        '/nodes/{book}/{nodeId}/history',
        [NodeHistoryController::class, 'getNodeHistory']
    );

    // Get node as it was at a specific timestamp
    Route::get(
        '/nodes/{book}/{nodeId}/at/{timestamp}',
        [NodeHistoryController::class, 'getNodeAtTimestamp']
    )->where('timestamp', '.*'); // Allow slashes in timestamp

    // Get entire book state at a specific timestamp
    Route::get(
        '/books/{book}/at/{timestamp}',
        [NodeHistoryController::class, 'getBookAtTimestamp']
    )->where('timestamp', '.*');

    // Get recent changes for undo UI
    Route::get(
        '/books/{book}/changes',
        [NodeHistoryController::class, 'getRecentChanges']
    );

    // Restore a single node to a historical version
    Route::post(
        '/nodes/{book}/{nodeId}/restore',
        [NodeHistoryController::class, 'restoreNodeVersion']
    );

    // Restore entire book to a point in time
    Route::post(
        '/books/{book}/restore',
        [NodeHistoryController::class, 'restoreBookToTimestamp']
    );

    // Time machine: get full book data at a timestamp (for IndexedDB loading)
    Route::get(
        '/books/{book}/timemachine-data',
        [NodeHistoryController::class, 'getTimeMachineData']
    );

    /* ----------------  Scraper  ---------------- */
    Route::post('/scrape/novel/chapters', [ScrapeController::class, 'novelChapters']);
    Route::post('/scrape/novel/chapter', [ScrapeController::class, 'novelChapter']);
});

// Conversion test routes (admin-only)
Route::middleware(['auth:sanctum', 'admin'])->group(function () {
    Route::post('/conversion-tests/run', [\App\Http\Controllers\ConversionTestController::class, 'runTests'])
        ->middleware('throttle:5,1');
    Route::post('/conversion-tests/add-fixture', [\App\Http\Controllers\ConversionTestController::class, 'addFixture'])
        ->middleware('throttle:5,1');
    Route::post('/conversion-tests/upload-fixture', [\App\Http\Controllers\ConversionTestController::class, 'uploadFixture'])
        ->middleware('throttle:5,1');
});

// Snapshots endpoint — outside author middleware so public book readers can see version history
Route::get('/books/{book}/snapshots', [NodeHistoryController::class, 'getSnapshots']);

// Docuverse graph data (?layers=…&focus={bookId} for one book's connected
// component) — outside author middleware (guests see the public docuverse);
// RLS on the default connection scopes rows to the caller.
Route::get('/docuverse/data', [\App\Http\Controllers\DocuverseController::class, 'data'])
    ->middleware('throttle:30,1');

// Chain resolution for SPA cross-book navigation (level 3+ sub-books)
Route::get('resolve-chain/{book}/{rest}', [\App\Http\Controllers\TextController::class, 'resolveChainApi'])
    ->where(['book' => '[A-Za-z0-9_-]+', 'rest' => '[0-9]+/.+'])
    ->name('api.resolve-chain');

// API routes for transferring data from database to IndexedDB
Route::prefix('database-to-indexeddb')->group(function () {
    // Sub-book routes ({subId} allows slashes for nested IDs like "2/HL_123/HL_456")
    // Must be defined before the single-segment routes to avoid {bookId} swallowing the slash.
    Route::get('books/{parentBook}/{subId}/data', [DatabaseToIndexedDBController::class, 'getSubBookData'])
        ->where('subId', '.+')
        ->name('api.database-to-indexeddb.sub-book-data');
    Route::get('books/{parentBook}/{subId}/initial', [DatabaseToIndexedDBController::class, 'getSubBookInitialChunk'])
        ->where('subId', '.+')
        ->name('api.database-to-indexeddb.sub-book-initial');
    // Sub-book library: a sub-book id ("parentBook/subId") can't go in the single-segment
    // {bookId}/library route (the "/" 404s), so the per-load freshness check 404'd for every
    // footnote/hyperlight sub-book. Split form mirrors the data/initial sub-book routes above.
    Route::get('books/{parentBook}/{subId}/library', [DatabaseToIndexedDBController::class, 'getSubBookLibrary'])
        ->where('subId', '.+')
        ->name('api.database-to-indexeddb.sub-book-library');
    // Sub-book annotations: same slash problem as /library above. The per-load
    // freshness check bumps annotations_updated_at on the sub-book's library row,
    // then syncAnnotationsOnly fetches /annotations — which 404'd for every nested
    // sub-book because only the single-segment {bookId}/annotations route existed.
    Route::get('books/{parentBook}/{subId}/annotations', [DatabaseToIndexedDBController::class, 'getSubBookAnnotations'])
        ->where('subId', '.+')
        ->name('api.database-to-indexeddb.sub-book-annotations');

    // Headings (lightweight TOC data when not fully loaded)
    Route::get('books/{bookId}/headings', [DatabaseToIndexedDBController::class, 'getBookHeadings'])
        ->name('api.database-to-indexeddb.book-headings');

    // Batched data download (chunk_id range)
    Route::get('books/{bookId}/data/batch', [DatabaseToIndexedDBController::class, 'getBookDataBatch'])
        ->name('api.database-to-indexeddb.book-data-batch');

    // Chunked lazy loading: initial chunk + manifest
    Route::get('books/{bookId}/initial', [DatabaseToIndexedDBController::class, 'getInitialChunk'])
        ->name('api.database-to-indexeddb.book-initial');

    // Chunked lazy loading: fetch a single chunk on demand
    Route::get('books/{bookId}/chunk/{chunkId}', [DatabaseToIndexedDBController::class, 'getSingleChunk'])
        // chunk_id can be a decimal (fractional indexing), e.g. 4.5 — allow an optional
        // fractional part. Still matches plain integers and still 404s non-numeric ids.
        ->where('chunkId', '[0-9]+(\.[0-9]+)?')
        ->name('api.database-to-indexeddb.book-chunk');

    // Reading position (bookmark) endpoints
    Route::post('books/{bookId}/reading-position', [DatabaseToIndexedDBController::class, 'saveReadingPosition'])
        ->name('api.database-to-indexeddb.save-reading-position');
    Route::get('books/{bookId}/reading-position', [DatabaseToIndexedDBController::class, 'getReadingPosition'])
        ->name('api.database-to-indexeddb.get-reading-position');

    // Get full book data for IndexedDB import
    Route::get('books/{bookId}/data', [DatabaseToIndexedDBController::class, 'getBookData'])
        ->name('api.database-to-indexeddb.book-data');

    // Get just annotations (hyperlights + hypercites) for a book
    Route::get('books/{bookId}/annotations', [DatabaseToIndexedDBController::class, 'getBookAnnotations'])
        ->name('api.database-to-indexeddb.book-annotations');

    // Get just library data for a specific book
    Route::get('books/{bookId}/library', [DatabaseToIndexedDBController::class, 'getBookLibrary'])
        ->name('api.database-to-indexeddb.book-library');
});

