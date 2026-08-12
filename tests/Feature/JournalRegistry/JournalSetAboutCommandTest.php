<?php

/**
 * journal:set-about — operator copy for /j/{slug}. Set / overwrite / --clear /
 * unknown slug. Seeds via pgsql_admin, beforeEach-only cleanup.
 */

use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

function jaboutCleanup(): void
{
    DB::connection('pgsql_admin')->table('journal_sources')
        ->where('display_name', 'LIKE', 'JAbout %')->delete();
}

beforeEach(fn() => jaboutCleanup());

function jaboutSeed(): string
{
    $slug = 'jabout-' . Str::lower(Str::random(8));
    DB::connection('pgsql_admin')->table('journal_sources')->insert([
        'id'                 => (string) Str::uuid(),
        'openalex_source_id' => 'SJABOUT' . Str::upper(Str::random(6)),
        'display_name'       => 'JAbout Journal',
        'slug'               => $slug,
        'is_diamond'         => true,
        'created_at'         => now(),
        'updated_at'         => now(),
    ]);
    return $slug;
}

test('sets, overwrites, and clears the about copy', function () {
    $slug = jaboutSeed();
    $value = fn () => DB::table('journal_sources')->where('slug', $slug)->value('about');

    $this->artisan('journal:set-about', ['slug' => $slug, 'text' => 'First copy.'])->assertExitCode(0);
    expect($value())->toBe('First copy.');

    $this->artisan('journal:set-about', ['slug' => $slug, 'text' => 'Second copy.'])->assertExitCode(0);
    expect($value())->toBe('Second copy.');

    $this->artisan('journal:set-about', ['slug' => $slug, '--clear' => true])->assertExitCode(0);
    expect($value())->toBeNull();
});

test('refuses unknown slug and empty text', function () {
    $this->artisan('journal:set-about', ['slug' => 'no-such-slug', 'text' => 'X'])->assertExitCode(1);

    $slug = jaboutSeed();
    $this->artisan('journal:set-about', ['slug' => $slug])->assertExitCode(1);
});
