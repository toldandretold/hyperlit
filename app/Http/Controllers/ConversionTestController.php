<?php

namespace App\Http\Controllers;

use Illuminate\Http\Request;
use Illuminate\Support\Facades\File;
use Illuminate\Support\Facades\Log;
use Symfony\Component\Process\Process;
use App\Models\PgLibrary;

class ConversionTestController extends Controller
{
    /**
     * Dashboard view — shows fixture coverage and test results.
     * Shows a login form if not authenticated, 403 if not admin.
     */
    public function dashboard(Request $request)
    {
        $user = $request->user();

        if (!$user) {
            return response()->view('conversion-test-login', [], 401);
        }

        if (!$user->isAdmin()) {
            abort(403, 'Admin access required.');
        }

        $fixtures = $this->discoverFixtures();
        $knownStrategies = [
            'no_footnotes', 'sequential', 'sectioned',
            'whole_document', 'pre_processed', 'stem_bibliography',
        ];
        $knownStyles = [
            'author-year-bracket', 'numbered-bracket',
            'bibliography-only', 'none',
        ];

        // Which strategies/styles have at least one fixture?
        $coveredStrategies = collect($fixtures)->pluck('footnote_strategy')->unique()->toArray();
        $coveredStyles = collect($fixtures)->pluck('citation_style')->unique()->toArray();

        $uncoveredStrategies = array_diff($knownStrategies, $coveredStrategies);
        $uncoveredStyles = array_diff($knownStyles, $coveredStyles);

        // Find one consented candidate book per uncovered strategy
        $suggestions = $this->findCoverageSuggestions($uncoveredStrategies);

        return view('conversion-test-dashboard', [
            'fixtures' => $fixtures,
            'knownStrategies' => $knownStrategies,
            'knownStyles' => $knownStyles,
            'coveredStrategies' => $coveredStrategies,
            'coveredStyles' => $coveredStyles,
            'uncoveredStrategies' => $uncoveredStrategies,
            'uncoveredStyles' => $uncoveredStyles,
            'suggestions' => $suggestions,
        ]);
    }

    /**
     * Run regression tests and return JSON results.
     */
    public function runTests(Request $request)
    {
        $fixture = $request->input('fixture');

        $cmd = [
            'python3',
            base_path('tests/conversion/run_regression.py'),
            '--json',
        ];

        if ($fixture) {
            $cmd[] = '--fixture';
            $cmd[] = $fixture;
        }

        $process = new Process($cmd);
        $process->setTimeout(300);
        $process->run();

        $output = $process->getOutput();
        $results = json_decode($output, true);

        if (!$results) {
            return response()->json([
                'error' => 'Failed to parse test output',
                'raw' => $output,
                'stderr' => $process->getErrorOutput(),
            ], 500);
        }

        return response()->json($results);
    }

    /**
     * Add a fixture from a consented book via the dashboard.
     */
    public function addFixture(Request $request)
    {
        $data = $request->validate([
            'bookId'      => 'required|string|max:500',
            'name'        => 'required|string|max:100|regex:/^[a-zA-Z0-9_-]+$/',
            'description' => 'required|string|max:500',
        ]);

        $bookDir = resource_path("markdown/{$data['bookId']}");

        // Allow consented books or public books
        $isConsented = is_file("{$bookDir}/feedback_consented.json");
        $isPublic = PgLibrary::where('book', $data['bookId'])
            ->where('visibility', 'public')
            ->exists();

        if (!$isConsented && !$isPublic) {
            return response()->json([
                'error' => 'Book must be either public or user-consented (via feedback toast) to become a fixture.',
            ], 403);
        }

        // Must have OCR or HTML
        if (!is_file("{$bookDir}/ocr_response.json") && !is_file("{$bookDir}/debug_converted.html")) {
            return response()->json([
                'error' => 'No ocr_response.json or debug_converted.html found for this book.',
            ], 422);
        }

        $cmd = [
            'python3',
            base_path('tests/conversion/add_fixture.py'),
            '--name', $data['name'],
            '--source', $bookDir,
            '--description', $data['description'],
        ];

        $process = new Process($cmd);
        $process->setTimeout(120);
        $process->setInput("y\n"); // auto-confirm overwrite if exists
        $process->run();

        if (!$process->isSuccessful()) {
            Log::error('add_fixture.py failed', [
                'stdout' => $process->getOutput(),
                'stderr' => $process->getErrorOutput(),
            ]);
            return response()->json([
                'error' => 'Failed to create fixture',
                'details' => $process->getErrorOutput() ?: $process->getOutput(),
            ], 500);
        }

        return response()->json([
            'status' => 'created',
            'name' => $data['name'],
            'output' => $process->getOutput(),
        ]);
    }

    /**
     * Upload files (ocr_response.json, etc.) to create a fixture via drag-and-drop.
     */
    public function uploadFixture(Request $request)
    {
        $data = $request->validate([
            'name'        => 'required|string|max:100|regex:/^[a-zA-Z0-9_-]+$/',
            'description' => 'required|string|max:500',
            'files'       => 'required|array|min:1',
            'files.*'     => 'file|max:51200', // 50MB max per file
        ]);

        // Create a temp directory for the uploaded files
        $tmpDir = sys_get_temp_dir() . '/hyperlit_fixture_' . uniqid();
        mkdir($tmpDir, 0755, true);

        $hasOcr = false;
        $hasHtml = false;

        foreach ($request->file('files') as $file) {
            $originalName = $file->getClientOriginalName();

            // Only allow known safe filenames
            $allowed = [
                'ocr_response.json',
                'debug_converted.html',
                'footnote_meta.json',
                'conversion_stats.json',
                'main-text.md',
            ];

            if (!in_array($originalName, $allowed)) {
                // Also allow input.html as an alias for debug_converted.html
                if ($originalName === 'input.html') {
                    $file->move($tmpDir, 'debug_converted.html');
                    $hasHtml = true;
                    continue;
                }
                continue; // skip unknown files
            }

            $file->move($tmpDir, $originalName);
            if ($originalName === 'ocr_response.json') $hasOcr = true;
            if ($originalName === 'debug_converted.html') $hasHtml = true;
        }

        if (!$hasOcr && !$hasHtml) {
            File::deleteDirectory($tmpDir);
            return response()->json([
                'error' => 'Upload must include at least ocr_response.json or debug_converted.html.',
            ], 422);
        }

        $cmd = [
            'python3',
            base_path('tests/conversion/add_fixture.py'),
            '--name', $data['name'],
            '--source', $tmpDir,
            '--description', $data['description'],
        ];

        $process = new Process($cmd);
        $process->setTimeout(120);
        $process->setInput("y\n");
        $process->run();

        // Clean up temp dir
        File::deleteDirectory($tmpDir);

        if (!$process->isSuccessful()) {
            Log::error('add_fixture.py failed (upload)', [
                'stdout' => $process->getOutput(),
                'stderr' => $process->getErrorOutput(),
            ]);
            return response()->json([
                'error' => 'Failed to create fixture',
                'details' => $process->getErrorOutput() ?: $process->getOutput(),
            ], 500);
        }

        return response()->json([
            'status' => 'created',
            'name' => $data['name'],
            'output' => $process->getOutput(),
        ]);
    }

    /**
     * Discover all fixtures from tests/conversion/fixtures/
     */
    private function discoverFixtures(): array
    {
        $fixturesDir = base_path('tests/conversion/fixtures');
        if (!is_dir($fixturesDir)) {
            return [];
        }

        $fixtures = [];
        foreach (scandir($fixturesDir) as $name) {
            if ($name === '.' || $name === '..') continue;
            $manifestPath = "{$fixturesDir}/{$name}/manifest.json";
            if (!is_file($manifestPath)) continue;

            $manifest = json_decode(File::get($manifestPath), true);
            $hasOcr = is_file("{$fixturesDir}/{$name}/ocr_response.json");
            $hasHtml = is_file("{$fixturesDir}/{$name}/input.html");

            $fixtures[] = array_merge($manifest, [
                'dir_name' => $name,
                'has_ocr' => $hasOcr,
                'has_html' => $hasHtml,
                'pipeline' => $hasOcr ? 'full' : ($hasHtml ? 'html-only' : 'none'),
            ]);
        }

        return $fixtures;
    }

    /**
     * Map OCR footnote_meta classifications to process_document.py strategies.
     */
    private const CLASSIFICATION_TO_STRATEGY = [
        'none'                       => 'no_footnotes',
        'document_endnotes'          => 'whole_document',
        'chapter_endnotes'           => 'sectioned',
        'page_bottom'                => 'sequential',
        'wackSTEMbibliographyNotes'  => 'stem_bibliography',
    ];

    /**
     * Find one candidate book per uncovered strategy.
     * Considers both user-consented books and public books.
     */
    private function findCoverageSuggestions(array $uncoveredStrategies): array
    {
        if (empty($uncoveredStrategies)) {
            return [];
        }

        $markdownDir = resource_path('markdown');
        if (!is_dir($markdownDir)) {
            return [];
        }

        // Build reverse map: strategy → OCR classifications that produce it
        $strategyToClassifications = [];
        foreach (self::CLASSIFICATION_TO_STRATEGY as $cls => $strat) {
            $strategyToClassifications[$strat][] = $cls;
        }

        // Which classifications would fill a gap?
        $wantedClassifications = [];
        foreach ($uncoveredStrategies as $strategy) {
            foreach ($strategyToClassifications[$strategy] ?? [] as $cls) {
                $wantedClassifications[$cls] = $strategy;
            }
        }

        // Collect public book IDs from the library table
        $publicBookIds = PgLibrary::where('visibility', 'public')
            ->pluck('book')
            ->toArray();
        $publicBookIdSet = array_flip($publicBookIds);

        $suggestions = [];  // keyed by strategy — one per gap
        foreach (scandir($markdownDir) as $bookId) {
            if ($bookId === '.' || $bookId === '..') continue;
            $bookDir = "{$markdownDir}/{$bookId}";

            $isConsented = is_file("{$bookDir}/feedback_consented.json");
            $isPublic = isset($publicBookIdSet[$bookId]);

            // Must be either consented or public
            if (!$isConsented && !$isPublic) continue;
            // Must have OCR for full-pipeline fixture
            if (!is_file("{$bookDir}/ocr_response.json")) continue;
            if (!is_file("{$bookDir}/footnote_meta.json")) continue;

            $fnMeta = json_decode(File::get("{$bookDir}/footnote_meta.json"), true);
            $cls = $fnMeta['classification'] ?? null;
            if (!$cls || !isset($wantedClassifications[$cls])) continue;

            $strategy = $wantedClassifications[$cls];
            if (isset($suggestions[$strategy])) continue;

            // Read consent/source info for display
            $user = '?';
            $rating = '?';
            $source = 'public';
            if ($isConsented) {
                $consent = json_decode(File::get("{$bookDir}/feedback_consented.json"), true);
                $rating = $consent['rating'] ?? '?';
                $user = $consent['userName'] ?? 'unknown';
                $source = 'consented';
            }

            $suggestions[$strategy] = [
                'book_id' => $bookId,
                'classification' => $cls,
                'strategy' => $strategy,
                'rating' => $rating,
                'user' => $user,
                'source' => $source,
            ];

            if (count($suggestions) >= count($uncoveredStrategies)) break;
        }

        return array_values($suggestions);
    }
}
