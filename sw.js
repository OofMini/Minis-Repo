// Mini's IPA Repo — Service Worker
// deploy.js dynamically replaces CACHE_NAME with git hash on build.
const CACHE_NAME = 'minis-repo-cache-2953a3e';

const CRITICAL_ASSETS = [
    './',
    './index.html',
    './assets/css/style.css',
    './assets/js/app.js',
    './mini.json',
    './manifest.json',
    './apps/repo-icon.png'
];

// --- INSTALL ---
// Pre-cache critical assets for offline support.
// skipWaiting is NOT called here — the app controls activation
// via postMessage so users see an update prompt first.
self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then((cache) => {
                console.log('[SW] Pre-caching critical assets');
                return cache.addAll(CRITICAL_ASSETS);
            })
            .catch((err) => {
                console.error('[SW] Install failed:', err);
            })
    );
});

// --- ACTIVATE ---
// Clean up old caches on activation.
self.addEventListener('activate', (event) => {
    event.waitUntil(
        cleanOldCaches()
            .then(() => self.clients.claim())
            .catch((err) => {
                console.error('[SW] Activation error:', err);
                return self.clients.claim();
            })
    );
});

// --- MESSAGE ---
// Allows the app to trigger skipWaiting after the user confirms the update.
self.addEventListener('message', (event) => {
    if (event.data && event.data.action === 'skipWaiting') {
        self.skipWaiting();
    }
});

async function cleanOldCaches() {
    if (typeof navigator !== 'undefined' && navigator.locks) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 5000);

        try {
            await navigator.locks.request(
                'sw-cache-cleanup',
                { signal: controller.signal },
                async () => {
                    await deleteOldCaches();
                }
            );
        } catch (err) {
            if (err.name === 'AbortError') {
                console.warn('[SW] Lock acquisition timed out after 5s. Proceeding without lock.');
                await deleteOldCaches();
            } else {
                throw err;
            }
        } finally {
            clearTimeout(timeoutId);
        }
    } else {
        await deleteOldCaches();
    }
}

async function deleteOldCaches() {
    const keys = await caches.keys();
    const deletions = keys
        .filter((key) => key !== CACHE_NAME && key.startsWith('minis-repo-cache'))
        .map((key) => {
            console.log('[SW] Deleting old cache:', key);
            return caches.delete(key);
        });
    await Promise.all(deletions);
    console.log(`[SW] Cache cleanup complete. Active: ${CACHE_NAME}`);
}

// --- FETCH ---
// Network-first for JSON, cache-first for static assets.
self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);

    if (event.request.method !== 'GET') return;
    if (url.origin !== self.location.origin) return;

    if (url.pathname.endsWith('.json')) {
        event.respondWith(networkFirst(event.request));
        return;
    }

    event.respondWith(cacheFirst(event.request));
});

async function networkFirst(request) {
    try {
        const response = await fetch(request);
        if (response.ok) {
            const cache = await caches.open(CACHE_NAME);
            cache.put(request, response.clone());
        }
        return response;
    } catch (err) {
        const cached = await caches.match(request);
        if (cached) return cached;

        return new Response(
            JSON.stringify({ error: 'offline', message: 'You appear to be offline.' }),
            {
                status: 503,
                headers: { 'Content-Type': 'application/json' }
            }
        );
    }
}

async function cacheFirst(request) {
    const cached = await caches.match(request);
    if (cached) return cached;

    try {
        const response = await fetch(request);
        if (response.ok) {
            const cache = await caches.open(CACHE_NAME);
            cache.put(request, response.clone());
        }
        return response;
    } catch (err) {
        if (request.mode === 'navigate') {
            const fallback = await caches.match('./index.html');
            if (fallback) return fallback;
        }

        return new Response('Offline', {
            status: 503,
            headers: { 'Content-Type': 'text/plain' }
        });
    }
}
