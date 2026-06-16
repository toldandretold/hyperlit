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
  build: {
    rollupOptions: {
      output: {
        manualChunks: (id) => {
          // ✅ Code-splitting optimization for edit-only modules

          // Paste system (lazy loaded only when editing)
          if (id.includes('/resources/js/paste/')) {
            return 'paste-system';
          }

          // divEditor (lazy loaded only when editing)
          if (id.includes('/resources/js/divEditor/')) {
            return 'editor';
          }

          // editToolbar (lazy loaded only when editing)
          if (id.includes('/resources/js/editToolbar/')) {
            return 'editor';
          }

          // Highlighting system (core feature - keep separate)
          if (id.includes('/resources/js/hyperlights/') ||
              id.includes('/resources/js/hypercites/')) {
            return 'highlights';
          }

          // Large vendor libraries
          if (id.includes('node_modules')) {
            if (id.includes('rangy')) {
              return 'vendor-rangy';
            }
          }
        }
      }
    }
  },
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

                // Theme system
                'resources/css/theme/variables.css',
                'resources/css/theme/light-theme.css',
                'resources/css/theme/sepia-theme.css',
                'resources/css/theme/custom-theme-template.css',

                // JAVASCRIPT (sorted, with new files added)
                'resources/js/app.js',
                'resources/js/divEditor/chunkManager.ts',
                'resources/js/components/utilities/containerCustomization.ts',
                'resources/js/utilities/convertMarkdown.js',
                // drag.js is imported via components/registerComponents.js (ButtonRegistry-managed),
                // no longer a standalone entry — see reader.blade.php note.
                'resources/js/editToolbar/index.ts',
                'resources/js/hyperlitContainer/footnotesCitations.ts',
                'resources/js/components/homepage/homepage.ts',                 // ✅ NEW
                'resources/js/hyperlights/index.ts',
                'resources/js/pageLoad/index.ts',
                'resources/js/lazyLoader/index.ts',
                'resources/js/components/newbookContainer/citeForm/index.ts',
                'resources/js/pageLoad/readerEntry.ts',
                'resources/js/scrolling/index.ts',
                'resources/js/components/tocContainer/index.ts',      // ✅ NEW
                'resources/js/SPA/viewManager.ts',
                'resources/js/components/homepage/homepageDisplayUnit.ts',

                // divEditor modules
                'resources/js/divEditor/index.ts',
                'resources/js/divEditor/saveQueue.ts',
                'resources/js/divEditor/mutationProcessor.ts',
                'resources/js/divEditor/enterKeyHandler/index.ts',
                'resources/js/divEditor/chunkMutationHandler/index.ts',
                'resources/js/divEditor/domUtilities.ts',

                // editToolbar modules
                'resources/js/editToolbar/toolbarDOMUtils.ts',
                'resources/js/editToolbar/selectionManager.ts',
                'resources/js/editToolbar/buttonStateManager.ts',
                'resources/js/editToolbar/headingSubmenu.ts',
                'resources/js/editToolbar/textFormatter.ts',
                'resources/js/editToolbar/listConverter.ts',
                'resources/js/editToolbar/blockFormatter.ts',

                // Quantizer view
                'resources/css/quantizer.css',
                'resources/js/quantizer/index.js',
        // You can include the service worker here if you wish,
        // but it will be processed by Vite and not end up at the root.
      ],
      refresh: true,
    }),
  ],
});
