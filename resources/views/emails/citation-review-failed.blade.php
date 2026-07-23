<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Citation Review Didn't Complete</title>
</head>
<body style="margin: 0; padding: 0; background-color: #221F20; font-family: Inter, Arial, Helvetica, sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color: #221F20;">
        <tr>
            <td align="center" style="padding: 40px 20px;">
                <table role="presentation" width="500" cellpadding="0" cellspacing="0" style="max-width: 500px; width: 100%; background-color: #2A2A2A; border-radius: 12px;">
                    <!-- Heading -->
                    <tr>
                        <td style="padding: 40px 40px 16px;">
                            <h1 style="margin: 0; font-family: Inter, Arial, Helvetica, sans-serif; font-size: 24px; font-weight: 600; color: #D73A49;">
                                Citation Review Didn't Complete
                            </h1>
                        </td>
                    </tr>

                    <!-- Body text -->
                    <tr>
                        <td style="padding: 0 40px 20px; color: #CBCCCC; font-size: 15px; line-height: 1.6;">
                            The AI citation review for <strong style="color: #ffffff;">{{ $bookTitle }}</strong> hit a problem and didn't finish. Sorry — this one's on us.
                        </td>
                    </tr>

                    <tr>
                        <td style="padding: 0 40px 20px; color: #CBCCCC; font-size: 15px; line-height: 1.6;">
                            A bug report has been sent to the Hyperlit team automatically, so we're already looking into it. You were <strong style="color: #ffffff;">not charged</strong> for this run — reviews only bill when they succeed.
                        </td>
                    </tr>

                    @if(!empty($reason))
                    <tr>
                        <td style="padding: 0 40px 28px; color: #888888; font-size: 13px; line-height: 1.6;">
                            {{ \Illuminate\Support\Str::limit($reason, 300) }}
                        </td>
                    </tr>
                    @endif

                    <!-- Button -->
                    <tr>
                        <td align="center" style="padding: 0 40px 28px;">
                            <table role="presentation" cellpadding="0" cellspacing="0">
                                <tr>
                                    <td style="border-radius: 8px; background-color: #4EACAE;">
                                        <a href="{{ $bookUrl }}" target="_blank" style="display: inline-block; padding: 14px 36px; font-family: Inter, Arial, Helvetica, sans-serif; font-size: 15px; font-weight: 600; color: #ffffff; text-decoration: none; border-radius: 8px;">
                                            Open Book
                                        </a>
                                    </td>
                                </tr>
                            </table>
                        </td>
                    </tr>

                    <!-- Footer note -->
                    <tr>
                        <td style="padding: 0 40px 40px; color: #888888; font-size: 13px; line-height: 1.6;">
                            Once the issue is fixed you can re-run the review from the book's sources menu — completed steps (like fetched sources) are kept, so a re-run picks up where this one left off.
                        </td>
                    </tr>
                </table>
            </td>
        </tr>
    </table>
</body>
</html>
