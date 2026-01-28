const CACHE_NAME = 'minis-repo-cache-v1';
const ASSETS_TO_CACHE = [
    './',
    './index.html',
    './offline.html',
    './assets/css/style.css',
    './assets/js/app.js',
    './manifest.json',
    './apps/repo-icon.png'
];

// Install Event: Cache Core Assets
self.addEventListener('install', event => {
    event.waitUntil(
        caches.open(CACHE_NAME).then(cache => {
            console.log('[Service Worker] Caching core assets');
            return cache.addAll(ASSETS_TO_CACHE);
        })
    );
    self.skipWaiting();
});

// Activate Event: Clean Old Caches
self.addEventListener('activate', event => {
    event.waitUntil(
        caches.keys().then(cacheNames => {
            return Promise.all(
                cacheNames.map(cache => {
                    if (cache !== CACHE_NAME) {
                        console.log('[Service Worker] Clearing old cache:', cache);
                        return caches.delete(cache);
                    }
                })
            );
        })
    );
    self.clients.claim();
});

// Fetch Event: Network First, Fallback to Cache
self.addEventListener('fetch', event => {
    // Only cache GET requests
    if (event.request.method !== 'GET') return;

    event.respondWith(
        (async () => {
            try {
                // 1. Try Network
                const networkResponse = await fetch(event.request);

                // CRITICAL FIX: Verify response validity before caching
                // We only cache status 200. We DO NOT cache 206 (Partial), 304 (Not Modified), or 4xx/5xx errors.
                if (networkResponse && networkResponse.status === 200 && networkResponse.type === 'basic') {
                    const responseToCache = networkResponse.clone();
                    const cache = await caches.open(CACHE_NAME);
                    cache.put(event.request, responseToCache);
                }

                return networkResponse;
            } catch (error) {
                // 2. Fallback to Cache
                console.log('[Service Worker] Network failed, serving cache for:', event.request.url);
                const cachedResponse = await caches.match(event.request);

                if (cachedResponse) return cachedResponse;

                // 3. Fallback to Offline Page (for navigation requests)
                if (event.request.mode === 'navigate') {
                    const offlinePage = await caches.match('./offline.html');
                    if (offlinePage) return offlinePage;
                }

                // Return null if nothing found (browser handles error)
                return null;
            }
        })()
    );
});
