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
        host: process.env.VITE_HOST || '0.0.0.0',
        port: process.env.VITE_PORT || 5173,
        strictPort: true,
        hmr: {
            host: getNetworkIp(), // Dynamically set the correct IP
            protocol: 'ws',
        },
    },
});




