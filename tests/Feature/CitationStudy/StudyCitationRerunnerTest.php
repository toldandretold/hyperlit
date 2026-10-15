<?php

/**
 * The single-citation rerunner: guard rails first (frozen corpus, no base run,
 * reimport drift via bound_at, stale refIds in the base claims), then the
 * patch itself — fresh rows merged in place into a NEW sub-versioned run dir
 * ({base}.N), provenance carrying the patched block, state.json repointed with
 * the base record archived into history and the base pipeline_id retained.
 *
 * The child pipeline process is stubbed by overriding runTargetedPipeline —
 * the real one spawns php artisan citation:pipeline, which is the one step a
 * test cannot run (LLM + network).
 */

use App\Services\CitationStudy\ClaimsPatcher;
use App\Services\CitationStudy\CorpusManifest;
use App\Services\CitationStudy\ProvenanceRecorder;
use App\Services\CitationStudy\StudyBookImporter;
use App\Services\CitationStudy\StudyCitationRerunner;
use App\Services\CitationStudy\StudyRunner;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\File;
use Illuminate\Support\Facades\Hash;
use Illuminate\Support\Str;

const RERUN_ROOT = 'storage/framework/testing/citation-study-rerun';

function rrDb()
{
    return DB::connection('pgsql_admin');
}

/**
 * A corpus on a temp study.root with one imported book, a bound ground truth
 * and a completed base run whose claims file carries three rows (ref_A,
 * ref_A::sub1, ref_B). Returns [manifest, bookId, context array].
 */
function rrCorpus(array $overrides = []): array
{
    config(['study.root' => RERUN_ROOT]);
    $corpus = 'rr' . strtolower(Str::random(6));
    $dir = base_path(RERUN_ROOT . "/corpora/{$corpus}");
    File::ensureDirectoryExists("{$dir}/sources/fixture");
    File::put("{$dir}/sources/fixture/original.md", "# stub\n");

    File::put("{$dir}/manifest.json", json_encode([
        'corpus' => $corpus,
        'frozen' => $overrides['frozen'] ?? false,
        'books' => [[
            'slug' => 'fixture',
            'arm' => 'control',
            'source_file' => 'sources/fixture/original.md',
        ]],
    ]));

    $boundAt = $overrides['bound_at'] ?? now()->subDay()->toIso8601String();
    File::put("{$dir}/sources/fixture/ground_truth.json", json_encode([
        'entries' => [
            // Real binders mint slug-prefixed gt_ids ("fixture/c01"); the
            // rerunner must accept the bare form the workbench displays.
            ['gt_id' => 'fixture/c01', 'label' => 'intact', 'bib_text_hash' => 'h1', 'bound_reference_id' => 'ref_A'],
            ['gt_id' => 'fixture/c02', 'label' => 'intact', 'bib_text_hash' => 'h2', 'bound_reference_id' => 'ref_B'],
            ['gt_id' => 'fixture/c03', 'label' => 'intact', 'bib_text_hash' => 'h3', 'bound_reference_id' => null],
        ],
        'binding' => ['bound_at' => $boundAt],
    ]));

    $manifest = CorpusManifest::load($corpus);
    $bookId = $manifest->bookIdFor('fixture');

    rrDb()->table('library')->insert([
        'book' => $bookId, 'title' => 'Rerun Fixture', 'visibility' => 'public', 'listed' => false,
        'raw_json' => '[]', 'timestamp' => 0, 'created_at' => now(), 'updated_at' => now(),
    ]);
    foreach (['ref_A', 'ref_B'] as $ref) {
        rrDb()->table('bibliography')->insert([
            'book' => $bookId, 'referenceId' => $ref, 'content' => "cite {$ref}",
            'created_at' => now(), 'updated_at' => now(),
        ]);
    }

    // Base run: claims file + coverage + state record.
    $baseRunId = $overrides['base_run_id'] ?? '20260101_000000_abcd1234';
    $baseDir = $manifest->resultsDir() . "/runs/{$baseRunId}";
    File::ensureDirectoryExists($baseDir);
    $baseClaims = $overrides['base_claims'] ?? [
        ['referenceId' => 'ref_A', 'truth_claim' => 'old A'],
        ['referenceId' => 'ref_A::sub1', 'truth_claim' => 'old A sub'],
        ['referenceId' => 'ref_B', 'truth_claim' => 'old B'],
    ];
    File::put("{$baseDir}/fixture.claims.json", json_encode($baseClaims));
    File::put("{$baseDir}/fixture.coverage.json", json_encode(['citation_instances' => 3]));

    $state = [
        'corpus' => $corpus,
        'books' => ['fixture' => array_merge([
            'book_id' => $bookId,
            'run_id' => $baseRunId,
            'status' => 'completed',
            'started_at' => now()->subHours(2)->toIso8601String(),
            'pipeline_id' => 'base-pipeline-uuid',
            'claims_file' => "{$baseDir}/fixture.claims.json",
        ], $overrides['state_record'] ?? [])],
    ];
    File::ensureDirectoryExists($manifest->resultsDir());
    File::put($manifest->resultsDir() . '/state.json', json_encode($state));

    return [$manifest, $bookId, ['base_run_id' => $baseRunId, 'corpus' => $corpus]];
}

function rrStudyUser(): \App\Models\User
{
    $name = 'RerunStudy_' . Str::random(8);
    rrDb()->table('users')->insert([
        'name' => $name,
        'email' => strtolower($name) . '@test.local',
        'email_verified_at' => now(),
        'password' => Hash::make('password'),
        'user_token' => Str::uuid()->toString(),
        'status' => 'premium',
        'created_at' => now(),
        'updated_at' => now(),
    ]);
    config(['study.user_name' => $name]);
    return \App\Models\User::on('pgsql_admin')->where('name', $name)->firstOrFail();
}

/** Rerunner whose child pipeline is a stub writing $freshClaims as the partial file. */
function rrRerunner(?array $freshClaims, int $exit = 0): StudyCitationRerunner
{
    return new class($freshClaims, $exit) extends StudyCitationRerunner {
        public function __construct(private readonly ?array $fresh, private readonly int $exit)
        {
            parent::__construct(
                app(StudyBookImporter::class),
                app(ProvenanceRecorder::class),
                app(StudyRunner::class),
                new ClaimsPatcher,
            );
        }

        protected function runTargetedPipeline(string $bookId, string $referenceId, string $pipelineId, int $userId): array
        {
            if ($this->fresh !== null) {
                file_put_contents(
                    storage_path("app/citation-review-partial_{$bookId}_" . uniqid('', true) . '.json'),
                    json_encode($this->fresh),
                );
            }
            return ['exit' => $this->exit, 'output' => 'stub pipeline'];
        }
    };
}

function rrRun(CorpusManifest $manifest, string $citation, ?array $freshClaims, bool $dryRun = false, int $exit = 0): array
{
    return rrRerunner($freshClaims, $exit)->rerun($manifest, 'fixture', $citation, $dryRun, fn () => null);
}

afterEach(function () {
    rrDb()->table('library')->where('book', 'like', 'study_rr%')->delete();
    rrDb()->table('citation_pipelines')->where('book', 'like', 'study_rr%')->delete();
    rrDb()->table('users')->where('name', 'like', 'RerunStudy_%')->delete();
    File::deleteDirectory(base_path(RERUN_ROOT));
    foreach (glob(storage_path('app/citation-review-partial_study_rr*')) ?: [] as $f) {
        @unlink($f);
    }
});

it('refuses a frozen corpus', function () {
    [$manifest] = rrCorpus(['frozen' => true]);
    rrStudyUser();
    expect(fn () => rrRun($manifest, 'c01', null, true))
        ->toThrow(RuntimeException::class, 'frozen');
});

it('refuses when there is no completed base run', function () {
    [$manifest] = rrCorpus(['state_record' => ['status' => 'failed']]);
    rrStudyUser();
    expect(fn () => rrRun($manifest, 'c01', null, true))
        ->toThrow(RuntimeException::class, 'No completed base run');
});

it('refuses when the book was re-bound after the base run', function () {
    [$manifest] = rrCorpus(['bound_at' => now()->toIso8601String()]);
    rrStudyUser();
    expect(fn () => rrRun($manifest, 'c01', null, true))
        ->toThrow(RuntimeException::class, 're-imported/re-bound');
});

it('refuses when base claims carry refIds no longer live', function () {
    [$manifest] = rrCorpus(['base_claims' => [
        ['referenceId' => 'ref_A', 'truth_claim' => 'old A'],
        ['referenceId' => 'ref_GONE', 'truth_claim' => 'stale row'],
    ]]);
    rrStudyUser();
    expect(fn () => rrRun($manifest, 'c01', null, true))
        ->toThrow(RuntimeException::class, 'no longer exist');
});

it('refuses an unbound gt_id and an unknown refId', function () {
    [$manifest] = rrCorpus();
    rrStudyUser();
    expect(fn () => rrRun($manifest, 'c03', null, true))
        ->toThrow(RuntimeException::class, 'not bound');
    expect(fn () => rrRun($manifest, 'ref_NOPE', null, true))
        ->toThrow(RuntimeException::class, 'not found');
});

it('resolves gt_ids, raw refIds and ref:-prefixed ids, and mints the sub-version in dry-run', function () {
    [$manifest, , $ctx] = rrCorpus();
    rrStudyUser();

    $viaGt = rrRun($manifest, 'c01', null, true);
    expect($viaGt['reference_id'])->toBe('ref_A')
        ->and($viaGt['gt_ids'])->toBe(['fixture/c01'])
        ->and($viaGt['run_id'])->toBe($ctx['base_run_id'] . '.1')
        ->and($viaGt['base_run'])->toBe($ctx['base_run_id']);

    $viaRef = rrRun($manifest, 'ref:ref_B', null, true);
    expect($viaRef['reference_id'])->toBe('ref_B')->and($viaRef['gt_ids'])->toBe(['fixture/c02']);

    // A workbench multi-work row's key ("ref:...::subN") re-runs the whole
    // footnote — the sub re-enters the pool through its parent.
    $viaSub = rrRun($manifest, 'ref:ref_A::sub1', null, true);
    expect($viaSub['reference_id'])->toBe('ref_A');
});

it('aborts untouched when the targeted pipeline yields no claims', function () {
    [$manifest, , $ctx] = rrCorpus();
    rrStudyUser();

    expect(fn () => rrRun($manifest, 'c01', null))
        ->toThrow(RuntimeException::class, 'produced no claims');

    $state = json_decode(File::get($manifest->resultsDir() . '/state.json'), true);
    expect($state['books']['fixture']['run_id'])->toBe($ctx['base_run_id']);
});

it('patches the citation into a sub-versioned run and repoints state', function () {
    [$manifest, $bookId, $ctx] = rrCorpus();
    rrStudyUser();

    $fresh = [
        ['referenceId' => 'ref_A', 'truth_claim' => 'NEW A'],
        ['referenceId' => 'ref_A::sub1', 'truth_claim' => 'NEW A sub'],
    ];
    $result = rrRun($manifest, 'c01', $fresh);

    $newRunId = $ctx['base_run_id'] . '.1';
    expect($result['run_id'])->toBe($newRunId)
        ->and($result['replaced'])->toBe(2)
        ->and($result['inserted'])->toBe(2);

    $runDir = $manifest->resultsDir() . "/runs/{$newRunId}";
    $claims = json_decode(File::get("{$runDir}/fixture.claims.json"), true);
    expect(array_column($claims, 'referenceId'))->toBe(['ref_A', 'ref_A::sub1', 'ref_B'])
        ->and($claims[0]['truth_claim'])->toBe('NEW A')
        ->and($claims[2]['truth_claim'])->toBe('old B');

    $coverage = json_decode(File::get("{$runDir}/fixture.coverage.json"), true);
    expect($coverage['inherited_from_run'])->toBe($ctx['base_run_id'])
        ->and($coverage['citation_instances'])->toBe(3);

    $prov = json_decode(File::get("{$runDir}/provenance.json"), true);
    expect($prov['patched']['base_run'])->toBe($ctx['base_run_id'])
        ->and($prov['patched']['reference_id'])->toBe('ref_A')
        ->and($prov['patched']['gt_ids'])->toBe(['fixture/c01'])
        ->and($prov['patched']['replaced_rows'])->toBe(2);

    $state = json_decode(File::get($manifest->resultsDir() . '/state.json'), true);
    $record = $state['books']['fixture'];
    expect($record['run_id'])->toBe($newRunId)
        ->and($record['status'])->toBe('completed')
        ->and($record['claims_file'])->toBe("{$runDir}/fixture.claims.json")
        // Base pipeline_id retained: book cost columns keep describing the bulk run.
        ->and($record['pipeline_id'])->toBe('base-pipeline-uuid')
        ->and($record['patch']['base_run_id'])->toBe($ctx['base_run_id'])
        ->and($record['history'])->toHaveCount(1)
        ->and($record['history'][0]['run_id'])->toBe($ctx['base_run_id']);
});

it('numbers successive patches off the same root, even patching a patch', function () {
    [$manifest, , $ctx] = rrCorpus();
    rrStudyUser();

    $fresh = [['referenceId' => 'ref_A', 'truth_claim' => 'NEW A']];
    $first = rrRun($manifest, 'c01', $fresh);
    expect($first['run_id'])->toBe($ctx['base_run_id'] . '.1');

    // Second patch: base is now the .1 run; root stays the original.
    $second = rrRun($manifest, 'c02', [['referenceId' => 'ref_B', 'truth_claim' => 'NEW B']]);
    expect($second['run_id'])->toBe($ctx['base_run_id'] . '.2')
        ->and($second['base_run'])->toBe($ctx['base_run_id'] . '.1');
});
