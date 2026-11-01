<?php

use App\Mail\McpBugReportMail;
use App\Mcp\TokenAbilities;
use App\Models\User;
use Illuminate\Support\Facades\Mail;

/**
 * The agent-filed bug-report channel (report_bug): consent-gated by the
 * 'report' token ability (the checkbox at token creation), rate-limited per
 * user, server-stamped identity, and the IntegrityReportController
 * invariant — a bug report must never itself 500, so a mail failure still
 * returns success (the log line is the durable record).
 */

function rbToken(User $user, array $abilities): string
{
    return $user->createToken('mcp report test', $abilities, now()->addYear())->plainTextToken;
}

function rbText($response): string
{
    return (string) ($response->json('result')['content'][0]['text'] ?? '');
}

function reportBugCall($test, string $token, array $arguments)
{
    app('auth')->forgetGuards();

    return $test->postJson('/mcp', [
        'jsonrpc' => '2.0',
        'id' => 1,
        'method' => 'tools/call',
        'params' => ['name' => 'report_bug', 'arguments' => $arguments],
    ], [
        'Authorization' => 'Bearer '.$token,
        'Accept' => 'application/json, text/event-stream',
    ]);
}

test('a consented token files a report and the maintainer is mailed', function () {
    Mail::fake();
    $user = $this->seedUser();
    $token = rbToken($user, [TokenAbilities::READ, TokenAbilities::REPORT]);

    $response = reportBugCall($this, $token, [
        'summary' => 'read_book returned the wrong chunk',
        'detail' => 'Called read_book with after_line=100 and got nodes before it.',
        'tool_name' => 'read_book',
        'severity' => 'medium',
    ]);

    expect($response->json('result.isError'))->not->toBeTrue();
    expect(rbText($response))->toContain('Report filed');

    Mail::assertSent(McpBugReportMail::class);
});

test('without the report ability the tool is not even registered', function () {
    Mail::fake();
    $user = $this->seedUser();
    $token = rbToken($user, [TokenAbilities::READ]);

    $response = reportBugCall($this, $token, [
        'summary' => 'x', 'detail' => 'y',
    ]);

    expect($response->json('error.code'))->toBe(-32602);
    Mail::assertNothingSent();
});

test('a mail failure never fails the report', function () {
    Mail::shouldReceive('send')->andThrow(new RuntimeException('smtp down'));
    $user = $this->seedUser();
    $token = rbToken($user, [TokenAbilities::READ, TokenAbilities::REPORT]);

    $response = reportBugCall($this, $token, [
        'summary' => 'anything', 'detail' => 'still lands in the log',
    ]);

    expect($response->json('result.isError'))->not->toBeTrue();
    expect(rbText($response))->toContain('Report filed');
});

test('the per-user rate limit refuses the sixth report in an hour', function () {
    Mail::fake();
    $user = $this->seedUser();
    $token = rbToken($user, [TokenAbilities::READ, TokenAbilities::REPORT]);

    foreach (range(1, 5) as $i) {
        $ok = reportBugCall($this, $token, [
            'summary' => "report $i", 'detail' => 'detail',
        ]);
        expect($ok->json('result.isError'))->not->toBeTrue();
    }

    $sixth = reportBugCall($this, $token, [
        'summary' => 'report 6', 'detail' => 'detail',
    ]);
    expect($sixth->json('result.isError'))->toBeTrue();
    expect(rbText($sixth))->toContain('limit');
});

test('the maintainer mailable renders', function () {
    // Mail::fake() never runs build() or the blade — render it for real so a
    // template typo cannot ship.
    $html = (new McpBugReportMail([
        'user_id' => 1,
        'user_name' => 'tester',
        'token_name' => 'mcp test',
        'token_abilities' => ['read', 'report'],
        'filed_at' => now()->toIso8601String(),
        'summary' => 'something broke',
        'detail' => 'the gory details',
        'tool_name' => 'read_book',
        'book' => null,
        'severity' => 'low',
    ]))->render();

    expect($html)->toContain('MCP bug report')
        ->toContain('something broke')
        ->toContain('the gory details');
});

test('book is optional and an unresolvable book never refuses the report', function () {
    Mail::fake();
    $user = $this->seedUser();
    $token = rbToken($user, [TokenAbilities::READ, TokenAbilities::REPORT]);

    $response = reportBugCall($this, $token, [
        'summary' => 'import stuck',
        'detail' => 'import_status looped forever',
        'book' => 'book_definitely_not_real_zzz',
    ]);

    expect($response->json('result.isError'))->not->toBeTrue();
    expect(rbText($response))->toContain('Report filed');
});
