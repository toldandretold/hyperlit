import Echo from 'laravel-echo';
import Pusher from 'pusher-js';

window.Pusher = Pusher;

window.Echo = new Echo({
    broadcaster: 'reverb',
    key: import.meta.env.VITE_REVERB_APP_KEY,              // Reverb app key
    wsHost: import.meta.env.VITE_REVERB_HOST || '127.0.0.1', // Default to localhost if env variable is missing
    wsPort: parseInt(import.meta.env.VITE_REVERB_PORT) || 6001, // Default port is 6001
    forceTLS: false,                                         // HTTP, no encryption
    encrypted: false,                                        // Ensure encryption is disabled for local testing
    disableStats: true,                                      // Disable connection stats
    enabledTransports: ['ws'],                               // Use only WebSocket
});

console.log("Echo initialized:", window.Echo);
