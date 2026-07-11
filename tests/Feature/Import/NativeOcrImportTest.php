<?php

/**
 * Client-side OCR seam: POST /import-file with an `ocr_response` file (the macOS
 * app's on-device PDF OCR, shaped like Mistral's ocr_response.json).
 *
 * The seam under test (ImportController::store):
 *   - a valid ocr_response uploaded with a PDF is written into the book dir, so
 *     mistral_ocr.py replays from it as its cache — no Mistral call, no API key;
 *   - the `model` field is force-stamped to hyperlit-native-ocr (a client must
 *     never be able to claim a paid Mistral model);
 *   - a zero-amount ocr_charged.json marker is written, so billOcrImport() skips
 *     billing (the server did no OCR work) — and the pre-queue balance gate is
 *     skipped too (a zero-balance user can import for free);
 *   - malformed / malicious payloads are rejected 422 BEFORE any file lands.
 *
 * Queue is sync in the test env, so the conversion job (and the Python pipeline,
 * replaying from the cache) runs inline within the POST.
 */

use App\Models\BillingLedger;
use App\Models\PgLibrary;
use App\Models\User;
use Illuminate\Http\UploadedFile;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\File;
use Illuminate\Support\Facades\Hash;
use Illuminate\Support\Str;

const NATIVE_OCR_SAMPLES = __DIR__ . '/../../conversion/import-samples';
const NATIVE_OCR_FIXTURE = __DIR__ . '/../../conversion/fixtures/pdf/sequential/synthetic/ocr_response.json';

/** RLS on `users` blocks INSERT from the app role; create via pgsql_admin (BYPASSRLS). */
function makeNativeOcrTestUser(): User
{
    $email = 'natocr_' . Str::random(8) . '@test.local';
    DB::connection('pgsql_admin')->table('users')->insert([
        'name'              => 'Native OCR Test User',
        'email'             => $email,
        'email_verified_at' => now(),
        'password'          => Hash::make('password'),
        'remember_token'    => Str::random(10),
        'user_token'        => Str::uuid()->toString(),
        'created_at'        => now(),
        'updated_at'        => now(),
    ]);
    return User::on('pgsql_admin')->where('email', $email)->firstOrFail();
}

function nativeOcrPdfUpload(): UploadedFile
{
    $pdf = NATIVE_OCR_SAMPLES . '/pdf/whole_document_example.pdf';
    return UploadedFile::fake()->createWithContent('whole_document_example.pdf', file_get_contents($pdf));
}

function nativeOcrJsonUpload(?array $mutate = null): UploadedFile
{
    $data = json_decode(file_get_contents(NATIVE_OCR_FIXTURE), true);
    if ($mutate !== null) {
        $data = array_replace_recursive($data, $mutate);
    }
    return UploadedFile::fake()->createWithContent('ocr_response.json', json_encode($data));
}

function postNativeOcrImport($test, string $bookId, array $overrides = [])
{
    return $test->actingAs($test->user)->post('/import-file', array_merge([
        'book' => $bookId,
        'title' => 'Native OCR Test',
        'markdown_file' => [nativeOcrPdfUpload()],
        'ocr_response' => nativeOcrJsonUpload(),
    ], $overrides), ['Accept' => 'application/json']);
}

beforeEach(function () {
    $this->user = makeNativeOcrTestUser();
});

afterEach(function () {
    foreach (glob(resource_path('markdown/test_natocr_*')) ?: [] as $dir) {
        if (is_dir($dir)) {
            File::deleteDirectory($dir);
        }
    }
});

it('imports a PDF with client OCR: no billing, forced model, zero-charge marker', function () {
    $bookId = 'test_natocr_' . substr(md5(uniqid()), 0, 10);

    // Fresh user has zero balance — the fact this succeeds proves the pre-queue
    // balance gate is skipped for client-OCR imports.
    $response = postNativeOcrImport($this, $bookId);
    $response->assertOk();

    expect(PgLibrary::where('book', $bookId)->exists())->toBeTrue();

    $path = resource_path("markdown/{$bookId}");

    // The client OCR was seeded as the pipeline's cache, with the model stamped.
    $served = json_decode(File::get("{$path}/ocr_response.json"), true);
    expect($served['model'])->toBe('hyperlit-native-ocr');
    // Fixture content actually drove the conversion (fixture page 0 mentions cathedrals).
    expect($served['pages'][0]['markdown'])->toContain('cathedrals');

    // Zero-amount billing marker written by the controller, honoured by the job.
    $charged = json_decode(File::get("{$path}/ocr_charged.json"), true);
    expect($charged['amount'])->toBe(0);
    expect($charged['source'])->toBe('client_native_ocr');

    // No ledger row: nothing was billed for this import.
    expect(BillingLedger::where('user_id', $this->user->id)->count())->toBe(0);

    // The conversion ran from the cache (sync queue): main-text.md exists.
    expect(File::exists("{$path}/main-text.md"))->toBeTrue();
});

it('rejects malformed ocr_response JSON with 422 and creates nothing', function () {
    $bookId = 'test_natocr_' . substr(md5(uniqid()), 0, 10);

    $response = postNativeOcrImport($this, $bookId, [
        'ocr_response' => UploadedFile::fake()->createWithContent('ocr_response.json', '{"pages": "nope"'),
    ]);

    $response->assertStatus(422);
    expect(PgLibrary::where('book', $bookId)->exists())->toBeFalse();
    expect(File::exists(resource_path("markdown/{$bookId}/ocr_response.json")))->toBeFalse();
});

it('rejects a path-traversal image id with 422', function () {
    $bookId = 'test_natocr_' . substr(md5(uniqid()), 0, 10);

    $response = postNativeOcrImport($this, $bookId, [
        'ocr_response' => nativeOcrJsonUpload([
            'pages' => [0 => ['images' => [
                ['id' => '../../evil.jpeg', 'image_base64' => base64_encode('x')],
            ]]],
        ]),
    ]);

    $response->assertStatus(422);
    expect(PgLibrary::where('book', $bookId)->exists())->toBeFalse();
});

it('rejects an oversized page markdown with 422', function () {
    $bookId = 'test_natocr_' . substr(md5(uniqid()), 0, 10);

    $response = postNativeOcrImport($this, $bookId, [
        'ocr_response' => nativeOcrJsonUpload([
            'pages' => [0 => ['markdown' => str_repeat('a', 2 * 1024 * 1024 + 1)]],
        ]),
    ]);

    $response->assertStatus(422);
    expect(PgLibrary::where('book', $bookId)->exists())->toBeFalse();
});

it('ignores ocr_response on a non-PDF upload', function () {
    $bookId = 'test_natocr_' . substr(md5(uniqid()), 0, 10);

    $response = postNativeOcrImport($this, $bookId, [
        'markdown_file' => [UploadedFile::fake()->createWithContent('note.md', "# Hello\n\nWorld.\n")],
    ]);

    $response->assertOk();
    expect(PgLibrary::where('book', $bookId)->exists())->toBeTrue();
    // The stray OCR upload must not seed a cache or a billing marker.
    expect(File::exists(resource_path("markdown/{$bookId}/ocr_response.json")))->toBeFalse();
    expect(File::exists(resource_path("markdown/{$bookId}/ocr_charged.json")))->toBeFalse();
});

it('uses the native OCR CLI when configured (server-side path, no charge)', function () {
    $bookId = 'test_natocr_' . substr(md5(uniqid()), 0, 10);

    // Fake hyperlit-ocr: copies the fixture JSON to the requested output path.
    $fake = sys_get_temp_dir() . '/fake-hyperlit-ocr-' . uniqid() . '.sh';
    File::put($fake, "#!/bin/bash\ncp " . escapeshellarg(NATIVE_OCR_FIXTURE) . " \"\$2\"\n");
    chmod($fake, 0755);
    config(['services.native_ocr.binary' => $fake, 'services.native_ocr.provider' => 'auto']);

    try {
        // No ocr_response upload — the SERVER runs the (fake) CLI itself. The
        // pre-queue balance gate only knows about client OCR (the server can't
        // know yet that the CLI will succeed), so fund the user to get past it;
        // the assertion below is that nothing was actually charged.
        DB::connection('pgsql_admin')->table('users')
            ->where('id', $this->user->id)->update(['credits' => 10]);

        $response = $this->actingAs($this->user)->post('/import-file', [
            'book' => $bookId,
            'title' => 'Native OCR CLI Test',
            'markdown_file' => [nativeOcrPdfUpload()],
        ], ['Accept' => 'application/json']);

        $response->assertOk();
        $path = resource_path("markdown/{$bookId}");
        expect(File::exists("{$path}/ocr_response.json"))->toBeTrue();
        $charged = json_decode(File::get("{$path}/ocr_charged.json"), true);
        expect($charged['amount'])->toBe(0);
        expect($charged['source'])->toBe('server_native_ocr');
        expect(BillingLedger::where('user_id', $this->user->id)->count())->toBe(0);
        expect(File::exists("{$path}/main-text.md"))->toBeTrue();
    } finally {
        File::delete($fake);
    }
});

it('an existing OCR cache takes precedence over the native CLI', function () {
    $bookId = 'test_natocr_' . substr(md5(uniqid()), 0, 10);

    // A CLI that would DESTROY the import if invoked — proving it is skipped
    // when the cache already exists (client upload / test side-load first).
    $fake = sys_get_temp_dir() . '/fake-hyperlit-ocr-' . uniqid() . '.sh';
    File::put($fake, "#!/bin/bash\necho corrupt > \"\$2\"\nexit 1\n");
    chmod($fake, 0755);
    config(['services.native_ocr.binary' => $fake, 'services.native_ocr.provider' => 'auto']);

    try {
        DB::connection('pgsql_admin')->table('users')
            ->where('id', $this->user->id)->update(['credits' => 10]);

        $response = $this->actingAs($this->user)->post('/import-file', [
            'book' => $bookId,
            'title' => 'Native OCR Precedence Test',
            'markdown_file' => [nativeOcrPdfUpload()],
        ], ['Accept' => 'application/json', 'X-Test-Fixture' => 'pdf/sequential/synthetic']);

        $response->assertOk();
        $path = resource_path("markdown/{$bookId}");
        expect(File::exists("{$path}/main-text.md"))->toBeTrue();
        // The side-loaded cache survived (the destructive CLI never ran).
        $served = json_decode(File::get("{$path}/ocr_response.json"), true);
        expect($served['pages'][0]['markdown'])->toContain('cathedrals');
    } finally {
        File::delete($fake);
    }
});

it('a failing native CLI in auto mode leaves no partial cache and no marker', function () {
    $processor = app(\App\Services\DocumentImport\Processors\PdfProcessor::class);

    $fake = sys_get_temp_dir() . '/fake-hyperlit-ocr-' . uniqid() . '.sh';
    File::put($fake, "#!/bin/bash\necho partial > \"\$2\"\nexit 1\n");
    chmod($fake, 0755);
    config(['services.native_ocr.binary' => $fake, 'services.native_ocr.provider' => 'auto']);

    $outDir = sys_get_temp_dir() . '/natocr-out-' . uniqid();
    File::ensureDirectoryExists($outDir);

    try {
        $method = new ReflectionMethod($processor, 'runNativeOcrIfConfigured');
        $method->setAccessible(true);
        $pdf = NATIVE_OCR_SAMPLES . '/pdf/whole_document_example.pdf';
        $method->invoke($processor, $pdf, $outDir, 'natocr-unit');   // must not throw in auto mode

        expect(File::exists("{$outDir}/ocr_response.json"))->toBeFalse();
        expect(File::exists("{$outDir}/ocr_charged.json"))->toBeFalse();

        // In 'native' mode the same failure IS fatal.
        config(['services.native_ocr.provider' => 'native']);
        expect(fn() => $method->invoke($processor, $pdf, $outDir, 'natocr-unit'))
            ->toThrow(\Symfony\Component\Process\Exception\ProcessFailedException::class);
    } finally {
        File::delete($fake);
        File::deleteDirectory($outDir);
    }
});

it('cannot dodge billing by claiming a Mistral model name', function () {
    $bookId = 'test_natocr_' . substr(md5(uniqid()), 0, 10);

    $response = postNativeOcrImport($this, $bookId, [
        'ocr_response' => nativeOcrJsonUpload(['model' => 'mistral-ocr-latest']),
    ]);

    $response->assertOk();
    $served = json_decode(File::get(resource_path("markdown/{$bookId}/ocr_response.json")), true);
    // The claim is overwritten — provenance is server-stamped, never client-claimed.
    expect($served['model'])->toBe('hyperlit-native-ocr');
    expect(BillingLedger::where('user_id', $this->user->id)->count())->toBe(0);
});

it('stamps BYO-Mistral uploads as client-mistral and still charges nothing', function () {
    $bookId = 'test_natocr_' . substr(md5(uniqid()), 0, 10);

    $response = postNativeOcrImport($this, $bookId, [
        'ocr_source' => 'client_mistral',
    ]);

    $response->assertOk();
    $path = resource_path("markdown/{$bookId}");
    $served = json_decode(File::get("{$path}/ocr_response.json"), true);
    expect($served['model'])->toBe('hyperlit-client-mistral-ocr');
    $charged = json_decode(File::get("{$path}/ocr_charged.json"), true);
    expect($charged['amount'])->toBe(0);
    expect($charged['source'])->toBe('client_mistral_ocr');
    expect(BillingLedger::where('user_id', $this->user->id)->count())->toBe(0);
});
