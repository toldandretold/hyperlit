<?php

namespace Tests\Unit\Support;

use App\Support\AuthorList;
use PHPUnit\Framework\TestCase;

/**
 * AuthorList — the server-side author-list vocabulary (mirrors
 * resources/js/utilities/authorList.ts; its vitest twin is
 * tests/javascript/utilities/authorList.test.js — keep the cases in lockstep).
 */
class AuthorListTest extends TestCase
{
    private const UUID = '123e4567-e89b-42d3-a456-426614174000';
    private const MUNGER = 'Kevin Munger; Bert N. Bakker; Adam J. Berinsky';

    public function test_split_handles_semicolon_joined_lists(): void
    {
        $this->assertSame(
            ['Kevin Munger', 'Bert N. Bakker', 'Adam J. Berinsky'],
            AuthorList::split(self::MUNGER)
        );
    }

    public function test_split_handles_and_joined_bibtex_lists(): void
    {
        $this->assertSame(
            ['Munger, Kevin', 'Bakker, Bert N.', 'Berinsky, Adam J.'],
            AuthorList::split('Munger, Kevin and Bakker, Bert N. and Berinsky, Adam J.')
        );
    }

    public function test_split_prefers_semicolons_protecting_corporate_names(): void
    {
        $this->assertSame(
            ['Institute for War and Peace Reporting', 'Jane Doe'],
            AuthorList::split('Institute for War and Peace Reporting; Jane Doe')
        );
    }

    public function test_split_keeps_braced_segments_atomic_with_braces(): void
    {
        $this->assertSame(
            ['{World Health Organization}', 'Smith, Jo'],
            AuthorList::split('{World Health Organization} and Smith, Jo')
        );
    }

    public function test_split_treats_uuid_as_atomic(): void
    {
        $this->assertSame([self::UUID], AuthorList::split(self::UUID));
    }

    public function test_format_for_reference_lists_small_sets_in_full(): void
    {
        $this->assertSame(
            'Kevin Munger, Bert N. Bakker & Adam J. Berinsky',
            AuthorList::formatForReference(self::MUNGER)
        );
        $this->assertSame('Prashad, Vijay', AuthorList::formatForReference('Prashad, Vijay'));
    }

    public function test_format_for_reference_cuts_past_ten_to_seven_et_al(): void
    {
        $eleven = implode('; ', array_map(fn ($i) => "Author {$i}", range(1, 11)));
        $expected = implode(', ', array_map(fn ($i) => "Author {$i}", range(1, 7))) . ', et al.';
        $this->assertSame($expected, AuthorList::formatForReference($eleven));

        $ten = implode('; ', array_map(fn ($i) => "Author {$i}", range(1, 10)));
        $this->assertStringNotContainsString('et al.', AuthorList::formatForReference($ten));
    }

    public function test_format_for_reference_passes_anon_labels_and_uuids_through(): void
    {
        $this->assertSame(self::UUID, AuthorList::formatForReference(self::UUID));
        $this->assertSame('Anon', AuthorList::formatForReference('Anon'));
        $this->assertSame('Anon (me)', AuthorList::formatForReference('Anon (me)'));
    }

    public function test_format_for_reference_strips_protective_braces_for_display(): void
    {
        $this->assertSame(
            'World Health Organization & Smith, Jo',
            AuthorList::formatForReference('{World Health Organization}; Smith, Jo')
        );
    }

    public function test_to_bibtex_field_converts_semicolons_to_and(): void
    {
        $this->assertSame(
            'Kevin Munger and Bert N. Bakker and Adam J. Berinsky',
            AuthorList::toBibtexField(self::MUNGER)
        );
    }

    public function test_to_bibtex_field_round_trips_and_joined_input(): void
    {
        $bibtexForm = 'Munger, Kevin and Bakker, Bert N.';
        $this->assertSame($bibtexForm, AuthorList::toBibtexField($bibtexForm));
    }

    public function test_to_bibtex_field_passes_uuid_through(): void
    {
        $this->assertSame(self::UUID, AuthorList::toBibtexField(self::UUID));
    }
}
