const CACHE_NAME = 'minis-repo-cache-v6';
const ASSETS_TO_CACHE = [
    './',
    './index.html',
    './assets/css/style.css',
    './assets/js/app.js',
    './manifest.json',
    './apps/repo-icon.png'
];

const OPAQUE_ORIGINS = ['objects.githubusercontent.com', 'raw.githubusercontent.com'];

self.addEventListener('install', event => {
    event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS_TO_CACHE)));
    self.skipWaiting();
});

self.addEventListener('activate', event => {
    event.waitUntil(
        caches.keys().then(keys => Promise.all(
            keys.map(key => key !== CACHE_NAME ? caches.delete(key) : null)
        ))
    );
    self.clients.claim();
});

self.addEventListener('fetch', event => {
    if (event.request.method !== 'GET') return;

    event.respondWith(
        (async () => {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 8000);

            try {
                const networkResponse = await fetch(event.request, { signal: controller.signal });
                
                let canCache = false;
                if (networkResponse.status === 200) {
                    canCache = true;
                } else if (networkResponse.type === 'opaque') {
                    const url = new URL(event.request.url);
                    if (OPAQUE_ORIGINS.includes(url.hostname)) {
                        canCache = true;
                    }
                }

                if (canCache) {
                    const responseToCache = networkResponse.clone();
                    const cache = await caches.open(CACHE_NAME);
                    cache.put(event.request, responseToCache);
                    
                    // Issue 95: Pass Exempt Assets
                    limitCacheSize(CACHE_NAME, 50, ASSETS_TO_CACHE);
                }

                return networkResponse;
            } catch (error) {
                const cached = await caches.match(event.request);
                if (cached) return cached;

                if (event.request.mode === 'navigate') {
                    return new Response(
                        '<!DOCTYPE html><html><body><h1>Offline</h1><button onclick="location.reload()">Retry</button></body></html>',
                        { headers: { 'Content-Type': 'text/html' } }
                    );
                }
                return new Response('Network Error', { status: 408 });
            } finally {
                clearTimeout(timeoutId);
            }
        })()
    );
});

// Issue 94 & 95: Iterative Cache Limiter with Exemption
async function limitCacheSize(name, maxSize, exemptAssets = []) {
    const cache = await caches.open(name);
    let keys = await cache.keys();
    
    // Filter out exempt assets (check if URL ends with any exempt path)
    // Note: Request keys are full URLs, ASSETS_TO_CACHE are relative
    const evictableKeys = keys.filter(req => {
        const url = new URL(req.url).pathname;
        return !exemptAssets.some(asset => url.endsWith(asset.replace('./', '')));
    });

    while (evictableKeys.length > maxSize) {
        const keyToDelete = evictableKeys.shift();
        await cache.delete(keyToDelete);
    }
}