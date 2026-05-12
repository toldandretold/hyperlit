<?php

/**
 * Import + conversion regression test.
 *
 * Hits POST /import-file with a file from each accepted format. Queue is sync
 * in test env (phpunit.xml), so the conversion job runs inline and assertion
 * happens on the post-conversion state.
 *
 *   happy/   each file imports successfully
 *   pdf/     each file imports via side-loaded OCR cache (X-Test-Fixture header)
 *   bad/     each file rejected with the status in its sibling .expected.json
 *   dropbox/ user drop folder; treated as happy-path
 *
 * Add coverage by dropping a file in tests/conversion/import-samples/dropbox/
 * (happy-path) or tests/conversion/import-samples/bad/ (with a sibling
 * <name>.expected.json describing the expected response).
 */

use App\Models\PgLibrary;
use App\Models\User;
use Illuminate\Http\UploadedFile;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\File;
use Illuminate\Support\Facades\Hash;
use Illuminate\Support\Str;

const SAMPLES_DIR = __DIR__ . '/../../conversion/import-samples';

/**
 * RLS on `users` blocks INSERT from the app's `pgsql` role; tests must
 * create users via the `pgsql_admin` connection (BYPASSRLS). Mirrors the
 * helper in tests/Feature/Security/SqlInjectionWarGameTest.php.
 */
function makeImportTestUser(): User
{
    $email = 'imptest_' . Str::random(8) . '@test.local';
    DB::connection('pgsql_admin')->table('users')->insert([
        'name'              => 'Import Test User',
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

beforeEach(function () {
    $this->user = makeImportTestUser();
});

afterEach(function () {
    // The DB is rolled back by RefreshDatabase, but the filesystem isn't.
    foreach (glob(resource_path('markdown/test_*')) ?: [] as $dir) {
        if (is_dir($dir)) {
            File::deleteDirectory($dir);
        }
    }
});

/* ─── Happy path: every file in happy/ + dropbox/ ────────────────── */

dataset('happy_files', function () {
    $files = [];
    foreach (['/happy', '/dropbox'] as $rel) {
        $dir = SAMPLES_DIR . $rel;
        if (!is_dir($dir)) {
            continue;
        }
        $iter = new RecursiveIteratorIterator(
            new RecursiveDirectoryIterator($dir, FilesystemIterator::SKIP_DOTS)
        );
        foreach ($iter as $f) {
            if (!$f->isFile()) continue;
            $name = $f->getFilename();
            // Skip dotfiles, the markdown_folder children (we test the folder
            // upload via the parent dir, not by submitting individual files),
            // and the .gitkeep marker.
            if (str_starts_with($name, '.')) continue;
            if (str_contains($f->getPathname(), '/markdown_folder/')) continue;
            $files[basename($f->getPathname())] = [$f->getPathname()];
        }
    }
    // Add markdown_folder as a folder upload (multi-file)
    $folder = SAMPLES_DIR . '/happy/markdown_folder';
    if (is_dir($folder)) {
        $files['markdown_folder/'] = [$folder];
    }
    return $files;
});

it('imports successfully', function (string $samplePath) {
    $bookId = 'test_' . substr(md5($samplePath . microtime(true)), 0, 10);

    // Use createWithContent so Laravel manages a throwaway temp copy —
    // ImportController's $file->move() would otherwise destroy the fixture.
    $uploads = is_dir($samplePath)
        ? collect(glob("{$samplePath}/*"))
            ->map(fn($p) => UploadedFile::fake()->createWithContent(basename($p), file_get_contents($p)))
            ->all()
        : [UploadedFile::fake()->createWithContent(basename($samplePath), file_get_contents($samplePath))];

    $response = $this->actingAs($this->user)->post('/import-file', [
        'book' => $bookId,
        'title' => 'Test ' . basename($samplePath),
        'markdown_file' => $uploads,
    ], ['Accept' => 'application/json']);

    $response->assertOk();
    expect(PgLibrary::where('book', $bookId)->exists())->toBeTrue();
    expect(File::isDirectory(resource_path("markdown/{$bookId}")))->toBeTrue();
})->with('happy_files');


/* ─── PDF path: pdf/manifest.json maps each pdf to a fixture ─────── */

dataset('pdf_files', function () {
    $manifestPath = SAMPLES_DIR . '/pdf/manifest.json';
    if (!is_file($manifestPath)) {
        return [];
    }
    $manifest = json_decode(file_get_contents($manifestPath), true) ?: [];
    $rows = [];
    foreach ($manifest as $filename => $cfg) {
        $path = SAMPLES_DIR . '/pdf/' . $filename;
        if (is_file($path) && !empty($cfg['fixture'])) {
            $rows[$filename] = [$path, $cfg['fixture']];
        }
    }
    return $rows;
});

it('imports a PDF using the side-loaded OCR cache', function (string $pdfPath, string $fixtureName) {
    $bookId = 'test_pdf_' . substr(md5($pdfPath . microtime(true)), 0, 10);

    $upload = UploadedFile::fake()->createWithContent(basename($pdfPath), file_get_contents($pdfPath));

    $response = $this->actingAs($this->user)->post('/import-file', [
        'book' => $bookId,
        'title' => 'Test ' . basename($pdfPath),
        'markdown_file' => [$upload],
    ], [
        'Accept' => 'application/json',
        'X-Test-Fixture' => $fixtureName,
    ]);

    $response->assertOk();
    expect(PgLibrary::where('book', $bookId)->exists())->toBeTrue();

    // Confirm the cache really was side-loaded (proves OCR API was bypassed).
    // Compare bytes to the fixture; if Mistral was actually called, the bytes
    // would differ (different upload id, etc.).
    $servedPath  = resource_path("markdown/{$bookId}/ocr_response.json");
    $fixturePath = base_path("tests/conversion/fixtures/{$fixtureName}/ocr_response.json");
    expect(File::exists($servedPath))->toBeTrue();
    expect(md5_file($servedPath))->toBe(md5_file($fixturePath));
})->with('pdf_files');


/* ─── Bad path: every file in bad/ has a .expected.json sibling ──── */

dataset('bad_files', function () {
    $rows = [];
    $dir = SAMPLES_DIR . '/bad';
    if (!is_dir($dir)) return [];
    foreach (glob("{$dir}/*") ?: [] as $path) {
        if (str_ends_with($path, '.expected.json')) continue;
        if (str_starts_with(basename($path), '.')) continue;
        $expectPath = $path . '.expected.json';
        if (is_file($expectPath)) {
            $rows[basename($path)] = [$path, json_decode(file_get_contents($expectPath), true)];
        }
    }
    return $rows;
});

it('rejects faulty submissions with the expected status', function (string $samplePath, array $expected) {
    $bookId = 'test_bad_' . substr(md5($samplePath . microtime(true)), 0, 10);

    $upload = UploadedFile::fake()->createWithContent(basename($samplePath), file_get_contents($samplePath));

    $response = $this->actingAs($this->user)->post('/import-file', [
        'book' => $bookId,
        'title' => 'Test ' . basename($samplePath),
        'markdown_file' => [$upload],
    ], ['Accept' => 'application/json']);

    $response->assertStatus($expected['status']);

    if (!empty($expected['errorContains'])) {
        expect($response->getContent())->toContain($expected['errorContains']);
    }

    expect(PgLibrary::where('book', $bookId)->exists())->toBeFalse();
})->with('bad_files');
