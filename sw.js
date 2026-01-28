/**
 * Mini's IPA Repo - Intelligent Service Worker (v3.5.7)
 * Fixes: Cache invalidation for Hybrid Model transition.
 */

const CACHE_NAMES = {
    SHELL: 'mini-repo-shell-v3.5.7', // BUMPED
    DATA: 'mini-repo-data-v3', // BUMPED
    IMAGES: 'mini-repo-images-v1'
};

const SHELL_ASSETS = [
    './index.html',
    './offline.html',
    './assets/css/style.css',
    './assets/js/app.js',
    './manifest.json'
];

self.addEventListener('install', event => {
    event.waitUntil(caches.open(CACHE_NAMES.SHELL).then(cache => cache.addAll(SHELL_ASSETS)));
    self.skipWaiting();
});

self.addEventListener('activate', event => {
    event.waitUntil(
        caches.keys().then(keys =>
            Promise.all(
                keys.map(key => {
                    const currentCaches = Object.values(CACHE_NAMES);
                    if (!currentCaches.includes(key)) return caches.delete(key);
                })
            )
        )
    );
    self.clients.claim();
});

self.addEventListener('fetch', event => {
    const url = new URL(event.request.url);

    // 1. Data: Stale-While-Revalidate with Integrity Check
    if (url.pathname.endsWith('.json')) {
        event.respondWith(handleDataRequest(event.request));
        return;
    }

    // 2. Images: Cache First + LRU
    if (url.pathname.includes('/apps/') && /\.(png|jpg|jpeg)$/i.test(url.pathname)) {
        event.respondWith(cacheFirstLRU(event.request, CACHE_NAMES.IMAGES));
        return;
    }

    // 3. Shell: SWR
    if (SHELL_ASSETS.some(asset => url.pathname.endsWith(asset.replace('./', '')))) {
        event.respondWith(staleWhileRevalidate(event.request, CACHE_NAMES.SHELL));
        return;
    }

    // 4. Fallback
    event.respondWith(
        fetch(event.request).catch(() => {
            if (event.request.headers.get('accept').includes('text/html')) {
                return caches.match('./offline.html');
            }
        })
    );
});

// P0: Integrity Hashing Logic
async function computeIntegrity(response) {
    const clone = response.clone();
    const buffer = await clone.arrayBuffer();
    const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

async function handleDataRequest(request) {
    const cache = await caches.open(CACHE_NAMES.DATA);
    const cachedResp = await cache.match(request);

    // Always fetch network to check for updates (revalidating)
    const networkPromise = fetch(request)
        .then(async networkResp => {
            if (networkResp.ok) {
                try {
                    // If we have a cache, compare hashes
                    if (cachedResp) {
                        const [netHash, cachedHash] = await Promise.all([
                            computeIntegrity(networkResp),
                            computeIntegrity(cachedResp)
                        ]);

                        // Only update cache if content actually changed
                        if (netHash !== cachedHash) {
                            cache.put(request, networkResp.clone());
                        }
                    } else {
                        // No cache, just save
                        cache.put(request, networkResp.clone());
                    }
                } catch (e) {
                    console.warn('[SW] Integrity check failed:', e);
                }
            }
            return networkResp;
        })
        .catch(err => {
            console.warn('[SW] Network fail:', err);
        });

    return cachedResp || networkPromise;
}

async function cacheFirstLRU(request, cacheName) {
    const cache = await caches.open(cacheName);
    const match = await cache.match(request);
    if (match) return match;

    try {
        const resp = await fetch(request);
        if (resp.ok) {
            cache.put(request, resp.clone());
            limitCacheSize(cacheName, 50);
        }
        return resp;
    } catch {
        return new Response('', { status: 404 });
    }
}

async function staleWhileRevalidate(request, cacheName) {
    const cache = await caches.open(cacheName);
    const match = await cache.match(request);
    const fetchPromise = fetch(request).then(res => {
        if (res.ok) cache.put(request, res.clone());
        return res;
    });
    return match || fetchPromise;
}

async function limitCacheSize(name, size) {
    const cache = await caches.open(name);
    let keys = await cache.keys();

    if (keys.length <= size) return;
    const yieldToMain = () => new Promise(resolve => setTimeout(resolve, 0));

    let deletedCount = 0;
    while (keys.length > size) {
        await cache.delete(keys[0]);
        keys.shift();
        deletedCount++;
        if (deletedCount % 5 === 0) {
            await yieldToMain();
        }
    }
}
