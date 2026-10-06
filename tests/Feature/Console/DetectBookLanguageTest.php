<?php

/**
 * library:detect-language + DetectBookLanguageJob — stamping
 * library.language_detected from node content.
 *
 * Contracts under test: both columns written on pgsql_admin; a NULL detection
 * still stamps language_detected_at (so --stale doesn't retry an undetectable
 * book forever); encrypted books and sub-books are never touched; --stale
 * re-detects only when library.timestamp moved past the stamp.
 */

use App\Jobs\DetectBookLanguageJob;
use Illuminate\Support\Facades\DB;

const DBL_DE = 'rls_dbl_german_book';
const DBL_SHORT = 'rls_dbl_short_book';
const DBL_ENC = 'rls_dbl_encrypted_book';

function dblAdmin()
{
    return DB::connection('pgsql_admin');
}

function dblSeedGermanNodes($test, string $book): void
{
    // Enough German prose to clear the detector's floors with margin.
    // (Direct admin inserts — the trait's seedNode is protected and these
    // helper functions run in global scope.)
    $texts = [
        'Die Geschichte der Philosophie ist nicht nur eine Geschichte der Ideen, sondern auch eine Geschichte der Menschen, die sie gedacht haben.',
        'Der Begriff wird oft verwendet, um das Verhältnis zwischen Theorie und Praxis zu beschreiben, aber nur wenige haben sich mit der Frage auseinandergesetzt.',
        'Es ist nicht leicht, diese Entwicklung zu verstehen, wenn man die sozialen Bedingungen nicht kennt, unter denen sie stattgefunden hat.',
    ];
    foreach ($texts as $i => $t) {
        dblAdmin()->table('nodes')->updateOrInsert(
            ['book' => $book, 'startLine' => ($i + 1) * 100],
            ['book' => $book, 'startLine' => ($i + 1) * 100, 'chunk_id' => 0, 'content' => "<p>{$t}</p>", 'type' => 'p', 'created_at' => now(), 'updated_at' => now()],
        );
    }
}

afterEach(function () {
    dblAdmin()->table('nodes')->whereIn('book', [DBL_DE, DBL_SHORT, DBL_ENC, DBL_ENC.'/Fn1'])->delete();
});

it('stamps language_detected + _at for a detectable book, and _at alone for an undetectable one', function () {
    $this->seedLibrary(['book' => DBL_DE, 'has_nodes' => true, 'timestamp' => 1000]);
    dblSeedGermanNodes($this, DBL_DE);

    $this->seedLibrary(['book' => DBL_SHORT, 'has_nodes' => true, 'timestamp' => 1000]);
    $this->seedNode(['book' => DBL_SHORT, 'startLine' => 100, 'content' => '<p>Body</p>', 'type' => 'p']);

    (new DetectBookLanguageJob(DBL_DE))->handle();
    (new DetectBookLanguageJob(DBL_SHORT))->handle();

    $de = dblAdmin()->table('library')->where('book', DBL_DE)->first(['language_detected', 'language_detected_at']);
    expect($de->language_detected)->toBe('de')
        ->and($de->language_detected_at)->not->toBeNull();

    // Confidently unknown: NULL code, but the attempt IS recorded — otherwise
    // the weekly --stale sweep would retry the same 4-char book forever.
    $short = dblAdmin()->table('library')->where('book', DBL_SHORT)->first(['language_detected', 'language_detected_at']);
    expect($short->language_detected)->toBeNull()
        ->and($short->language_detected_at)->not->toBeNull();
});

it('never touches encrypted books or sub-books', function () {
    $this->seedLibrary(['book' => DBL_ENC, 'has_nodes' => true, 'encrypted' => true, 'timestamp' => 1000]);
    $this->seedNode(['book' => DBL_ENC, 'startLine' => 100, 'content' => 'hlenc.v1.IV.CT', 'type' => 'p']);

    (new DetectBookLanguageJob(DBL_ENC))->handle();
    (new DetectBookLanguageJob(DBL_ENC.'/Fn1'))->handle();

    $row = dblAdmin()->table('library')->where('book', DBL_ENC)->first(['language_detected', 'language_detected_at']);
    expect($row->language_detected)->toBeNull()
        ->and($row->language_detected_at)->toBeNull();
});

it('library:detect-language is dry-run by default and writes with --apply', function () {
    $this->seedLibrary(['book' => DBL_DE, 'has_nodes' => true, 'timestamp' => 1000]);
    // seedLibrary is an updateOrInsert over a fixed book id — scrub any stamp
    // left by an earlier test in this file so the dry-run assertion is clean.
    dblAdmin()->table('library')->where('book', DBL_DE)
        ->update(['language_detected' => null, 'language_detected_at' => null]);
    dblSeedGermanNodes($this, DBL_DE);

    $this->artisan('library:detect-language', ['--book' => [DBL_DE]])
        ->expectsOutputToContain('DRY RUN')
        ->assertSuccessful();
    expect(dblAdmin()->table('library')->where('book', DBL_DE)->value('language_detected'))->toBeNull();

    $this->artisan('library:detect-language', ['--book' => [DBL_DE], '--apply' => true])
        ->assertSuccessful();
    expect(dblAdmin()->table('library')->where('book', DBL_DE)->value('language_detected'))->toBe('de');
});

it('--stale re-detects after a content timestamp bump and skips fresh stamps', function () {
    $this->seedLibrary(['book' => DBL_DE, 'has_nodes' => true, 'timestamp' => 1000]);
    dblSeedGermanNodes($this, DBL_DE);

    // Freshly stamped, timestamp older than the stamp → out of --stale scope.
    dblAdmin()->table('library')->where('book', DBL_DE)->update([
        'language_detected' => 'fr', // deliberately wrong, to see whether it re-runs
        'language_detected_at' => now(),
    ]);
    $this->artisan('library:detect-language', ['--stale' => true, '--apply' => true, '--book' => []])
        ->assertSuccessful();
    expect(dblAdmin()->table('library')->where('book', DBL_DE)->value('language_detected'))->toBe('fr');

    // Content changed since the stamp (timestamp is epoch ms, in the future
    // relative to the stamp) → --stale re-detects and corrects it.
    dblAdmin()->table('library')->where('book', DBL_DE)->update([
        'timestamp' => (string) ((now()->timestamp + 3600) * 1000),
    ]);
    $this->artisan('library:detect-language', ['--stale' => true, '--apply' => true, '--book' => []])
        ->assertSuccessful();
    expect(dblAdmin()->table('library')->where('book', DBL_DE)->value('language_detected'))->toBe('de');
});
