// Mini's IPA Repo — Service Worker
// deploy.js dynamically replaces CACHE_NAME with git hash on build.
const CACHE_NAME = 'minis-repo-cache-2f918c4';

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
const SWR_PATTERNS = [
    /\/apps\/.*\.(png|jpg|jpeg|webp|gif|PNG)$/i
];

// Maximum number of entries allowed in the cache.
const MAX_CACHE_ITEMS = 150;

// --- INSTALL ---
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
// NOTE: Periodic update checks are intentionally NOT done with setInterval in
// the SW. setInterval in a Service Worker is unreliable because the browser
// can terminate the SW between ticks, silently dropping the interval — this
// is especially common on mobile. The app.js handles SW update polling via
// registration.update() on a timer in the page context instead.
self.addEventListener('message', (event) => {
    if (!event.data) return;

    if (event.data.action === 'skipWaiting') {
        self.skipWaiting();
    }

    // Allow the app to request a manual update check
    if (event.data.action === 'checkForUpdate') {
        self.registration.update().catch(() => {});
    }
});

// --- NAVIGATION PRELOAD ---
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
    // FIX: In a SW context, `navigator.locks` is the correct feature check.
    // `typeof navigator !== 'undefined'` is always true in SW scope.
    if ('locks' in navigator) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 5000);

        try {
            await navigator.locks.request(
                'sw-cache-cleanup',
                { signal: controller.signal },
                async () => { await deleteOldCaches(); }
            );
        } catch (err) {
            if (err.name === 'AbortError') {
                console.warn('[SW] Lock acquisition timed out. Falling back to direct cleanup.');
            } else {
                console.warn('[SW] Lock request failed, falling back:', err.message);
            }
            await deleteOldCaches();
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

// --- CACHE SIZE MANAGEMENT ---
async function trimCache() {
    try {
        const cache = await caches.open(CACHE_NAME);
        const keys = await cache.keys();

        if (keys.length <= MAX_CACHE_ITEMS) return;

        const excess = keys.length - MAX_CACHE_ITEMS;
        let evicted = 0;

        const criticalUrls = new Set(
            CRITICAL_ASSETS.map(asset => new URL(asset, self.location.origin).href)
        );

        for (const request of keys) {
            if (evicted >= excess) break;
            if (criticalUrls.has(request.url)) continue;
            await cache.delete(request);
            evicted++;
        }

        if (evicted > 0) {
            console.log(`[SW] Cache trimmed: evicted ${evicted} entries`);
        }
    } catch (err) {
        console.warn('[SW] Cache trim failed:', err.message);
    }
}

async function cachePutAndTrim(request, response) {
    try {
        const cache = await caches.open(CACHE_NAME);
        await cache.put(request, response);
        trimCache().catch(() => {});
    } catch (err) {
        console.warn('[SW] Cache put failed:', err.message);
    }
}

// --- FETCH ---
self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);

    if (event.request.method !== 'GET') return;

    // Only handle same-origin requests
    if (url.origin !== self.location.origin) return;

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

    // CSS, JS, HTML — cache-first
    event.respondWith(cacheFirst(event.request));
});

// --- NAVIGATION HANDLER ---
async function handleNavigation(event) {
    try {
        // FIX: Clone the preload response BEFORE awaiting it. The preload
        // response can only be consumed once; cloning before consumption lets
        // us cache it AND return it to the browser in the same tick.
        let preloadResponse = null;
        if (event.preloadResponse) {
            const preload = await event.preloadResponse;
            if (preload) {
                preloadResponse = preload.clone();
                cachePutAndTrim(event.request, preload).catch(() => {});
            }
        }

        if (preloadResponse) return preloadResponse;

        return await networkFirst(event.request);
    } catch (err) {
        const cached = await caches.match('./index.html');
        if (cached) return cached;
        return buildOfflinePage();
    }
}

// --- NETWORK-FIRST ---
async function networkFirst(request) {
    try {
        const response = await fetch(request);
        if (response.ok) {
            cachePutAndTrim(request, response.clone()).catch(() => {});
        }
        return response;
    } catch (err) {
        const cached = await caches.match(request);
        if (cached) return cached;

        if (request.url.endsWith('.json')) {
            return new Response(
                JSON.stringify({ error: 'offline', message: 'You appear to be offline.' }),
                { status: 503, headers: { 'Content-Type': 'application/json' } }
            );
        }

        return new Response('Offline', { status: 503, headers: { 'Content-Type': 'text/plain' } });
    }
}

// --- STALE-WHILE-REVALIDATE ---
async function staleWhileRevalidate(request) {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(request);

    const fetchPromise = fetch(request)
        .then((response) => {
            if (response.ok) {
                cachePutAndTrim(request, response.clone()).catch(() => {});
            }
            return response;
        })
        .catch(() => null);

    if (cached) return cached;

    const networkResponse = await fetchPromise;
    if (networkResponse) return networkResponse;

    // FIX: Return a transparent 1×1 PNG for failed image requests to prevent
    // broken-image icons in the UI when both cache and network fail.
    if (/\.(png|jpg|jpeg|webp|gif)$/i.test(request.url)) {
        const transparentPng = new Uint8Array([
            0x89,0x50,0x4E,0x47,0x0D,0x0A,0x1A,0x0A,0x00,0x00,0x00,0x0D,
            0x49,0x48,0x44,0x52,0x00,0x00,0x00,0x01,0x00,0x00,0x00,0x01,
            0x08,0x06,0x00,0x00,0x00,0x1F,0x15,0xC4,0x89,0x00,0x00,0x00,
            0x0A,0x49,0x44,0x41,0x54,0x78,0x9C,0x62,0x00,0x00,0x00,0x02,
            0x00,0x01,0xE5,0x27,0xDE,0xFC,0x00,0x00,0x00,0x00,0x49,0x45,
            0x4E,0x44,0xAE,0x42,0x60,0x82
        ]);
        return new Response(transparentPng.buffer, {
            status: 200,
            headers: { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' }
        });
    }

    return new Response('', { status: 404 });
}

// --- CACHE-FIRST ---
async function cacheFirst(request) {
    const cached = await caches.match(request);
    if (cached) return cached;

    try {
        const response = await fetch(request);
        if (response.ok) {
            cachePutAndTrim(request, response.clone()).catch(() => {});
        }
        return response;
    } catch (err) {
        if (request.mode === 'navigate') {
            const fallback = await caches.match('./index.html');
            if (fallback) return fallback;
            return buildOfflinePage();
        }

        return new Response('Offline', { status: 503, headers: { 'Content-Type': 'text/plain' } });
    }
}

// --- OFFLINE PAGE ---
function buildOfflinePage() {
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark">
<title>Offline — Mini's Repo</title>
<style>
  *,*::before,*::after{margin:0;padding:0;box-sizing:border-box}
  html{color-scheme:dark}
  body{
    background:#000;color:#f5f5f7;
    font-family:-apple-system,BlinkMacSystemFont,'SF Pro Display','Helvetica Neue',system-ui,sans-serif;
    display:flex;align-items:center;justify-content:center;
    min-height:100vh;min-height:100dvh;text-align:center;padding:24px;
    -webkit-font-smoothing:antialiased;
  }
  .card{
    background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.08);
    border-radius:20px;padding:40px 32px;max-width:360px;width:100%;
  }
  .icon{font-size:3em;margin-bottom:16px;line-height:1}
  h1{font-size:1.4em;font-weight:700;margin-bottom:8px;letter-spacing:-0.3px}
  p{color:#8e8e93;font-size:0.9em;line-height:1.5;margin-bottom:24px}
  .url{
    font-family:'SF Mono',Menlo,Monaco,Consolas,monospace;font-size:0.72em;
    color:#a78bfa;background:rgba(167,139,250,0.08);border:1px solid rgba(167,139,250,0.15);
    padding:8px 12px;border-radius:8px;word-break:break-all;margin-bottom:24px;display:block;
  }
  button{
    background:linear-gradient(135deg,#30d158,#2ac94e);color:#fff;border:none;
    border-radius:12px;padding:12px 28px;font-size:0.9em;font-weight:700;
    font-family:inherit;cursor:pointer;width:100%;
  }
</style>
</head>
<body>
<div class="card">
  <div class="icon">📴</div>
  <h1>You're offline</h1>
  <p>Mini's Repo needs a connection to load. Or add the source URL directly to your app manager:</p>
  <code class="url">https://OofMini.github.io/Minis-Repo/mini.json</code>
  <button onclick="window.location.reload()">Try again</button>
</div>
</body>
</html>`;

    return new Response(html, {
        status: 503,
        headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }
    });
}
