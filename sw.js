// Mini's IPA Repo — Service Worker
// deploy.js dynamically replaces CACHE_NAME with git hash on build.
const CACHE_NAME = 'minis-repo-cache-88be1dc';

// CRITICAL-1 FIX: Changed absolute paths to relative paths.
// Absolute paths (e.g., '/index.html') resolve to the GitHub Pages origin root
// (oofmini.github.io/), NOT the repo subdirectory (oofmini.github.io/Minis-Repo/).
// Relative paths ('./index.html') resolve from the SW's location at /Minis-Repo/sw.js,
// correctly targeting /Minis-Repo/index.html.
const CRITICAL_ASSETS = [
    './',
    './index.html',
    './assets/css/style.css',
    './assets/js/app.js',
    './mini.json',
    './manifest.json'
];

// --- INSTALL ---
// Pre-cache critical assets for offline support.
self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then((cache) => {
                console.log('[SW] Pre-caching critical assets');
                return cache.addAll(CRITICAL_ASSETS);
            })
            .then(() => self.skipWaiting())
            .catch((err) => {
                console.error('[SW] Install failed:', err);
            })
    );
});

// --- ACTIVATE ---
// Clean up old caches on activation. Uses navigator.locks with a timeout
// to prevent hanging if the lock is held indefinitely.
self.addEventListener('activate', (event) => {
    event.waitUntil(
        cleanOldCaches()
            .then(() => self.clients.claim())
            .catch((err) => {
                console.error('[SW] Activation error:', err);
                // Still claim clients even if cache cleanup fails
                return self.clients.claim();
            })
    );
});

/**
 * AUDIT FIX: Added AbortController with 5s timeout to navigator.locks.request().
 *
 * Without a timeout, if the lock is held indefinitely (e.g., by a stuck tab
 * or crashed service worker instance), cache cleanup blocks forever and the
 * new service worker never fully activates.
 *
 * The AbortController signal causes the lock request to reject with an
 * AbortError after 5 seconds, allowing cleanup to proceed without the lock
 * (which is safe because cache cleanup is idempotent).
 */
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
                // Still try to clean — cache deletion is idempotent
                await deleteOldCaches();
            } else {
                throw err;
            }
        } finally {
            clearTimeout(timeoutId);
        }
    } else {
        // Fallback: clean without lock (older browsers)
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
// Network-first strategy for API/JSON, cache-first for static assets.
self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);

    // Skip non-GET and cross-origin requests
    if (event.request.method !== 'GET') return;
    if (url.origin !== self.location.origin) return;

    // Network-first for dynamic data (mini.json)
    if (url.pathname.endsWith('.json')) {
        event.respondWith(networkFirst(event.request));
        return;
    }

    // Cache-first for static assets
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

        // Return offline-themed JSON error for API requests
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
        // CRITICAL-1 FIX: Use relative path for offline fallback to match
        // the cached entry stored via relative CRITICAL_ASSETS paths.
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