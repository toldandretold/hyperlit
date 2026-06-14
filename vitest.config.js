import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Use happy-dom environment for DOM testing (faster and more ESM-compatible than jsdom)
    environment: 'happy-dom',

    // Test file patterns
    include: [
      'tests/javascript/**/*.test.js',
      'tests/paste/**/*.test.js'
    ],

    // Global test utilities
    globals: true,

    // Coverage configuration
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: [
        'resources/js/editToolbar/**/*.{js,ts}',
        'resources/js/divEditor/**/*.{js,ts}',
        'resources/js/paste/**/*.{js,ts}',
        'resources/js/indexedDB/**/*.{js,ts}'
      ],
      exclude: [
        '**/*.test.js',
        '**/node_modules/**'
      ]
    },

    // Setup files (global mocks and utilities)
    setupFiles: ['./tests/javascript/setup/test-setup.js'],
  },

  // Resolve aliases to match your Vite config
  resolve: {
    alias: {
      '@': '/resources/js',
    },
  },
});
