const CACHE_NAME = 'minis-repo-cache-v2'; // ⚡ BUMPED VERSION
const ASSETS_TO_CACHE = [
    './',
    './index.html',
    './offline.html',
    './assets/css/style.css',
    './assets/js/app.js',
    './manifest.json',
    './apps/repo-icon.png'
];

// Install: Cache Core Assets
self.addEventListener('install', event => {
    event.waitUntil(
        caches.open(CACHE_NAME).then(cache => {
            console.log('[Service Worker] Caching core assets');
            return cache.addAll(ASSETS_TO_CACHE);
        })
    );
    self.skipWaiting();
});

// Activate: Cleanup Old Caches
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

// Fetch: Network First -> Cache -> Offline Fallback
self.addEventListener('fetch', event => {
    if (event.request.method !== 'GET') return;

    event.respondWith(
        (async () => {
            try {
                const networkResponse = await fetch(event.request);

                // ⚡ FIX: Allow valid responses (200) AND Opaque responses (0 - redirects/CORS)
                // GitHub Pages often returns opaque responses for certain assets.
                if (networkResponse && (networkResponse.status === 200 || networkResponse.type === 'opaque')) {
                    const responseToCache = networkResponse.clone();
                    const cache = await caches.open(CACHE_NAME);
                    cache.put(event.request, responseToCache);
                }

                return networkResponse;
            } catch (error) {
                console.log('[Service Worker] Network failed, serving cache:', event.request.url);
                const cachedResponse = await caches.match(event.request);

                if (cachedResponse) return cachedResponse;

                // ⚡ FIX: Robust Offline Page Fallback
                if (event.request.mode === 'navigate') {
                    const offlinePage = await caches.match('./offline.html');
                    return (
                        offlinePage ||
                        new Response('<h1>Offline</h1><p>No internet connection.</p>', {
                            headers: { 'Content-Type': 'text/html' }
                        })
                    );
                }

                return new Response('Network Error', { status: 408 });
            }
        })()
    );
});
