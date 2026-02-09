const CACHE_NAME = 'minis-repo-cache-a3b2968';
const ASSETS_TO_CACHE = [
    './',
    './index.html',
    './assets/css/style.css',
    './assets/js/app.js',
    './manifest.json',
    './apps/repo-icon.png'
];

const SAFE_ASSET_PATTERNS = [
    /githubusercontent\.com\/.*\.png$/,
    /githubusercontent\.com\/.*\.jpg$/,
    /githubusercontent\.com\/.*\.jpeg$/
];

const OPAQUE_ORIGINS = ['objects.githubusercontent.com', 'raw.githubusercontent.com'];

let lastCleanup = 0;

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
                        // CRITICAL-2: Fix Service Worker Cache Poisoning
                        // Remove broken content-type check for opaque responses
                        // Only cache if URL pattern matches AND request is for image context
                        const isImageContext = event.request.destination === 'image';
                        const matchesPattern = SAFE_ASSET_PATTERNS.some(regex => regex.test(url.href));
                        
                        if (isImageContext && matchesPattern) {
                            canCache = true;
                        }
                    }
                }

                if (canCache) {
                    const responseToCache = networkResponse.clone();
                    const cache = await caches.open(CACHE_NAME);
                    cache.put(event.request, responseToCache);
                    
                    // LOW-2: Reduce throttle to 30 seconds
                    const now = Date.now();
                    if (now - lastCleanup > 30000) {
                        limitCacheSize(CACHE_NAME, 50, ASSETS_TO_CACHE);
                        lastCleanup = now;
                    }
                }

                return networkResponse;
            } catch (error) {
                const cached = await caches.match(event.request);
                if (cached) return cached;

                if (event.request.mode === 'navigate') {
                    return new Response(
                        `<!DOCTYPE html>
                        <html>
                        <body>
                            <h1>Offline</h1>
                            <button id="retryBtn">Retry</button>
                            <script>
                                document.getElementById('retryBtn').addEventListener('click', () => location.reload());
                            </script>
                        </body>
                        </html>`,
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

async function limitCacheSize(name, maxSize, exemptAssets = []) {
    if ('locks' in navigator) {
        await navigator.locks.request('cache-cleanup', async (lock) => {
            await executeCacheCleanup(name, maxSize, exemptAssets);
        });
    } else {
        await executeCacheCleanup(name, maxSize, exemptAssets);
    }
}

async function executeCacheCleanup(name, maxSize, exemptAssets) {
    const cache = await caches.open(name);
    let keys = await cache.keys();
    
    const evictableKeys = keys.filter(req => {
        const url = new URL(req.url).pathname;
        return !exemptAssets.some(asset => url.endsWith(asset.replace('./', '')));
    });

    while (evictableKeys.length > maxSize) {
        const keyToDelete = evictableKeys.shift();
        await cache.delete(keyToDelete);
    }
}