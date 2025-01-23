import { defineConfig } from 'vite';
import laravel from 'laravel-vite-plugin';

export default defineConfig({
    plugins: [
        laravel({
            input: [
                'resources/css/app.css',     // Global styles
                'resources/css/reader.css', // Reader-specific styles
                'resources/css/div-editor.css', 
                'resources/js/app.js',         // Global JavaScript
                'resources/js/lazy-loading.js', // Shared lazy-loading logic
                'resources/js/lazy-loading-div.js', // div-editor lazy-loading logic
                'resources/js/div-editor.js',   // Editable div template logic
                'resources/js/reader.js',       // Reader template logic
                'resources/sass/app.scss'       // Global styles
            ],
            refresh: true,
        }),
    ],
    server: {
        host: '0.0.0.0', // Allow connections from the network
        port: 5173,      // Default port for Vite (can be customized)
        hmr: {
            host: '10.0.0.93', // Replace with your computer's local IP address
            port: 5173,
        },
    },
    build: {
        sourcemap: true,  // Enable source maps for easier debugging
        minify: false,    // Disable minification for debugging purposes
    },
});
