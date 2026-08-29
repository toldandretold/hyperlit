<?php

/**
 * POST /api/maintainer/conversion/golden/{book} — the "approve as golden" step
 * of the case loop: freeze the book's regression fixture via run_regression.py
 * --update-golden. The python shell-out lives behind GoldenApprover so these
 * tests mock it — they cover gating (admin, production, book-id shape) and the
 * result plumbing, plus the service's own no-fixture refusal (no shell-out).
 */

use App\Services\Conversion\GoldenApprover;

test('the golden endpoint is auth- and admin-gated', function () {
    $this->postJson('/api/maintainer/conversion/golden/goldtest_x')->assertStatus(401);

    $this->loginUser(); // authenticated but NOT admin
    $this->postJson('/api/maintainer/conversion/golden/goldtest_x')->assertStatus(403);
});

test('the golden endpoint 404s in production — repo files are never rewritten from a prod request', function () {
    $this->loginUser(['is_admin' => true]);
    app()->detectEnvironment(fn () => 'production');

    $this->postJson('/api/maintainer/conversion/golden/goldtest_x')->assertNotFound();
});

test('a malformed book id never reaches the approver (route constraint)', function () {
    $this->loginUser(['is_admin' => true]);
    $this->mock(GoldenApprover::class)->shouldNotReceive('approve');

    $this->postJson('/api/maintainer/conversion/golden/gold.test')->assertNotFound();
});

test('the endpoint relays the approver result: 200 on ok, 422 on refusal', function () {
    $this->loginUser(['is_admin' => true]);

    $this->mock(GoldenApprover::class)
        ->shouldReceive('approve')->once()->with('goldtest_ok')
        ->andReturn(['ok' => true, 'tree' => 'fixtures-local', 'exit_code' => 0, 'output_tail' => 'PASS']);
    $this->postJson('/api/maintainer/conversion/golden/goldtest_ok')
        ->assertOk()
        ->assertJsonPath('ok', true)
        ->assertJsonPath('tree', 'fixtures-local');

    $this->mock(GoldenApprover::class)
        ->shouldReceive('approve')->once()->with('goldtest_refused')
        ->andReturn(['ok' => false, 'message' => 'No captured fixture for goldtest_refused — import the case bundle first (book:import-cases).']);
    $this->postJson('/api/maintainer/conversion/golden/goldtest_refused')
        ->assertStatus(422)
        ->assertJsonPath('ok', false)
        ->assertJsonPath('message', 'No captured fixture for goldtest_refused — import the case bundle first (book:import-cases).');
});

test('the real approver refuses a book with no captured fixture without shelling python', function () {
    $result = app(GoldenApprover::class)->approve('goldtest_definitely_absent');

    expect($result['ok'])->toBeFalse();
    expect($result['message'])->toContain('No captured fixture');
});
