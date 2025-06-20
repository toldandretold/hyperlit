// auth.js
export async function getCurrentUser() {
  console.log("Checking authentication...");
  
  try {
    const response = await fetch('/auth-check', {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'X-Requested-With': 'XMLHttpRequest',
      },
      credentials: 'include', // Changed from 'same-origin' to match your userContainer
    });

    console.log("Auth check response status:", response.status);

    if (response.ok) {
      const data = await response.json();
      console.log("Auth check response data:", data);
      
      // Match the same logic as your userContainer
      const user = data.authenticated ? data.user : null;
      console.log("Extracted user:", user);
      return user;
    } else if (response.status === 401) {
      console.log("User not authenticated");
      return null;
    } else {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
  } catch (error) {
    console.error('Error checking authentication:', error);
    return null;
  }
}

export async function isLoggedIn() {
  const user = await getCurrentUser();
  return user !== null;
}