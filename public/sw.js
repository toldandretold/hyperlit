/**
 * Service Worker for Hyperlit
 * Enables offline access to previously visited pages
 */

const CACHE_VERSION = 'v9';
const STATIC_CACHE = `hyperlit-static-${CACHE_VERSION}`;
const DYNAMIC_CACHE = `hyperlit-dynamic-${CACHE_VERSION}`;

// Static assets to precache (core app shell)
const PRECACHE_ASSETS = [
  '/offline.html',
  '/favicon.png',
];

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

// Activate event - clean up old caches
self.addEventListener('activate', (event) => {
  console.log('[SW] Activating Service Worker');
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames
          .filter((name) => name.startsWith('hyperlit-') && name !== STATIC_CACHE && name !== DYNAMIC_CACHE)
          .map((name) => {
            console.log('[SW] Deleting old cache:', name);
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
            console.log('[SW] Serving cached page:', url.pathname);
            return cachedResponse;
          }

          // No exact cache match - check if this is a book page request
          // Book pages match pattern: /bookId or /bookId/HL_xxx
          const bookPagePattern = /^\/[A-Za-z0-9_-]+(\/(HL_[A-Za-z0-9_-]+|[A-Za-z0-9_-]*_Fn[A-Za-z0-9_-]+))?$/;
          const isBookPage = bookPagePattern.test(url.pathname) &&
                             url.pathname !== '/' &&
                             url.pathname !== '/home' &&
                             !url.pathname.startsWith('/u/');

          if (isBookPage) {
            // Try to find ANY cached reader page to use as template
            // All book pages use the same reader.blade.php template
            console.log('[SW] Book page requested offline, looking for cached reader template...');

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
                  console.log('[SW] Serving cached reader template for:', url.pathname, '(from:', cachedUrl.pathname, ')');
                  return templateResponse;
                }
              }
            }
          }

          // No cached version - serve offline page
          console.log('[SW] Serving offline page for:', url.pathname);
          return caches.match('/offline.html');
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
      .catch(() => caches.match(request))
  );
});

// Handle messages from main thread
self.addEventListener('message', (event) => {
  if (event.data === 'skipWaiting') {
    self.skipWaiting();
  }
});
