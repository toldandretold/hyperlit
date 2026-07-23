<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>Citation Pipeline Failure</title>
</head>
<body style="margin:0; padding:20px; background:#221F20; color:#ddd; font-family:monospace; font-size:13px;">
    <h2 style="color:#ef4444;">Citation pipeline failed</h2>

    <table style="border-collapse:collapse; width:100%; margin-bottom:20px;">
        <tr><td style="padding:4px 12px 4px 0; color:#888;">Pipeline</td><td>{{ $pipeline['id'] ?? '?' }}</td></tr>
        <tr><td style="padding:4px 12px 4px 0; color:#888;">Book</td><td>{{ $pipeline['book'] ?? '?' }} — {{ $bookTitle }}</td></tr>
        <tr><td style="padding:4px 12px 4px 0; color:#888;">User</td><td>{{ $userName ?? 'unknown' }} ({{ $userEmail ?? 'no email' }})</td></tr>
        <tr><td style="padding:4px 12px 4px 0; color:#888;">Status</td><td>{{ $pipeline['status'] ?? '?' }}</td></tr>
        <tr><td style="padding:4px 12px 4px 0; color:#888;">Step reached</td><td>{{ $pipeline['current_step'] ?? '?' }} — {{ $pipeline['step_detail'] ?? '' }}</td></tr>
        <tr><td style="padding:4px 12px 4px 0; color:#888;">Inference mode</td><td>{{ $pipeline['inference_mode'] ?? 'server' }}</td></tr>
        <tr><td style="padding:4px 12px 4px 0; color:#888;">Created / updated</td><td>{{ $pipeline['created_at'] ?? '' }} → {{ $pipeline['updated_at'] ?? '' }}</td></tr>
    </table>

    @if(!empty($pipeline['error']))
    <h3 style="color:#f59e0b;">Error</h3>
    <pre style="padding:12px; background:#1a1a1a; border-radius:6px; margin-bottom:20px; overflow-x:auto; white-space:pre-wrap; word-break:break-word;">{{ $pipeline['error'] }}</pre>
    @endif

    @if(!empty($stepTimings))
    <h3 style="color:#a78bfa;">Step timings</h3>
    <pre style="padding:12px; background:#1a1a1a; border-radius:6px; margin-bottom:20px; overflow-x:auto; white-space:pre-wrap; word-break:break-word;">{{ json_encode($stepTimings, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES) }}</pre>
    @endif

    @if(!empty($telemetryTail))
    <h3 style="color:#22c55e;">Telemetry (last {{ count($telemetryTail) }} events — full stream attached)</h3>
    <pre style="padding:12px; background:#1a1a1a; border-radius:6px; margin-bottom:20px; overflow-x:auto; white-space:pre-wrap; word-break:break-word;">@foreach($telemetryTail as $e)[{{ $e['at'] ?? '' }}] {{ $e['stage'] ?? '' }}@if(!empty($e['substage']))/{{ $e['substage'] }}@endif {{ $e['status'] ?? '' }}@if(!empty($e['detail'])) — {{ $e['detail'] }}@endif @if(!empty($e['signals'])) {{ json_encode($e['signals']) }}@endif

@endforeach</pre>
    @endif

    <p style="color:#888;">Sent automatically by PipelineFailureNotifier. The user received CitationReviewFailedMail for the same failure.</p>
</body>
</html>
