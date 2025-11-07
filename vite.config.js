import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';
import laravel from 'laravel-vite-plugin';
import { viteStaticCopy } from 'vite-plugin-static-copy';
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
  server: {
    host: process.env.VITE_HOST || '0.0.0.0',
    port: process.env.VITE_PORT || 5173,
    strictPort: true,
    cors: true,
    hmr: {
      // Support both network IP and local .test domains for subdomains
      host: process.env.VITE_HMR_HOST || getNetworkIp(),
      protocol: 'ws',
    },
    proxy: {
      '/resources/markdown': {
        target: process.env.VITE_APP_URL || 'http://localhost:8000',
        changeOrigin: true,
        secure: false,
        rewrite: (path) => path,
      },
      // ✅ ADD THIS for API calls
      '/api': {
        target: process.env.VITE_APP_URL || 'http://localhost:8000',
        changeOrigin: true,
        secure: false,
      },
      '/markdown': {
        target: process.env.VITE_APP_URL || 'http://localhost:8000',
        changeOrigin: true,
        secure: false,
      },
    },
  },
  plugins: [
    VitePWA({
      registerType: 'autoUpdate',
      manifest: {
        name: 'My App',
        short_name: 'App',
        start_url: '/',
        display: 'standalone',
        background_color: '#ffffff',
        icons: [
          {
            src: 'pwa-192x192.png',
            sizes: '192x192',
            type: 'image/png',
          },
          {
            src: 'pwa-512x512.png',
            sizes: '512x512',
            type: 'image/png',
          },
        ],
      },
    }),
    laravel({
      input: [
        // CSS & SASS (no changes)
                'resources/css/app.css',
                'resources/css/reader.css',
                'resources/css/highlight-div.css',
                'resources/css/div-editor.css',
                'resources/css/containers.css',
                'resources/css/buttons.css',
                'resources/css/form.css',
                'resources/css/alert.css',
                'resources/css/layout.css',
                'resources/sass/app.scss',

                // JAVASCRIPT (sorted, with new files added)
                'resources/js/app.js',
                'resources/js/indexedDB.js',
                'resources/js/chunkManager.js',
                'resources/js/containerCustomization.js',
                'resources/js/convertMarkdown.js',
                'resources/js/drag.js',
                'resources/js/editToolbar.js',
                'resources/js/footnotesCitations.js',
                'resources/js/homepage.js',                 // ✅ NEW
                'resources/js/hyperlights/index.js',
                'resources/js/initializePage.js',
                'resources/js/lazyLoadingDiv.js',
                'resources/js/lazyLoaderFactory.js',
                'resources/js/newBookButton.js',
                'resources/js/newBookForm.js',
                'resources/js/postgreSQL.js',
                'resources/js/readerDOMContentLoaded.js',
                'resources/js/renderOpenBooks.js',
                'resources/js/scrolling.js',
                'resources/js/toc.js',      // ✅ NEW
                'resources/js/viewManager.js',
                'resources/js/homepageDisplayUnit.js',

                // divEditor modules
                'resources/js/divEditor/saveQueue.js',
                'resources/js/divEditor/mutationProcessor.js',
                'resources/js/divEditor/enterKeyHandler.js',
                'resources/js/divEditor/chunkMutationHandler.js',
                'resources/js/divEditor/domUtilities.js',

                // editToolbar modules
                'resources/js/editToolbar/toolbarDOMUtils.js',
                'resources/js/editToolbar/selectionManager.js',
                'resources/js/editToolbar/buttonStateManager.js',
                'resources/js/editToolbar/historyHandler.js',
                'resources/js/editToolbar/headingSubmenu.js',
                'resources/js/editToolbar/textFormatter.js',
                'resources/js/editToolbar/listConverter.js',
                'resources/js/editToolbar/blockFormatter.js',
        // You can include the service worker here if you wish,
        // but it will be processed by Vite and not end up at the root.
      ],
      refresh: true,
    }),
    viteStaticCopy({
      targets: [
        {
          src: 'resources/js/serviceWorker.js',
          dest: '', // Copies directly to the output dir (public)
        },
      ],
    }),
  ],
});
