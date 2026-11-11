<?php

/**
 * Licence writes through POST /api/db/library/upsert (DbLibraryController::resolveLicenseUpdate).
 *
 * The bug that started this: the source-container form sends `license: ''` whenever the stored
 * code is not one of its picker options, and `$data['license'] ?? $stored` stored the empty
 * string — so editing the TITLE of a harvested CC BY-NC-ND work silently relabelled it with the
 * site's own CC BY-SA No-AI licence.
 */

/**
 * The upsert writes on the DEFAULT connection inside RefreshDatabase's transaction, which the
 * pgsql_admin connection cannot see — so read back through the same connection (as the owner).
 */
function licenseRow(string $book): object
{
    return (object) \App\Models\PgLibrary::where('book', $book)->firstOrFail()->getAttributes();
}

beforeEach(function () {
    $this->user = $this->seedUser();
    $this->own = fn (string $book, array $attrs = []) => $this->seedLibrary(array_merge([
        'book' => $book,
        'title' => 'T ' . $book,
        'creator' => $this->user->name,
        'creator_token' => $this->user->user_token,
        'visibility' => 'public',
    ], $attrs));
});

test('a blank licence in an unrelated metadata edit keeps the stored licence', function () {
    ($this->own)('lic_keep', ['license' => 'CC-BY-NC-ND-4.0']);

    $this->actingAs($this->user)->postJson('/api/db/library/upsert', ['data' => [
        'book' => 'lic_keep', 'title' => 'Renamed', 'license' => '', 'custom_license_text' => '',
    ]])->assertOk();

    expect(licenseRow('lic_keep')->license)->toBe('CC-BY-NC-ND-4.0');
    expect(licenseRow('lic_keep')->title)->toBe('Renamed');
});

test('a mis-cased code is canonicalised and an unknown string is kept as custom text', function () {
    ($this->own)('lic_case');

    $this->actingAs($this->user)->postJson('/api/db/library/upsert', ['data' => ['book' => 'lic_case', 'license' => 'cc-by-3.0']])->assertOk();
    expect(licenseRow('lic_case')->license)->toBe('CC-BY-3.0');

    $this->actingAs($this->user)->postJson('/api/db/library/upsert', ['data' => ['book' => 'lic_case', 'license' => 'WTFPL']])->assertOk();
    expect(licenseRow('lic_case')->license)->toBe('custom');
    expect(licenseRow('lic_case')->custom_license_text)->toBe('WTFPL');
});

test('a custom licence can point at the owner\'s own public licence book, pinned to when it was applied', function () {
    ($this->own)('lic_terms');
    ($this->own)('lic_work');

    $before = (int) round(microtime(true) * 1000);
    $this->actingAs($this->user)->postJson('/api/db/library/upsert', ['data' => [
        'book' => 'lic_work', 'license' => 'custom', 'license_book' => 'lic_terms', 'custom_license_text' => 'snapshot',
    ]])->assertOk();

    $row = licenseRow('lic_work');
    expect($row->license)->toBe('custom');
    expect($row->license_book)->toBe('lic_terms');
    expect((int) $row->license_book_at)->toBeGreaterThanOrEqual($before);
    $pinned = (int) $row->license_book_at;

    // An unrelated later edit, even one echoing the record back with a forged timestamp,
    // must not move the pin: license_book_at is server-owned.
    $this->actingAs($this->user)->postJson('/api/db/library/upsert', ['data' => [
        'book' => 'lic_work', 'title' => 'Edited', 'license' => 'custom', 'license_book' => 'lic_terms', 'license_book_at' => 1,
    ]])->assertOk();
    expect((int) licenseRow('lic_work')->license_book_at)->toBe($pinned);

    // Re-apply on request moves it forward.
    usleep(2000);
    $this->actingAs($this->user)->postJson('/api/db/library/upsert', ['data' => [
        'book' => 'lic_work', 'license' => 'custom', 'license_book' => 'lic_terms', 'license_book_reapply' => true,
    ]])->assertOk();
    expect((int) licenseRow('lic_work')->license_book_at)->toBeGreaterThan($pinned);
});

test('a licence book must be the same owner\'s, public and unencrypted', function () {
    $other = $this->seedUser();
    $this->seedLibrary(['book' => 'lic_foreign', 'title' => 'x', 'creator' => $other->name, 'creator_token' => $other->user_token, 'visibility' => 'public']);
    ($this->own)('lic_private', ['visibility' => 'private']);
    ($this->own)('lic_target');

    foreach (['lic_foreign', 'lic_private', 'lic_missing'] as $bad) {
        $this->actingAs($this->user)->postJson('/api/db/library/upsert', ['data' => [
            'book' => 'lic_target', 'license' => 'custom', 'license_book' => $bad,
        ]])->assertOk();
        expect(licenseRow('lic_target')->license_book)->toBeNull();
    }
});

test('leaving custom clears the custom-only columns', function () {
    ($this->own)('lic_terms2');
    ($this->own)('lic_leave');
    $this->actingAs($this->user)->postJson('/api/db/library/upsert', ['data' => [
        'book' => 'lic_leave', 'license' => 'custom', 'license_book' => 'lic_terms2', 'custom_license_text' => 'mine',
    ]])->assertOk();

    $this->actingAs($this->user)->postJson('/api/db/library/upsert', ['data' => ['book' => 'lic_leave', 'license' => 'CC0']])->assertOk();

    $row = licenseRow('lic_leave');
    expect($row->license)->toBe('CC0');
    expect($row->license_book)->toBeNull();
    expect($row->license_book_at)->toBeNull();
    expect($row->custom_license_text)->toBeNull();
});

test('a licence the owner changes is stamped as theirs; an unrelated edit keeps the provenance', function () {
    // library:discover-licenses never overwrites license_source = 'user'.
    ($this->own)('lic_prov', ['license' => 'Unknown', 'license_source' => 'crossref']);

    $this->actingAs($this->user)->postJson('/api/db/library/upsert', ['data' => ['book' => 'lic_prov', 'title' => 'Renamed', 'license' => '']])->assertOk();
    expect(licenseRow('lic_prov')->license_source)->toBe('crossref');

    $this->actingAs($this->user)->postJson('/api/db/library/upsert', ['data' => ['book' => 'lic_prov', 'license' => 'CC-BY-4.0']])->assertOk();
    expect(licenseRow('lic_prov')->license_source)->toBe('user');
});
