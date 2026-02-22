// Mini's IPA Repo — Service Worker
// deploy.js dynamically replaces CACHE_NAME with git hash on build.
const CACHE_NAME = 'minis-repo-cache-ec12bc8';

// IMAGE_CACHE persists across deploys (different name, not replaced by deploy.js).
// App icons and screenshots change rarely, so keeping them across code deploys
// avoids re-downloading megabytes of image data on every update.
const IMAGE_CACHE = 'minis-images-v1';

// DATA_CACHE is for mini.json and GitHub API stale-while-revalidate.
// Kept separate so it can be versioned independently of the app shell.
const DATA_CACHE = 'minis-data-v1';

// GH_CACHE TTL: 30 minutes in seconds (used in Cache-Control header comparison)
const GH_CACHE_TTL_MS = 30 * 60 * 1000;

const CRITICAL_ASSETS = [
    './',
    './index.html',
    './assets/css/style.css',
    './assets/js/app.js',
    './assets/js/github-downloads.js',
    './mini.json',
    './manifest.json',
    './apps/repo-icon.png'
];

// Patterns for app icons and screenshots — served from image cache.
const IMAGE_PATTERNS = [
    /\/apps\/.*\.(png|jpg|jpeg|webp|gif|PNG|JPG|JPEG|WEBP)$/i,
    /objects\.githubusercontent\.com\//i,
    /raw\.githubusercontent\.com\/.*\.(png|jpg|jpeg|webp|PNG|JPG|JPEG)$/i
];

// Maximum entries in each cache bucket.
const MAX_SHELL_ITEMS = 100;
const MAX_IMAGE_ITEMS = 80;
const MAX_GH_ITEMS = 20;

// --- INSTALL ---
self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then((cache) => {
                console.log('[SW] Pre-caching critical assets');
                return Promise.allSettled(
                    CRITICAL_ASSETS.map(url =>
                        cache.add(url).catch(err => {
                            console.warn(`[SW] Failed to pre-cache ${url}:`, err.message);
                        })
                    )
                );
            })
            .catch((err) => {
                console.error('[SW] Install failed:', err);
            })
    );
    self.skipWaiting();
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
self.addEventListener('message', (event) => {
    if (!event.data) return;

    if (event.data.action === 'skipWaiting') {
        self.skipWaiting();
    }

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
    const managedCaches = new Set([CACHE_NAME, IMAGE_CACHE, DATA_CACHE]);

    if ('locks' in navigator) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 5000);
        try {
            await navigator.locks.request(
                'sw-cache-cleanup',
                { signal: controller.signal },
                async () => { await deleteOldCaches(managedCaches); }
            );
        } catch (err) {
            if (err.name === 'AbortError') {
                console.warn('[SW] Lock timed out, falling back to direct cleanup.');
            } else {
                console.warn('[SW] Lock failed, falling back:', err.message);
            }
            await deleteOldCaches(managedCaches);
        } finally {
            clearTimeout(timeoutId);
        }
    } else {
        await deleteOldCaches(managedCaches);
    }
}

async function deleteOldCaches(managedCaches) {
    const keys = await caches.keys();
    const deletions = keys
        .filter(key => !managedCaches.has(key) && key.startsWith('minis-'))
        .map(key => {
            console.log('[SW] Deleting old cache:', key);
            return caches.delete(key);
        });
    await Promise.all(deletions);
    console.log(`[SW] Cache cleanup complete. Active: ${CACHE_NAME}, ${IMAGE_CACHE}, ${DATA_CACHE}`);
}

// --- CACHE SIZE MANAGEMENT ---
async function trimCache(cacheName, maxItems, skipUrls = new Set()) {
    try {
        const cache = await caches.open(cacheName);
        const keys = await cache.keys();
        if (keys.length <= maxItems) return;

        const excess = keys.length - maxItems;
        let evicted = 0;

        for (const request of keys) {
            if (evicted >= excess) break;
            if (skipUrls.has(request.url)) continue;
            await cache.delete(request);
            evicted++;
        }

        if (evicted > 0) {
            console.log(`[SW] ${cacheName}: evicted ${evicted} entries`);
        }
    } catch (err) {
        console.warn(`[SW] Cache trim failed (${cacheName}):`, err.message);
    }
}

async function cachePut(cacheName, request, response, maxItems) {
    try {
        const cache = await caches.open(cacheName);
        await cache.put(request, response);
        if (maxItems) {
            trimCache(cacheName, maxItems).catch(() => {});
        }
    } catch (err) {
        console.warn('[SW] Cache put failed:', err.message);
    }
}

// --- FETCH ---
self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);

    if (event.request.method !== 'GET') return;

    // Navigation requests — serve shell with preload support
    if (event.request.mode === 'navigate') {
        event.respondWith(handleNavigation(event));
        return;
    }

    // GitHub API releases endpoint — stale-while-revalidate with TTL guard.
    // This provides a second caching layer independent of the JS-side
    // sessionStorage cache, which helps in private browsing and new tabs.
    if (url.hostname === 'api.github.com' && url.pathname.includes('/releases')) {
        event.respondWith(staleWhileRevalidateGitHub(event.request));
        return;
    }

    // mini.json — stale-while-revalidate for instant loads.
    if (url.pathname.endsWith('mini.json')) {
        event.respondWith(staleWhileRevalidateData(event.request));
        return;
    }

    // Other JSON / manifest files — network-first for freshness
    if (url.pathname.endsWith('.json')) {
        event.respondWith(networkFirst(event.request, CACHE_NAME));
        return;
    }

    // App icons and remote images — dedicated image cache (persists across deploys)
    if (IMAGE_PATTERNS.some(p => p.test(url.href))) {
        event.respondWith(staleWhileRevalidateImage(event.request));
        return;
    }

    // CSS, JS, HTML and other same-origin assets — cache-first
    if (url.origin === self.location.origin) {
        event.respondWith(cacheFirst(event.request));
        return;
    }
});

// --- NAVIGATION HANDLER ---
async function handleNavigation(event) {
    try {
        let preloadResponse = null;
        if (event.preloadResponse) {
            const preload = await event.preloadResponse;
            if (preload) {
                preloadResponse = preload.clone();
                cachePut(CACHE_NAME, event.request, preload, MAX_SHELL_ITEMS).catch(() => {});
            }
        }

        if (preloadResponse) return preloadResponse;

        return await networkFirst(event.request, CACHE_NAME);
    } catch (err) {
        const cached = await caches.match('./index.html');
        if (cached) return cached;
        return buildOfflinePage();
    }
}

// --- NETWORK-FIRST ---
async function networkFirst(request, cacheName) {
    try {
        const response = await fetch(request);
        if (response.ok) {
            cachePut(cacheName, request, response.clone(), MAX_SHELL_ITEMS).catch(() => {});
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

// --- STALE-WHILE-REVALIDATE (mini.json) ---
async function staleWhileRevalidateData(request) {
    const cache = await caches.open(DATA_CACHE);
    const cached = await cache.match(request);

    const fetchPromise = fetch(request, { cache: 'no-cache' })
        .then(response => {
            if (response.ok) {
                cache.put(request, response.clone()).catch(() => {});
            }
            return response;
        })
        .catch(() => null);

    if (cached) {
        fetchPromise.catch(() => {});
        return cached;
    }

    const networkResponse = await fetchPromise;
    if (networkResponse) return networkResponse;

    return new Response(
        JSON.stringify({ error: 'offline', apps: [] }),
        { status: 503, headers: { 'Content-Type': 'application/json' } }
    );
}

// --- STALE-WHILE-REVALIDATE (GitHub API) ---
// Caches GitHub /releases responses for GH_CACHE_TTL_MS (30 min).
// Serves stale data immediately if available, refreshes in background.
// On cache miss (first visit, new tab, private browsing) waits for network.
// Returns a 503 JSON stub on total failure so the JS side handles it gracefully.
async function staleWhileRevalidateGitHub(request) {
    const cache = await caches.open(DATA_CACHE);
    const cached = await cache.match(request);

    // Check if cached response is still within TTL by reading a stored timestamp
    // we embed in a custom header when writing to cache.
    let cachedFresh = false;
    if (cached) {
        const ts = cached.headers.get('x-sw-cached-at');
        if (ts && (Date.now() - parseInt(ts, 10)) < GH_CACHE_TTL_MS) {
            cachedFresh = true;
        }
    }

    const fetchAndCache = async () => {
        try {
            const response = await fetch(request, {
                headers: { Accept: 'application/vnd.github+json' }
            });
            if (response.ok) {
                // Clone and inject our timestamp header before caching
                const body = await response.clone().arrayBuffer();
                const headers = new Headers(response.headers);
                headers.set('x-sw-cached-at', String(Date.now()));
                const stamped = new Response(body, {
                    status: response.status,
                    statusText: response.statusText,
                    headers
                });
                cache.put(request, stamped).catch(() => {});
            }
            return response;
        } catch {
            return null;
        }
    };

    if (cached && cachedFresh) {
        // Serve from cache immediately; refresh silently in background
        fetchAndCache().catch(() => {});
        return cached;
    }

    if (cached && !cachedFresh) {
        // Cache exists but stale — serve stale, refresh in background
        fetchAndCache().catch(() => {});
        return cached;
    }

    // No cache at all — must wait for network
    const networkResponse = await fetchAndCache();
    if (networkResponse) return networkResponse;

    // Total failure — return empty releases array so JS side degrades gracefully
    return new Response(
        JSON.stringify([]),
        {
            status: 503,
            headers: { 'Content-Type': 'application/json' }
        }
    );
}

// --- STALE-WHILE-REVALIDATE (images) ---
async function staleWhileRevalidateImage(request) {
    const cache = await caches.open(IMAGE_CACHE);
    const cached = await cache.match(request);

    const fetchPromise = fetch(request)
        .then(response => {
            if (response.ok) {
                cachePut(IMAGE_CACHE, request, response.clone(), MAX_IMAGE_ITEMS).catch(() => {});
            }
            return response;
        })
        .catch(() => null);

    if (cached) return cached;

    const networkResponse = await fetchPromise;
    if (networkResponse) return networkResponse;

    return transparentPngResponse();
}

// --- CACHE-FIRST ---
async function cacheFirst(request) {
    const cached = await caches.match(request);
    if (cached) return cached;

    try {
        const response = await fetch(request);
        if (response.ok) {
            cachePut(CACHE_NAME, request, response.clone(), MAX_SHELL_ITEMS).catch(() => {});
        }
        return response;
    } catch (err) {
        if (request.mode === 'navigate') {
            const fallback = await caches.match('./index.html');
            if (fallback) return fallback;
            return buildOfflinePage();
        }

        if (/\.(png|jpg|jpeg|webp|gif)$/i.test(request.url)) {
            return transparentPngResponse();
        }

        return new Response('Offline', { status: 503, headers: { 'Content-Type': 'text/plain' } });
    }
}

// --- HELPERS ---
function transparentPngResponse() {
    // 1×1 transparent PNG — prevents broken-image icons in the UI
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

// --- OFFLINE PAGE ---
function buildOfflinePage() {
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
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
  .actions{display:flex;flex-direction:column;gap:10px}
  button{
    background:linear-gradient(135deg,#30d158,#2ac94e);color:#fff;border:none;
    border-radius:12px;padding:12px 28px;font-size:0.9em;font-weight:700;
    font-family:inherit;cursor:pointer;width:100%;
  }
  .btn-secondary{
    background:rgba(255,255,255,0.07);border:1px solid rgba(255,255,255,0.1);
    color:#c8c8cc;
  }
  .status{font-size:0.75em;color:#636366;margin-top:16px}
</style>
</head>
<body>
<div class="card">
  <div class="icon">📴</div>
  <h1>You're offline</h1>
  <p>Mini's Repo needs a connection to load fresh content. Add the source URL directly to your app manager:</p>
  <code class="url">https://OofMini.github.io/Minis-Repo/mini.json</code>
  <div class="actions">
    <button onclick="window.location.reload()">🔄 Try again</button>
    <button class="btn-secondary" onclick="window.history.back()">← Go back</button>
  </div>
  <p class="status">You may still have cached content available if you visited recently.</p>
</div>
</body>
</html>`;

    return new Response(html, {
        status: 503,
        headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }
    });
}
