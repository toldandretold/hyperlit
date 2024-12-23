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
                'resources/js/div-editor.js',   // Editable div template logic
                'resources/js/reader.js',       // Reader template logic
                'resources/sass/app.scss'       // Global styles
            ],
            refresh: true,
        }),
    ],
    build: {
        sourcemap: true,  // Enable source maps for easier debugging
        minify: false,    // Disable minification for debugging purposes
    },
});
