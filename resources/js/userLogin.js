function loginUser(email, password) {
    return fetch('/login', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-CSRF-TOKEN': document.querySelector('meta[name="csrf-token"]').content
        },
        credentials: 'same-origin',
        body: JSON.stringify({ email, password })
    })
    .then(response => {
        if (response.status === 200) {
            // Success - user is logged in
            return { success: true };
        } else {
            // Handle errors (validation, etc.)
            return response.json().then(data => ({ success: false, errors: data }));
        }
    });
}