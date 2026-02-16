// Mini's IPA Repo — Service Worker
// deploy.js dynamically replaces CACHE_NAME with git hash on build.
const CACHE_NAME = 'minis-repo-cache-8bfa450';

const CRITICAL_ASSETS = [
    './',
    './index.html',
    './assets/css/style.css',
    './assets/js/app.js',
    './mini.json',
    './manifest.json',
    './apps/repo-icon.png'
];

// Assets that should use stale-while-revalidate strategy
// (serve cached immediately, update cache in background)
const SWR_PATTERNS = [
    /\/apps\/.*\.(png|jpg|jpeg|webp|gif)$/i
];

// How often to check for SW updates (in milliseconds)
// 30 minutes — balances freshness with API courtesy
const UPDATE_CHECK_INTERVAL = 30 * 60 * 1000;

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
// Clean up old caches and enable navigation preload if supported.
self.addEventListener('activate', (event) => {
    event.waitUntil(
        Promise.all([
            cleanOldCaches(),
            enableNavigationPreload()
        ])
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
    if (!event.data) return;

    if (event.data.action === 'skipWaiting') {
        self.skipWaiting();
    }

    // Allow the app to request a manual update check
    if (event.data.action === 'checkForUpdate') {
        self.registration.update().catch(() => {
            // Silently fail — non-critical
        });
    }
});

// --- NAVIGATION PRELOAD ---
// Speeds up navigation requests by starting the network fetch in parallel
// with the service worker boot-up. Supported in Chromium browsers.
async function enableNavigationPreload() {
    if (self.registration.navigationPreload) {
        try {
            await self.registration.navigationPreload.enable();
            console.log('[SW] Navigation preload enabled');
        } catch (err) {
            console.warn('[SW] Navigation preload not available:', err.message);
        }
    }
}

// --- CACHE CLEANUP ---
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

// --- PERIODIC UPDATE CHECK ---
// Runs a self.registration.update() check on a timer so long-lived
// PWA instances (e.g., pinned to home screen) eventually discover new
// service worker versions without requiring the user to close/reopen.
let updateCheckTimer = null;

function startPeriodicUpdateCheck() {
    if (updateCheckTimer) return;
    updateCheckTimer = setInterval(() => {
        self.registration.update().catch(() => {
            // Silently fail — network may be unavailable
        });
    }, UPDATE_CHECK_INTERVAL);
}

// Start the timer once any client is active
self.addEventListener('activate', () => {
    startPeriodicUpdateCheck();
});

// --- FETCH ---
// Strategy selection:
//   - Navigation:  Network-first (with preload response if available)
//   - JSON:        Network-first (always fresh data)
//   - App icons:   Stale-while-revalidate (fast load, background refresh)
//   - Other:       Cache-first (static assets)
self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);

    if (event.request.method !== 'GET') return;

    // Only handle same-origin requests
    if (url.origin !== self.location.origin) return;

    // Navigation requests — use preloaded response if available
    if (event.request.mode === 'navigate') {
        event.respondWith(handleNavigation(event));
        return;
    }

    // JSON data — always network-first for freshness
    if (url.pathname.endsWith('.json')) {
        event.respondWith(networkFirst(event.request));
        return;
    }

    // App icons and images — stale-while-revalidate
    if (SWR_PATTERNS.some(pattern => pattern.test(url.pathname))) {
        event.respondWith(staleWhileRevalidate(event.request));
        return;
    }

    // Everything else (CSS, JS, HTML) — cache-first
    event.respondWith(cacheFirst(event.request));
});

// --- NAVIGATION HANDLER ---
// Uses navigation preload response if available, falls back to network-first.
async function handleNavigation(event) {
    try {
        // Try navigation preload response first (faster in Chromium)
        const preloadResponse = event.preloadResponse ? await event.preloadResponse : null;
        if (preloadResponse) {
            // Cache the preloaded response for offline use
            const cache = await caches.open(CACHE_NAME);
            cache.put(event.request, preloadResponse.clone());
            return preloadResponse;
        }

        // Fall back to standard network-first
        return await networkFirst(event.request);
    } catch (err) {
        // Offline fallback
        const cached = await caches.match('./index.html');
        if (cached) return cached;

        return new Response(
            '<!DOCTYPE html><html><head><meta charset="utf-8"><title>Offline</title></head>' +
            '<body style="background:#000;color:#fff;font-family:system-ui;display:flex;' +
            'align-items:center;justify-content:center;min-height:100vh;margin:0;text-align:center">' +
            '<div><h1>📴 Offline</h1><p>You appear to be offline. Please check your connection.</p></div>' +
            '</body></html>',
            {
                status: 503,
                headers: { 'Content-Type': 'text/html' }
            }
        );
    }
}

// --- NETWORK-FIRST ---
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

// --- STALE-WHILE-REVALIDATE ---
// Returns cached response immediately (if available) while fetching a fresh
// copy in the background. Perfect for app icons that change infrequently
// but should eventually update without a full cache bust.
async function staleWhileRevalidate(request) {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(request);

    // Fire-and-forget background revalidation
    const fetchPromise = fetch(request)
        .then((response) => {
            if (response.ok) {
                cache.put(request, response.clone());
            }
            return response;
        })
        .catch(() => null);

    // Return cached immediately if available, otherwise wait for network
    if (cached) {
        return cached;
    }

    const networkResponse = await fetchPromise;
    if (networkResponse) return networkResponse;

    // Both cache and network failed
    return new Response('', { status: 404 });
}

// --- CACHE-FIRST ---
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
