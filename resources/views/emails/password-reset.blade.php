<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Reset Your Password</title>
</head>
<body style="margin: 0; padding: 0; background-color: #221F20; font-family: Inter, Arial, Helvetica, sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color: #221F20;">
        <tr>
            <td align="center" style="padding: 40px 20px;">
                <table role="presentation" width="500" cellpadding="0" cellspacing="0" style="max-width: 500px; width: 100%; background-color: #2A2A2A; border-radius: 12px;">
                    <!-- Logo + Heading -->
                    <tr>
                        <td style="padding: 40px 40px 16px;">
                            <table role="presentation" cellpadding="0" cellspacing="0">
                                <tr>
                                    <td style="vertical-align: middle; padding-right: 14px;">
                                        <img src="{{ $logoUrl }}" alt="Hyperlit" width="40" height="40" style="display: block; width: 40px; height: 40px;">
                                    </td>
                                    <td style="vertical-align: middle;">
                                        <h1 style="margin: 0; font-family: Inter, Arial, Helvetica, sans-serif; font-size: 26px; font-weight: 600; color: #EF8D34;">
                                            Reset Your Password
                                        </h1>
                                    </td>
                                </tr>
                            </table>
                        </td>
                    </tr>

                    <!-- Body text -->
                    <tr>
                        <td style="padding: 0 40px 28px; color: #CBCCCC; font-size: 15px; line-height: 1.6; text-align: center;">
                            You requested a password reset for your Hyperlit account. Click the button below to choose a new password.
                        </td>
                    </tr>

                    <!-- Button -->
                    <tr>
                        <td align="center" style="padding: 0 40px 28px;">
                            <table role="presentation" cellpadding="0" cellspacing="0">
                                <tr>
                                    <td style="border-radius: 8px; background-color: #4EACAE;">
                                        <a href="{{ $resetUrl }}" target="_blank" style="display: inline-block; padding: 14px 36px; font-family: Inter, Arial, Helvetica, sans-serif; font-size: 15px; font-weight: 600; color: #ffffff; text-decoration: none; border-radius: 8px;">
                                            Reset Password
                                        </a>
                                    </td>
                                </tr>
                            </table>
                        </td>
                    </tr>

                    <!-- Expiry note -->
                    <tr>
                        <td style="padding: 0 40px 12px; color: #888888; font-size: 13px; line-height: 1.5; text-align: center;">
                            This link will expire in 60 minutes.
                        </td>
                    </tr>

                    <!-- Disclaimer -->
                    <tr>
                        <td style="padding: 0 40px 40px; color: #888888; font-size: 13px; line-height: 1.5; text-align: center;">
                            If you did not request this, you can safely ignore this email &mdash; your password has not been changed.
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
