<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>Import Failure</title>
</head>
<body style="margin:0; padding:20px; background:#221F20; color:#ddd; font-family:monospace; font-size:13px;">
    <h2 style="color:#ef4444;">Import failure ({{ $status ?? '?' }})</h2>

    <table style="border-collapse:collapse; width:100%; margin-bottom:20px;">
        <tr><td style="padding:4px 12px 4px 0; color:#888;">Book ID</td><td>{{ $bookId ?? 'unknown' }}</td></tr>
        <tr><td style="padding:4px 12px 4px 0; color:#888;">User</td><td>{{ $userName ?? 'anonymous' }} ({{ $userId ?? 'n/a' }})</td></tr>
        <tr><td style="padding:4px 12px 4px 0; color:#888;">Source</td><td>{{ $source ?? 'unknown' }}</td></tr>
        <tr><td style="padding:4px 12px 4px 0; color:#888;">Status</td><td>{{ $status ?? '' }}</td></tr>
        <tr><td style="padding:4px 12px 4px 0; color:#888;">Timestamp</td><td>{{ $timestamp ?? '' }}</td></tr>
        <tr><td style="padding:4px 12px 4px 0; color:#888;">User Agent</td><td style="word-break:break-all;">{{ $userAgent ?? '' }}</td></tr>
    </table>

    @if(!empty($comment))
    <h3 style="color:#22c55e;">User comment</h3>
    <div style="padding:12px; background:#1a1a1a; border-radius:6px; margin-bottom:20px; white-space:pre-wrap; word-break:break-word;">{{ $comment }}</div>
    @endif

    @if(!empty($errorMessage))
    <h3 style="color:#f59e0b;">Error message</h3>
    <pre style="padding:12px; background:#1a1a1a; border-radius:6px; margin-bottom:20px; overflow-x:auto; white-space:pre-wrap; word-break:break-word;">{{ $errorMessage }}</pre>
    @endif

    <h3 style="color:#a78bfa;">File</h3>
    <table style="border-collapse:collapse; width:100%; margin-bottom:20px;">
        <tr>
            <td style="padding:4px 12px 4px 0; color:#888;">Server-side original</td>
            <td style="word-break:break-all;">
                @if(!empty($serverOriginalPath))
                    {{ $serverOriginalPath }}
                @else
                    <span style="color:#666;">not persisted (server rejected before write)</span>
                @endif
            </td>
        </tr>
        <tr>
            <td style="padding:4px 12px 4px 0; color:#888;">Uploaded artifact</td>
            <td>
                @if(!empty($uploadedFilename))
                    {{ $uploadedFilename }}
                    @if(!empty($uploadedSize))
                        ({{ number_format($uploadedSize) }} bytes)
                    @endif
                    — attached
                @else
                    <span style="color:#666;">user did not include the file</span>
                @endif
            </td>
        </tr>
    </table>

    @if(!empty($laravelLogs))
    <h3 style="color:#38bdf8;">Laravel log (grep {{ $bookId ?? '' }})</h3>
    <div style="padding:12px; background:#1a1a1a; border-radius:6px; margin-bottom:20px; overflow-x:auto;">
    @foreach($laravelLogs as $line)
    <div style="margin-bottom:2px; color:#9ca3af; white-space:pre-wrap; word-break:break-word;">{{ $line }}</div>
    @endforeach
    </div>
    @endif

    @if(!empty($recentLogs))
    <p style="color:#888; margin-top:20px; font-size:11px;">
        Recent console logs ({{ count($recentLogs) }} entries) attached as recent-logs.txt
    </p>
    @endif
</body>
</html>
