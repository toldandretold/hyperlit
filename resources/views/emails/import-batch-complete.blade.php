<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Imports Complete</title>
</head>
<body style="margin: 0; padding: 0; background-color: #221F20; font-family: Inter, Arial, Helvetica, sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color: #221F20;">
        <tr>
            <td align="center" style="padding: 40px 20px;">
                <table role="presentation" width="500" cellpadding="0" cellspacing="0" style="max-width: 500px; width: 100%; background-color: #2A2A2A; border-radius: 12px;">
                    <!-- Heading -->
                    <tr>
                        <td style="padding: 40px 40px 16px;">
                            <h1 style="margin: 0; font-family: Inter, Arial, Helvetica, sans-serif; font-size: 24px; font-weight: 600; color: #EF8D34;">
                                Imports Complete
                            </h1>
                        </td>
                    </tr>

                    <!-- Body text -->
                    <tr>
                        <td style="padding: 0 40px 20px; color: #CBCCCC; font-size: 15px; line-height: 1.6;">
                            <strong style="color: #ffffff;">{{ $completed }} of {{ $total }}</strong> documents from <strong style="color: #ffffff;">{{ $label }}</strong> have been imported.
                        </td>
                    </tr>

                    <!-- Per-item list -->
                    <tr>
                        <td style="padding: 0 40px 28px; color: #CBCCCC; font-size: 14px; line-height: 1.8;">
                            @foreach($items as $item)
                                @if(($item['status'] ?? '') === 'complete')
                                    <span style="color: #4EACAE;">&#10003;</span>
                                    <a href="{{ $appUrl }}/{{ $item['book'] }}" target="_blank" style="color: #CBCCCC; text-decoration: underline;">{{ $item['title'] ?? $item['filename'] ?? $item['book'] }}</a><br>
                                @else
                                    <span style="color: #CC8888;">&#10007;</span>
                                    <span style="color: #888888;">{{ $item['title'] ?? $item['filename'] ?? $item['book'] }} — did not finish</span><br>
                                @endif
                            @endforeach
                        </td>
                    </tr>

                    <!-- Button -->
                    @if($shelfUrl)
                    <tr>
                        <td align="center" style="padding: 0 40px 28px;">
                            <table role="presentation" cellpadding="0" cellspacing="0">
                                <tr>
                                    <td style="border-radius: 8px; background-color: #4EACAE;">
                                        <a href="{{ $shelfUrl }}" target="_blank" style="display: inline-block; padding: 14px 36px; font-family: Inter, Arial, Helvetica, sans-serif; font-size: 15px; font-weight: 600; color: #ffffff; text-decoration: none; border-radius: 8px;">
                                            View Shelf
                                        </a>
                                    </td>
                                </tr>
                            </table>
                        </td>
                    </tr>
                    @endif

                    <!-- Footer note -->
                    <tr>
                        <td style="padding: 0 40px 40px; color: #888888; font-size: 13px; line-height: 1.5; text-align: center;">
                            You received this email because you asked to be notified when your Hyperlit imports finished.
                        </td>
                    </tr>
                </table>

                <!-- Footer -->
                <table role="presentation" width="500" cellpadding="0" cellspacing="0" style="max-width: 500px; width: 100%;">
                    <tr>
                        <td align="center" style="padding: 24px 40px 0; color: #555555; font-family: Inter, Arial, Helvetica, sans-serif; font-size: 12px;">
                            Hyperlit
                        </td>
                    </tr>
                </table>
            </td>
        </tr>
    </table>
</body>
</html>
