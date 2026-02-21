// Mini's IPA Repo — Service Worker
// deploy.js dynamically replaces CACHE_NAME with git hash on build.
const CACHE_NAME = 'minis-repo-cache-ef5062a';

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
    /\/apps\/.*\.(png|jpg|jpeg|webp|gif|PNG)$/i
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
self.addEventListener('activate', (event) => {
    event.waitUntil(
        Promise.all([
            cleanOldCaches(),
            enableNavigationPreload()
        ])
            .then(() => {
                startPeriodicUpdateCheck();
                return self.clients.claim();
            })
            .catch((err) => {
                console.error('[SW] Activation error:', err);
                startPeriodicUpdateCheck();
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
    // FIX: In a Service Worker context, `navigator` (WorkerNavigator) is always
    // defined, so `typeof navigator !== 'undefined'` is always true and provides
    // no guard. The correct check is feature-detection: `'locks' in navigator`.
    if ('locks' in navigator) {
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
                // Non-fatal: fall back to unlocked cleanup rather than failing activation.
                console.warn('[SW] Lock request failed, falling back to direct cleanup:', err.message);
                await deleteOldCaches();
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
let updateCheckTimer = null;

function startPeriodicUpdateCheck() {
    if (updateCheckTimer) return;
    updateCheckTimer = setInterval(() => {
        self.registration.update().catch(() => {
            // Silently fail — network may be unavailable
        });
    }, UPDATE_CHECK_INTERVAL);
}

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
async function handleNavigation(event) {
    try {
        const preloadResponse = event.preloadResponse ? await event.preloadResponse : null;
        if (preloadResponse) {
            const cache = await caches.open(CACHE_NAME);
            cache.put(event.request, preloadResponse.clone()).catch(() => {});
            return preloadResponse;
        }

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
            const cache = await caches.open(CACHE_NAME);
            cache.put(request, response.clone()).catch(() => {});
        }
        return response;
    } catch (err) {
        const cached = await caches.match(request);
        if (cached) return cached;

        // For JSON data requests, return a structured error response
        if (request.url.endsWith('.json')) {
            return new Response(
                JSON.stringify({ error: 'offline', message: 'You appear to be offline.' }),
                {
                    status: 503,
                    headers: { 'Content-Type': 'application/json' }
                }
            );
        }

        return new Response('Offline', {
            status: 503,
            headers: { 'Content-Type': 'text/plain' }
        });
    }
}

// --- STALE-WHILE-REVALIDATE ---
async function staleWhileRevalidate(request) {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(request);

    const fetchPromise = fetch(request)
        .then((response) => {
            if (response.ok) {
                cache.put(request, response.clone()).catch(() => {});
            }
            return response;
        })
        .catch(() => null);

    if (cached) return cached;

    const networkResponse = await fetchPromise;
    if (networkResponse) return networkResponse;

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
            cache.put(request, response.clone()).catch(() => {});
        }
        return response;
    } catch (err) {
        if (request.mode === 'navigate') {
            const fallback = await caches.match('./index.html');
            if (fallback) return fallback;

            return buildOfflinePage();
        }

        return new Response('Offline', {
            status: 503,
            headers: { 'Content-Type': 'text/plain' }
        });
    }
}

// --- OFFLINE PAGE ---
// FIX: Extracted to a dedicated function (DRY) so both handleNavigation and
// cacheFirst return the same high-quality offline experience rather than
// only one of them having the full fallback HTML.
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
    background:#000;
    color:#f5f5f7;
    font-family:-apple-system,BlinkMacSystemFont,'SF Pro Display','Helvetica Neue',system-ui,sans-serif;
    display:flex;
    align-items:center;
    justify-content:center;
    min-height:100vh;
    min-height:100dvh;
    text-align:center;
    padding:24px;
    -webkit-font-smoothing:antialiased;
  }
  .card{
    background:rgba(255,255,255,0.05);
    border:1px solid rgba(255,255,255,0.08);
    border-radius:20px;
    padding:40px 32px;
    max-width:360px;
    width:100%;
  }
  .icon{font-size:3em;margin-bottom:16px;line-height:1}
  h1{font-size:1.4em;font-weight:700;margin-bottom:8px;letter-spacing:-0.3px}
  p{color:#8e8e93;font-size:0.9em;line-height:1.5;margin-bottom:24px}
  .url{
    font-family:'SF Mono',Menlo,Monaco,'Cascadia Code',Consolas,monospace;
    font-size:0.72em;
    color:#a78bfa;
    background:rgba(167,139,250,0.08);
    border:1px solid rgba(167,139,250,0.15);
    padding:8px 12px;
    border-radius:8px;
    word-break:break-all;
    margin-bottom:24px;
    display:block;
  }
  button{
    background:linear-gradient(135deg,#30d158,#2ac94e);
    color:#fff;
    border:none;
    border-radius:12px;
    padding:12px 28px;
    font-size:0.9em;
    font-weight:700;
    font-family:inherit;
    cursor:pointer;
    width:100%;
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
        headers: {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-store'
        }
    });
}
