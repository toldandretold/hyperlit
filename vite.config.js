import { defineConfig } from 'vite';
import laravel from 'laravel-vite-plugin';
import os from 'os';

function getNetworkIp() {
    const interfaces = os.networkInterfaces();
    for (const interfaceKey in interfaces) {
        for (const iface of interfaces[interfaceKey]) {
            if (iface.family === 'IPv4' && !iface.internal) {
                return iface.address;
            }
        }
    }
    return 'localhost';
}

export default defineConfig({
    plugins: [
        laravel({
              input: [
                'resources/css/app.css',     // Global styles
                'resources/css/reader.css', // Reader-specific styles
                'resources/css/highlight-div.css',
                'resources/css/div-editor.css', 
                'resources/js/app.js',         // Global JavaScript variables
                'resources/js/cache-indexedDB.js',        //Browswer storage of nodeChunks.json and main-text-footnotes.json
                'resources/js/convert-markdown.js',       // Markdwon conversion/rendering
                'resources/js/hyper-lights-cites.js',       // highlights and citations 
                'resources/js/scrolling.js',              // scrolling, positioning after scroll etc.
                'resources/js/toc.js',                    // Table Of Contents (TOC) (from main-text-footnotes.json)
                'resources/js/footnotes.js',              // Footnotes (from main-text-footnotes.json)
                'resources/js/lazy-loading-div.js', // div-editor lazy-loading logic
                'resources/js/reader-DOMContentLoaded.js',       // Reader template logic
                'resources/sass/app.scss'       // Global styles
            ],
            refresh: true,
        }),
    ],
    server: {
        host: process.env.VITE_HOST || '0.0.0.0',
        port: process.env.VITE_PORT || 5173,
        strictPort: true,
        hmr: {
            host: getNetworkIp(), // Dynamically set the correct IP
            protocol: 'ws',
        },
        // Add proxy configuration here
        proxy: {
            '/resources/markdown': {
                target: process.env.VITE_APP_URL || 'http://localhost:8000',
                changeOrigin: true,
                secure: false,
                rewrite: (path) => path
            }
        }
    },
});




