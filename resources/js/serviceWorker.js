const CACHE_NAME = "my-app-cache-v1";
const ASSETS_TO_CACHE = [
  "/",
  "/app.css",
  "/highlight-div.css",
  "/app.js",
  "/readerDOMContentLoaded.js",
  "/initializePage.js",
  "/lazyLoaderFactory.js",
  "/toc.js",
  "/nav-buttons.js",
  "/lazyLoadingDiv.js",
  "/hyper-lights-cites.js",
  "/footnotesCitations.js",
  "/convertMarkdown.js",
  "/containerManager.js",
  "/indexedDB.js",
  "/reader.css",
  // Add other assets you need to cache for offline use
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      console.log("Opened cache");
      return cache.addAll(ASSETS_TO_CACHE);
    })
  );
});

self.addEventListener("fetch", (event) => {
  event.respondWith(
    caches.match(event.request).then((response) => {
      // Cache hit - return the cached response
      if (response) {
        return response;
      }
      return fetch(event.request)
        .then((networkResponse) => {
          // Optionally cache the new response for future use
          return caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, networkResponse.clone());
            return networkResponse;
          });
        })
        .catch(() => {
          // Fallback page if requested asset is not cached and network fails
          return caches.match("/offline.html");
        });
    })
  );
});
