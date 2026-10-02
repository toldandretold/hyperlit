<?php

/**
 * nodes:backfill-plaintext — the nightly plainText self-heal.
 *
 * The contract under test: NULL and '' plainText holes are filled with bare
 * strip_tags(content) (the ONLY permitted derivation — annotation
 * charStart/charEnd coordinates live in that space), while encrypted books
 * are untouchable two ways: the library.encrypted tree exclusion AND the
 * row-level hlenc envelope guard (a mid-publish straggler whose flag is
 * already false but whose content is still ciphertext). Without those guards
 * the nightly schedule would fill E2EE books with strip_tags(ciphertext) and
 * then queue embeddings over garbage — see docs/e2ee.md.
 */

use Illuminate\Support\Facades\DB;

const BPT_BOOK = 'rls_bpt_plain_book';
const BPT_ENC_BOOK = 'rls_bpt_enc_book';
const BPT_PUB_BOOK = 'rls_bpt_midpublish_book';

it('fills NULL and empty plainText from content, and never touches encrypted trees or envelope rows', function () {
    $this->seedLibrary(['book' => BPT_BOOK]);
    $this->seedLibrary(['book' => BPT_ENC_BOOK, 'encrypted' => true]);
    $this->seedLibrary(['book' => BPT_PUB_BOOK]); // mid-publish: flag already false…

    // The holes the sweep exists for:
    $this->seedNode(['book' => BPT_BOOK, 'startLine' => 1, 'content' => '<p>needs <em>healing</em></p>', 'plainText' => null]);
    $this->seedNode(['book' => BPT_BOOK, 'startLine' => 2, 'content' => '<p>empty hole</p>', 'plainText' => '']);
    // A populated row must not be rewritten (not --force):
    $this->seedNode(['book' => BPT_BOOK, 'startLine' => 3, 'content' => '<div>card html</div>', 'plainText' => 'crafted citation text']);
    // Encrypted tree (library flag): ciphertext content, NULL plainText — the exact target shape.
    $this->seedNode(['book' => BPT_ENC_BOOK, 'startLine' => 1, 'content' => 'hlenc.v1.IV.CT', 'plainText' => null]);
    $this->seedNode(['book' => BPT_ENC_BOOK.'/Fn1', 'startLine' => 1, 'content' => 'hlenc.v1.IV.CT2', 'plainText' => null]);
    // …but this book's node content is still an envelope (row-level guard):
    $this->seedNode(['book' => BPT_PUB_BOOK, 'startLine' => 1, 'content' => 'hlenc.v1.IV.STRAGGLER', 'plainText' => null]);

    $this->artisan('nodes:backfill-plaintext', ['--no-embed' => true, '--no-interaction' => true])
        ->assertSuccessful();

    $admin = DB::connection('pgsql_admin');
    expect($admin->table('nodes')->where('book', BPT_BOOK)->where('startLine', 1)->value('plainText'))
        ->toBe('needs healing');
    expect($admin->table('nodes')->where('book', BPT_BOOK)->where('startLine', 2)->value('plainText'))
        ->toBe('empty hole');
    expect($admin->table('nodes')->where('book', BPT_BOOK)->where('startLine', 3)->value('plainText'))
        ->toBe('crafted citation text');
    expect($admin->table('nodes')->where('book', BPT_ENC_BOOK)->where('startLine', 1)->value('plainText'))
        ->toBeNull();
    expect($admin->table('nodes')->where('book', BPT_ENC_BOOK.'/Fn1')->where('startLine', 1)->value('plainText'))
        ->toBeNull();
    expect($admin->table('nodes')->where('book', BPT_PUB_BOOK)->where('startLine', 1)->value('plainText'))
        ->toBeNull();
});
