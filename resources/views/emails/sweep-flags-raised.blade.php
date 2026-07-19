<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>Conversion sweep — new flags</title>
</head>
<body style="margin:0; padding:20px; background:#221F20; color:#ddd; font-family:monospace; font-size:13px;">
    <h2 style="color:#ef8d34;">Garbage sweep raised {{ count($flagged) }} new flag(s)</h2>

    <p style="margin:0 0 16px;">
        <a href="{{ $maintainerUrl }}" style="color:#4eacae; font-weight:bold;">Open the maintainer triage page →</a>
    </p>

    <table style="border-collapse:collapse; width:100%;">
        <tr>
            <th style="text-align:left; padding:6px 12px 6px 0; color:#888; border-bottom:1px solid #444;">Book</th>
            <th style="text-align:left; padding:6px 12px 6px 0; color:#888; border-bottom:1px solid #444;">Signals</th>
        </tr>
        @foreach($flagged as $row)
        <tr>
            <td style="padding:6px 12px 6px 0; border-bottom:1px solid #333;">
                <a href="{{ $maintainerUrl }}?book={{ urlencode($row['book']) }}" style="color:#4eacae;">
                    {{ \Illuminate\Support\Str::limit($row['title'] ?: $row['book'], 60) }}
                </a>
                <div style="color:#666;">{{ $row['book'] }}</div>
            </td>
            <td style="padding:6px 12px 6px 0; border-bottom:1px solid #333; color:#ef8d34;">
                {{ implode(', ', $row['signals']) }}
            </td>
        </tr>
        @endforeach
    </table>

    <p style="color:#666; margin-top:18px;">
        library:flag-sweep · resolve via the page or
        <span style="color:#999;">php artisan library:reconvert-queue</span>
    </p>
</body>
</html>
