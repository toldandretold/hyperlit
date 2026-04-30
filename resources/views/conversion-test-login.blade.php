<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta name="csrf-token" content="{{ csrf_token() }}">
    <title>Login — Conversion Test Dashboard</title>
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body {
            background: #221F20; color: #CBCCCC;
            font-family: "Courier New", Courier, monospace;
            font-size: 13px;
            display: flex; align-items: center; justify-content: center;
            min-height: 100vh;
        }
        .login-box {
            background: rgba(75, 75, 75, 0.3);
            backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px);
            border-radius: 0.5em;
            padding: 32px; width: 340px;
        }
        h1 { color: #4EACAE; font-size: 18px; margin-bottom: 4px; }
        .subtitle { color: rgba(203,204,204,0.5); font-size: 11px; margin-bottom: 24px; }
        label { display: block; color: rgba(203,204,204,0.7); font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 4px; }
        input[type="email"], input[type="password"] {
            width: 100%; padding: 8px 10px; margin-bottom: 16px;
            background: rgba(34,31,32,0.8); border: 1px solid rgba(203,204,204,0.2);
            border-radius: 0.3em; color: #CBCCCC;
            font-family: inherit; font-size: 13px; outline: none;
        }
        input:focus { border-color: #4EACAE; }
        .btn {
            width: 100%; padding: 10px;
            background: #4EACAE; color: #221F20; border: none;
            border-radius: 0.5em; cursor: pointer;
            font-family: inherit; font-size: 13px; font-weight: bold;
        }
        .btn:hover { background: #3d8a8c; }
        .btn:disabled { opacity: 0.5; cursor: wait; }
        .error { color: #ef4444; font-size: 12px; margin-bottom: 12px; display: none; }
    </style>
</head>
<body>
    <div class="login-box">
        <h1>Conversion Tests</h1>
        <div class="subtitle">Admin login required</div>

        <div class="error" id="error"></div>

        <form id="loginForm" onsubmit="return handleLogin(event)">
            <label for="email">Email</label>
            <input type="email" id="email" name="email" required autofocus>

            <label for="password">Password</label>
            <input type="password" id="password" name="password" required>

            <button type="submit" class="btn" id="submitBtn">Log in</button>
        </form>
    </div>

    <script>
        async function handleLogin(e) {
            e.preventDefault();
            const btn = document.getElementById('submitBtn');
            const errorEl = document.getElementById('error');
            errorEl.style.display = 'none';
            btn.disabled = true;

            try {
                const resp = await fetch('/api/login', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'X-CSRF-TOKEN': document.querySelector('meta[name="csrf-token"]').content,
                    },
                    credentials: 'include',
                    body: JSON.stringify({
                        email: document.getElementById('email').value,
                        password: document.getElementById('password').value,
                    }),
                });

                const data = await resp.json();

                if (!resp.ok) {
                    errorEl.textContent = data.message || 'Login failed.';
                    errorEl.style.display = 'block';
                    btn.disabled = false;
                    return;
                }

                // Login succeeded — reload the page (session cookie is now set)
                window.location.reload();
            } catch (err) {
                errorEl.textContent = 'Network error: ' + err.message;
                errorEl.style.display = 'block';
                btn.disabled = false;
            }
        }
    </script>
</body>
</html>
