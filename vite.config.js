import { defineConfig } from 'vite';
import laravel from 'laravel-vite-plugin';
import os from 'os';
import fs from 'node:fs';

// Bundle-regression gate plumbing: when BUNDLE_GATE=1, emit a chunk→modules map next to the manifest
// so scripts/check-lazy-chunks.mjs can assert the edit/feature folders stay OUT of the eager bundle.
// Off by default (normal `npm run build` is unaffected — no extra artifact).
const bundleGatePlugin = process.env.BUNDLE_GATE
  ? {
      name: 'bundle-gate-chunkmap',
      generateBundle(_opts, bundle) {
        const map = {};
        for (const [file, c] of Object.entries(bundle)) {
          if (c.type !== 'chunk') continue;
          map[file] = {
            imports: c.imports || [],
            modules: Object.keys(c.modules || {}).map((m) => m.replace(process.cwd() + '/', '')),
          };
        }
        fs.mkdirSync('public/build', { recursive: true });
        fs.writeFileSync('public/build/chunkmap.json', JSON.stringify(map));
      },
    }
  : null;

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
      plugins: bundleGatePlugin ? [bundleGatePlugin] : [],
      output: {
        manualChunks: (id) => {
          // Trust rollup's automatic code-splitting. The source now has clean dynamic-import
          // boundaries (edit-only divEditor/editToolbar/paste are reached only via `await import()`
          // from edit entry; no EAGER module statically imports them), so rollup auto-creates lazy
          // chunks for them and places shared infra (serverSync/pageLoad/IDfunctions) at the eager
          // common-dominator. Hand-written `manualChunks` groupings were FOLDING that shared infra
          // into the lazy feature chunks and pinning them eager — so we only keep the vendor split.
          if (id.includes('node_modules')) {
            if (id.includes('rangy')) return 'vendor-rangy';
          }
          // Consolidate the indexedDB data layer (already ~all eager — core/library/batch/write/push/
          // sync are on the content-load + sync path) into ONE eager chunk to cut the long tail of
          // tiny per-module requests. SAFE: eager-with-eager grouping doesn't fold lazy features (we
          // do NOT group the lazy feature folders divEditor/paste/editToolbar/hyperlights/hypercites).
          // Verified by measurement: eager bytes flat, chunk count down, no duplication.
          if (id.includes('/resources/js/indexedDB/')) return 'indexeddb';
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
                // CSS — ONE entry per page (each blade @vite()s app.css + its pages/*.css).
                // Feature files under base/ and components/ are reached via @import from
                // these entries; a file must NEVER be both an entry here and an @import
                // target, or it gets built twice and double-applied (cssStructure.test.js
                // gate 3 enforces this).
                // Theme files are @imported by app.css (switching is body-class based), so
                // they are not entries either.
                'resources/css/app.css',
                'resources/css/pages/reader.css',
                'resources/css/pages/home.css',
                'resources/css/pages/user.css',
                'resources/css/pages/auth.css',
                'resources/css/pages/user-home.css',

                // JAVASCRIPT — ONLY the real page entries blade @vite()s. Everything else
                // (divEditor/*, editToolbar/*, hyperlights/index, scrolling, pageLoad/index,
                // viewManager, tocContainer, homepage*, citeForm, …) used to be listed here as
                // legacy entries, which forced each into its own entry chunk and made rollup IGNORE
                // manualChunks for them — defeating lazy-splitting. They're reached via imports now,
                // so rollup chunks + code-splits them properly. Keep this list = the blade entries.
                'resources/js/app.ts',                                       // layouts/{app,guest}.blade
                'resources/js/components/utilities/containerCustomization.ts',// reader.blade
                'resources/js/pageLoad/readerEntry.ts',                      // reader/home/user.blade

                // Quantizer view
                'resources/css/pages/quantizer.css',
                'resources/js/quantizer/index.js',
        // You can include the service worker here if you wish,
        // but it will be processed by Vite and not end up at the root.
      ],
      refresh: true,
    }),
  ],
});
