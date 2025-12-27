/**
 * Service Worker for Hyperlit
 * Enables offline access to previously visited pages
 */

const CACHE_VERSION = 'v12';
const STATIC_CACHE = `hyperlit-static-${CACHE_VERSION}`;
const DYNAMIC_CACHE = `hyperlit-dynamic-${CACHE_VERSION}`;

// Static assets to precache (core app shell)
const PRECACHE_ASSETS = [
  '/offline.html',
  '/favicon.png',
];

/**
 * Check if cached HTML has its required build assets available
 * Returns true if assets are cached, false if any are missing
 */
async function validateCachedHtml(html) {
  // Extract /build/assets/*.js and *.css references from HTML
  const buildAssetPattern = /\/build\/assets\/[^"'\s]+\.(js|css)/g;
  const matches = html.match(buildAssetPattern) || [];

  if (matches.length === 0) {
    // No build assets found - might be a simple page, allow it
    return true;
  }

  // Check if at least the first few critical assets are cached
  // (checking all could be slow)
  const criticalAssets = matches.slice(0, 5);

  for (const assetPath of criticalAssets) {
    const cached = await caches.match(assetPath);
    if (!cached) {
      console.log('[SW] Missing cached asset:', assetPath);
      return false;
    }
  }

  return true;
}

// Install event - precache core assets
self.addEventListener('install', (event) => {
  console.log('[SW] Installing Service Worker');
  event.waitUntil(
    caches.open(STATIC_CACHE)
      .then((cache) => {
        console.log('[SW] Precaching core assets');
        return cache.addAll(PRECACHE_ASSETS);
      })
      .then(() => self.skipWaiting())
  );
});

// Activate event - clean up old caches and clear dynamic cache to force fresh HTML
self.addEventListener('activate', (event) => {
  console.log('[SW] Activating Service Worker');
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames
          .filter((name) => {
            // Delete old versioned caches
            if (name.startsWith('hyperlit-') && name !== STATIC_CACHE && name !== DYNAMIC_CACHE) {
              return true;
            }
            // Also delete current dynamic cache to force fresh HTML fetch
            // This prevents stale HTML that references old JS hashes
            if (name === DYNAMIC_CACHE) {
              console.log('[SW] Clearing dynamic cache to ensure fresh HTML');
              return true;
            }
            return false;
          })
          .map((name) => {
            console.log('[SW] Deleting cache:', name);
            return caches.delete(name);
          })
      );
    }).then(() => self.clients.claim())
  );
});

// Fetch event - serve from cache or network
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Skip non-GET requests
  if (request.method !== 'GET') {
    return;
  }

  // Skip API requests - always go to network
  if (url.pathname.startsWith('/api/')) {
    return;
  }

  // Skip WebSocket and HMR requests (development)
  if (url.pathname.includes('hot') || url.protocol === 'ws:' || url.protocol === 'wss:') {
    return;
  }

  // Handle build assets (hashed files) - CacheFirst with network fallback
  if (url.pathname.startsWith('/build/')) {
    event.respondWith(
      caches.match(request).then((cachedResponse) => {
        if (cachedResponse) {
          console.log('[SW] Serving cached build asset:', url.pathname);
          return cachedResponse;
        }
        return fetch(request).then((networkResponse) => {
          // Cache the new asset
          if (networkResponse.ok) {
            console.log('[SW] Caching build asset:', url.pathname);
            const responseClone = networkResponse.clone();
            caches.open(STATIC_CACHE).then((cache) => {
              cache.put(request, responseClone);
            });
          }
          return networkResponse;
        }).catch((error) => {
          console.error('[SW] Failed to fetch build asset:', url.pathname, error);
          return new Response('', { status: 404 });
        });
      })
    );
    return;
  }

  // Handle static assets (fonts, images, css, js) - CacheFirst
  if (url.pathname.match(/\.(js|css|woff2?|ttf|eot|svg|png|jpg|jpeg|gif|ico)$/)) {
    event.respondWith(
      caches.match(request).then((cachedResponse) => {
        if (cachedResponse) {
          return cachedResponse;
        }
        return fetch(request).then((networkResponse) => {
          if (networkResponse.ok) {
            const responseClone = networkResponse.clone();
            caches.open(STATIC_CACHE).then((cache) => {
              cache.put(request, responseClone);
            });
          }
          return networkResponse;
        }).catch(() => {
          // Return nothing for failed static assets
          return new Response('', { status: 404 });
        });
      })
    );
    return;
  }

  // Handle HTML pages - NetworkFirst with fallback to cache
  if (request.headers.get('accept')?.includes('text/html')) {
    event.respondWith(
      fetch(request)
        .then((networkResponse) => {
          // Cache successful HTML responses
          if (networkResponse.ok) {
            const responseClone = networkResponse.clone();
            caches.open(DYNAMIC_CACHE).then((cache) => {
              cache.put(request, responseClone);
            });
          }
          return networkResponse;
        })
        .catch(async () => {
          // Network failed - try cache
          const cachedResponse = await caches.match(request);
          if (cachedResponse) {
            // Validate that required build assets are cached before serving
            const html = await cachedResponse.clone().text();
            const isValid = await validateCachedHtml(html);
            if (isValid) {
              console.log('[SW] Serving cached page:', url.pathname);
              return cachedResponse;
            }
            console.log('[SW] Cached page has missing assets, skipping:', url.pathname);
          }

          // No exact cache match - check if this is a book page request
          // Book pages match pattern: /bookId or /bookId/HL_xxx
          const bookPagePattern = /^\/[A-Za-z0-9_-]+(\/(HL_[A-Za-z0-9_-]+|[A-Za-z0-9_-]*_Fn[A-Za-z0-9_-]+))?$/;
          const isBookPage = bookPagePattern.test(url.pathname) &&
                             url.pathname !== '/' &&
                             url.pathname !== '/home' &&
                             !url.pathname.startsWith('/u/');

          if (isBookPage) {
            // Try to find ANY cached reader page to use as app shell
            // All book pages use the same reader.blade.php template
            // We patch the <main id="..."> to have the correct book ID from the URL
            console.log('[SW] Book page requested offline, looking for cached reader shell...');

            const cache = await caches.open(DYNAMIC_CACHE);
            const keys = await cache.keys();

            for (const cachedRequest of keys) {
              const cachedUrl = new URL(cachedRequest.url);
              // Find a cached book page (not home, not user page, not API)
              if (bookPagePattern.test(cachedUrl.pathname) &&
                  cachedUrl.pathname !== '/' &&
                  cachedUrl.pathname !== '/home' &&
                  !cachedUrl.pathname.startsWith('/u/') &&
                  !cachedUrl.pathname.startsWith('/api/')) {
                const templateResponse = await cache.match(cachedRequest);
                if (templateResponse) {
                  // Get the requested book ID from the URL
                  const requestedBookId = url.pathname.split('/').filter(Boolean)[0];

                  // Patch the HTML to use the correct book ID
                  const html = await templateResponse.text();

                  // Validate that required build assets are cached
                  const isValid = await validateCachedHtml(html);
                  if (!isValid) {
                    console.log('[SW] Cached reader shell has missing assets, skipping');
                    continue; // Try next cached page
                  }

                  console.log('[SW] Patching cached reader for:', requestedBookId, '(shell from:', cachedUrl.pathname, ')');
                  const patchedHtml = html.replace(
                    /<main\s+id="[^"]*"\s+class="main-content"/,
                    `<main id="${requestedBookId}" class="main-content"`
                  );

                  return new Response(patchedHtml, {
                    status: 200,
                    headers: {
                      'Content-Type': 'text/html; charset=utf-8',
                      'X-SW-Offline': 'patched-shell'
                    }
                  });
                }
              }
            }
          }

          // No cached version - serve offline page
          console.log('[SW] Serving offline page for:', url.pathname);
          const offlinePage = await caches.match('/offline.html');
          return offlinePage || new Response(
            '<!DOCTYPE html><html><head><title>Offline</title></head><body style="font-family:system-ui;text-align:center;padding:50px;"><h1>You\'re Offline</h1><p>No cached content available. Please reconnect to the internet.</p></body></html>',
            { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
          );
        })
    );
    return;
  }

  // Default: NetworkFirst for everything else
  event.respondWith(
    fetch(request)
      .then((networkResponse) => {
        if (networkResponse.ok) {
          const responseClone = networkResponse.clone();
          caches.open(DYNAMIC_CACHE).then((cache) => {
            cache.put(request, responseClone);
          });
        }
        return networkResponse;
      })
      .catch(async () => {
        const cached = await caches.match(request);
        return cached || new Response('', { status: 503, statusText: 'Service Unavailable' });
      })
  );
});

// Handle messages from main thread
self.addEventListener('message', (event) => {
  if (event.data === 'skipWaiting') {
    self.skipWaiting();
  }
});
