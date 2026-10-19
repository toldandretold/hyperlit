<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
</head>
{{-- Sepia palette transplanted as LITERAL hex from theme/sepia-theme.css
     (body.theme-sepia): email clients load no site CSS and know no CSS
     variables, so the theme cannot "apply" — it is copied. If the sepia theme
     changes, re-copy: bg #E8D7B8, text #3A2F1F, links #1F6365 (aqua),
     headings #C25E10 (orange). The outer wrapper carries the bg because many
     clients strip body styling. --}}
<body style="margin: 0; padding: 0; background-color: #E8D7B8;">
    <div style="background-color: #E8D7B8; font-family: Inter, Arial, sans-serif; color: #3A2F1F; line-height: 1.6; max-width: 560px; margin: 0 auto; padding: 24px;">
        <h2 style="margin: 0 0 16px; color: #C25E10;">We've published Hyperlit's Terms of Service</h2>
        <p>Hi {{ $username }},</p>
        <p>Thanks for signing up. Hyperlit is open source software that has always given users full data sovereignty. We treat your data as your own.</p>
        <p>This is now being formalised. As such, we have an official <a href="https://hyperlit.io/terms" style="color: #1F6365;">Terms of Service</a> and <a href="https://hyperlit.io/privacy" style="color: #1F6365;">Privacy Policy</a>. They take effect for your account on <strong>{{ $effectiveDate }}</strong> — 30 days from this notice. However, nothing really changes, as we have always followed the spirit of the principles outlined in these documents.</p>
        <p>The short version:</p>
        <ul style="padding-left: 20px; margin: 0 0 16px;">
            <li>Your data is your data. We do not use it for anything that you don't yourself choose. We do not use it to train LLMs.</li>
            <li>You can export everything and delete your account at any time, from the profile menu.</li>
            <li>Every claim in the privacy policy links to the open-source code that implements it — you can check our work.</li>
        </ul>
        <p>You're receiving this because you have a Hyperlit account. Questions: <a href="mailto:sam@hyperlit.io" style="color: #1F6365;">sam@hyperlit.io</a></p>
        <p>— Sam, Hyperlit</p>
        <h1 style="color: #C25E10; font-size: 20px; margin: 24px 0 4px;">PS.</h1>
        <p style="margin-top: 0;">If hyperlit ever glitches on you, or the service sucks in any way, please let me know via: <a href="mailto:fml@hyperlit.io" style="color: #1F6365;">fml@hyperlit.io</a></p>
    </div>
</body>
</html>
