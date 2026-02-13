// ========== CONFIGURATION ==========
const CONFIG = {
    SEARCH_DEBOUNCE: 300,
    TOAST_DURATION: 4000,
    FETCH_TIMEOUT: 10000,
    API_ENDPOINT:
        window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
            ? './mini.json'
            : 'https://OofMini.github.io/Minis-Repo/mini.json',
    FALLBACK_ICON: './apps/repo-icon.png',
    BATCH_SIZE: 12,
    // MEDIUM-1: Duration (ms) to wait after adding .visible before clearing will-change.
    // Matches the 600ms CSS transition + 100ms buffer to ensure the animation has
    // fully completed before removing the compositor layer promotion.
    WILL_CHANGE_CLEANUP_DELAY: 700
};

const AppState = {
    apps: [],
    filteredApps: [],
    renderedIds: new Set(),
    searchTerm: '',
    isLoading: true,
    pendingIdleCallbacks: [] 
};

const AppCardTemplate = document.createElement('template');
AppCardTemplate.innerHTML = `
    <article class="app-card fade-in" role="article">
        <div class="app-icon-container">
            <img class="app-icon" loading="lazy" decoding="async" width="80" height="80">
        </div>
        <div class="app-status"></div>
        <div class="app-card-content">
            <h3></h3>
            <p class="app-category-wrapper"><span class="app-category-tag"></span></p>
            <div class="app-description-text"></div>
            <p class="app-meta-size"></p>
            <button class="download-btn action-download"></button>
        </div>
    </article>
`;

let observer = null;
let infiniteScrollObserver = null;
let newWorker = null;

document.addEventListener('DOMContentLoaded', async function () {
    try {
        setupEventListeners();
        setupGlobalErrorHandling();
        setupPWA();
        initializeScrollAnimations();
        setupInfiniteScroll();
        showLoadingState();

        AppState.apps = await loadAppData();
        AppState.isLoading = false;

        if (AppState.apps.length === 0) {
            showErrorState("No apps available in this repository");
        } else {
            const appGrid = document.getElementById('appGrid');
            if (appGrid) appGrid.innerHTML = '';
            AppState.renderedIds.clear();
            filterApps();
        }
    } catch (error) {
        console.error('Initialization error:', error);
        handleError(error);
        showErrorState(error.message ?? 'Failed to initialize application');
    }
});

async function loadAppData() {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), CONFIG.FETCH_TIMEOUT);

    try {
        const response = await fetch(CONFIG.API_ENDPOINT, {
            signal: controller.signal,
            cache: 'no-cache'
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        let data;
        try {
            data = await response.json();
        } catch (e) {
            throw new Error("Data corruption: Unable to parse app manifest.");
        }

        if (!data?.apps || !Array.isArray(data.apps)) {
            throw new Error('Invalid manifest structure');
        }

        const processedApps = data.apps
            .filter(app => app.versions?.length > 0)
            .map(app => {
                const latestVersion = app.versions[0];
                return {
                    // HIGH FIX: Use full bundleIdentifier as the ID.
                    // The previous implementation used only the last segment
                    // (e.g., "client" from "com.spotify.client"), which could
                    // produce duplicate IDs if two apps share the same last segment.
                    // This broke renderedIds tracking and trackDownload lookups.
                    id: generateId(app.bundleIdentifier),
                    name: app.name ?? 'Unknown App',
                    developer: app.developerName ?? 'Unknown',
                    description: app.localizedDescription ?? '',
                    icon: app.iconURL ?? CONFIG.FALLBACK_ICON,
                    version: latestVersion.version ?? 'Unknown',
                    downloadUrl: latestVersion.downloadURL ?? '',
                    category: inferCategory(app.bundleIdentifier ?? ''),
                    size: formatSize(latestVersion.size),
                    searchString: `${app.name} ${app.localizedDescription} ${app.developerName}`.toLowerCase()
                };
            });

        return processedApps;
    } catch (error) {
        if (error.name === 'AbortError') {
            throw new Error('Request timeout - please check your connection');
        }
        throw error;
    } finally {
        clearTimeout(timeoutId);
    }
}

function filterApps() {
    AppState.filteredApps = AppState.apps.filter(app => {
        if (!AppState.searchTerm) return true;
        return app.searchString.includes(AppState.searchTerm);
    });

    const appGrid = document.getElementById('appGrid');
    if (appGrid) appGrid.innerHTML = '';
    
    AppState.renderedIds.clear();

    updateGrid();

    // MEDIUM-11 FIX: After grid re-render from search, move focus to the grid
    // region so keyboard users don't lose their position in the page.
    // Only do this when triggered by search (searchTerm is non-empty or was just cleared).
    const searchBox = document.getElementById('searchBox');
    if (searchBox && document.activeElement === searchBox) {
        // User is typing in search — keep focus on search box
    } else if (appGrid && AppState.filteredApps.length > 0) {
        // Focus the grid region so screen readers announce new content
        appGrid.setAttribute('tabindex', '-1');
        appGrid.focus({ preventScroll: true });
    }

    const sentinel = document.getElementById('scroll-sentinel');
    if (infiniteScrollObserver && sentinel) {
        infiniteScrollObserver.observe(sentinel);
    }
}

function updateGrid() {
    const appGrid = document.getElementById('appGrid');
    if (!appGrid) return;

    const currentCount = AppState.renderedIds.size;
    const nextBatch = AppState.filteredApps.slice(currentCount, currentCount + CONFIG.BATCH_SIZE);

    if (nextBatch.length === 0) {
        handleEmptyState(appGrid);
        return;
    }

    if ('requestIdleCallback' in window) {
        const id = requestIdleCallback(() => renderBatch(nextBatch, appGrid));
        if (id !== undefined) {
            AppState.pendingIdleCallbacks.push(id);
        }
    } else {
        setTimeout(() => renderBatch(nextBatch, appGrid), 0);
    }
}

function renderBatch(batch, container) {
    if (!document.contains(container)) return;

    const fragment = document.createDocumentFragment();
    let addedCount = 0;

    batch.forEach(app => {
        if (!AppState.renderedIds.has(app.id)) {
            const actualIndex = AppState.renderedIds.size;
            const card = createAppCard(app, actualIndex);
            fragment.appendChild(card);
            AppState.renderedIds.add(app.id);
            addedCount++;
        }
    });

    if (addedCount > 0) {
        container.appendChild(fragment);
        if (observer) {
            container.querySelectorAll('.fade-in:not(.visible)').forEach(card => observer.observe(card));
        }
    }

    if (AppState.renderedIds.size >= AppState.filteredApps.length) {
        if (infiniteScrollObserver) {
            infiniteScrollObserver.disconnect();
        }
    }

    handleEmptyState(container);
}

function handleEmptyState(container) {
    const noResultsEl = container.querySelector('.no-results');
    if (AppState.filteredApps.length === 0 && !noResultsEl) {
        container.innerHTML = `<div class="fade-in no-results visible"><h3>No apps found</h3><p>Try different search terms</p></div>`;
    } else if (AppState.filteredApps.length > 0 && noResultsEl) {
        noResultsEl.remove();
    }
}

function createAppCard(app, index) {
    const cardFragment = document.importNode(AppCardTemplate.content, true);
    const article = cardFragment.querySelector('article');

    article.setAttribute('data-app-id', app.id);
    article.setAttribute('aria-label', app.name);
    article.classList.add('fade-in');
    article.classList.add(`stagger-${(index % 3) + 1}`);

    const img = article.querySelector('.app-icon');
    img.src = app.icon;
    img.alt = `${app.name} Icon`;
    img.onerror = () => { img.src = CONFIG.FALLBACK_ICON; };

    article.querySelector('.app-status').textContent = `✅ Fully Working • v${app.version}`;
    article.querySelector('h3').textContent = app.name;
    article.querySelector('.app-category-tag').textContent = app.category;

    const descEl = article.querySelector('.app-description-text');
    descEl.textContent = ''; 
    
    const byText = document.createTextNode('By ');
    const devBold = document.createElement('b');
    devBold.textContent = app.developer;
    descEl.appendChild(byText);
    descEl.appendChild(devBold);
    descEl.appendChild(document.createElement('br'));
    
    const descText = document.createTextNode(app.description);
    descEl.appendChild(descText);

    article.querySelector('.app-meta-size').textContent = `Size: ${app.size}`;

    const btn = article.querySelector('.download-btn');
    btn.setAttribute('data-id', app.id);
    btn.textContent = '⬇️ Download IPA';

    return cardFragment;
}

function setupInfiniteScroll() {
    const main = document.querySelector('main');
    if (!main) return;

    const sentinel = document.createElement('div');
    sentinel.id = 'scroll-sentinel';
    sentinel.style.cssText = 'height: 20px; width: 100%;';
    main.appendChild(sentinel);

    infiniteScrollObserver = new IntersectionObserver(
        entries => {
            if (entries[0].isIntersecting) {
                updateGrid();
            }
        },
        { rootMargin: '200px' }
    );

    infiniteScrollObserver.observe(sentinel);
}

function handleGridClick(e) {
    if (e.target.classList.contains('action-download')) {
        const appId = e.target.getAttribute('data-id');
        if (appId) {
            trackDownload(appId);
        }
    }
    // MEDIUM-9 FIX: Handle retry button click via event delegation.
    // The retry button is now identified by class instead of inline onclick,
    // because CSP script-src 'self' blocks inline event handlers.
    if (e.target.classList.contains('action-retry')) {
        location.reload();
    }
}

async function trackDownload(appId) {
    const app = AppState.apps.find(a => a.id === appId);
    if (!app) return;

    if (!isValidDownloadUrl(app.downloadUrl)) {
        showToast('⚠️ Security Block: URL must be HTTPS', 'error');
        return;
    }

    window.open(app.downloadUrl, '_blank', 'noopener,noreferrer');
    showToast(`✅ Downloading ${app.name}`, 'success');
}

function isValidDownloadUrl(url) {
    if (!url || typeof url !== 'string') return false;
    try {
        const parsed = new URL(url);
        if (parsed.protocol !== 'https:') return false;
        if (!parsed.hostname || parsed.hostname.length === 0) return false;
        return true;
    } catch {
        return false;
    }
}

function showToast(msg, type = 'info', action = null) {
    const toast = document.getElementById('toast');
    if (!toast) return;

    toast.innerHTML = '';
    const textSpan = document.createElement('span');
    textSpan.textContent = msg;
    toast.appendChild(textSpan);

    if (action) {
        const actionBtn = document.createElement('button');
        actionBtn.textContent = action.text;
        actionBtn.onclick = action.callback;
        toast.appendChild(actionBtn);
    }

    toast.className = `toast ${type} show`;
    setTimeout(() => toast.classList.remove('show'), CONFIG.TOAST_DURATION);
}

function setupPWA() {
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('./sw.js').then(reg => {
            reg.addEventListener('updatefound', () => {
                newWorker = reg.installing;
                if (newWorker) {
                    newWorker.addEventListener('statechange', () => {
                        if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
                            showUpdateNotification();
                        }
                    });
                }
            });
        }).catch(err => console.error('SW Fail:', err));

        let refreshing = false;
        navigator.serviceWorker.addEventListener('controllerchange', () => {
            if (refreshing) return;
            window.location.reload();
            refreshing = true;
        });
    }
}

function showUpdateNotification() {
    showToast('🚀 New version available!', 'info', {
        text: 'REFRESH',
        callback: () => {
            // CRITICAL-2 FIX: postMessage to the waiting worker so it calls skipWaiting()
            if (newWorker) {
                newWorker.postMessage({ action: 'skipWaiting' });
            }
        }
    });
}

// HIGH FIX: Use the full bundleIdentifier as the unique app ID.
// Previous implementation split on '.' and took only the last segment,
// which could collide (e.g., "com.spotify.client" and "com.other.client"
// both produced "client"). This caused broken rendering and download lookups.
function generateId(bundleId) {
    return bundleId ? bundleId.toLowerCase() : 'unknown';
}

function inferCategory(bundleId) {
    const bid = bundleId.toLowerCase();
    if (bid.includes('spotify') || bid.includes('music')) return 'Music';
    if (bid.includes('youtube') || bid.includes('video')) return 'Video';
    if (bid.includes('social') || bid.includes('tweet') || bid.includes('twitter')) return 'Social';
    if (bid.includes('editor') || bid.includes('inshot') || bid.includes('photo') || bid.includes('reface') || bid.includes('doublicatapp')) return 'Creative';
    if (bid.includes('torrent')) return 'Utilities';
    return 'Utilities';
}

function formatSize(bytes) {
    return bytes ? `${(bytes / (1024 * 1024)).toFixed(0)} MB` : 'Unknown';
}

function showLoadingState() {
    const grid = document.getElementById('appGrid');
    if (!grid) return;
    grid.innerHTML = Array(3).fill(0).map((_, i) => `
        <div class="skeleton-card fade-in stagger-${(i % 3) + 1}">
            <div class="skeleton skeleton-icon"></div>
            <div class="skeleton skeleton-text short"></div>
            <div class="skeleton skeleton-text medium"></div>
            <div class="skeleton skeleton-text medium"></div>
            <div class="skeleton skeleton-button"></div>
        </div>
    `).join('');
    requestAnimationFrame(() => {
        grid.querySelectorAll('.fade-in').forEach(el => el.classList.add('visible'));
    });
}

// MEDIUM-9 FIX: Replaced inline onclick="location.reload()" with a class-based
// button that is handled by the delegated click handler in handleGridClick().
// The previous inline onclick was silently blocked by the Content Security Policy
// (script-src 'self' without 'unsafe-inline'), making the Retry button non-functional.
function showErrorState(msg) {
    const grid = document.getElementById('appGrid');
    if (!grid) return;

    grid.innerHTML = `
        <div class="error-state fade-in visible">
            <div class="error-emoji">⚠️</div>
            <h3>Error</h3>
            <p></p>
            <button class="download-btn action-retry">Retry</button>
        </div>
    `;
    // textContent is XSS-safe: it sets raw text, never interprets HTML
    grid.querySelector('p').textContent = String(msg);
}

function setupEventListeners() {
    const searchBox = document.getElementById('searchBox');
    
    if (searchBox) {
        searchBox.addEventListener('input', e => {
            if (searchBox._debounceTimer) clearTimeout(searchBox._debounceTimer);
            
            searchBox._debounceTimer = setTimeout(() => {
                AppState.searchTerm = e.target.value.toLowerCase().trim();
                filterApps();
            }, CONFIG.SEARCH_DEBOUNCE);
        });
    }

    const resetBtn = document.getElementById('btn-reset');
    if (resetBtn) {
        resetBtn.addEventListener('click', async () => {
            if (confirm('Reset all local data?')) {
                try {
                    localStorage.clear();
                    if ('caches' in window) {
                        const keys = await caches.keys();
                        await Promise.all(keys.map(key => caches.delete(key)));
                    }
                    window.location.reload();
                } catch (error) {
                    window.location.reload();
                }
            }
        });
    }

    const trollappsBtn = document.getElementById('btn-trollapps');
    if (trollappsBtn) {
        trollappsBtn.addEventListener('click', () => {
            window.location.href = `trollapps://add-repo?url=${encodeURIComponent(CONFIG.API_ENDPOINT)}`;
        });
    }

    const sidestoreBtn = document.getElementById('btn-sidestore');
    if (sidestoreBtn) {
        sidestoreBtn.addEventListener('click', () => {
            window.location.href = `sidestore://add-source?url=${encodeURIComponent(CONFIG.API_ENDPOINT)}`;
        });
    }

    const appGrid = document.getElementById('appGrid');
    if (appGrid) {
        appGrid.addEventListener('click', handleGridClick);
    }
}

function setupGlobalErrorHandling() {
    window.addEventListener('unhandledrejection', event => console.warn('Unhandled rejection:', event.reason));
    window.addEventListener('error', event => console.error('Global error:', event.error));
}

function handleError(error) {
    console.error(error);
    showToast(error.message ?? 'An error occurred', 'error');
}

// MEDIUM-1 FIX: After adding .visible and unobserving, schedule removal of
// will-change after the CSS transition completes. Each element with will-change
// is promoted to its own GPU compositor layer — keeping it indefinitely wastes
// video memory. With 8+ app cards, this saves ~8 unnecessary layers.
//
// MEDIUM-4 FIX: Increased threshold from 0.1 to 0.15 for slightly more
// intentional reveal timing. At 0.1, cards start animating when barely visible,
// causing many simultaneous animations on fast scroll.
function initializeScrollAnimations() {
    if ('IntersectionObserver' in window) {
        observer = new IntersectionObserver(entries => {
            entries.forEach(entry => {
                if (entry.isIntersecting) {
                    entry.target.classList.add('visible');
                    observer.unobserve(entry.target);

                    // MEDIUM-1 FIX: Clear will-change after the entrance animation
                    // finishes. The 700ms delay covers the 600ms CSS transition plus
                    // stagger delays (100-300ms) with buffer. Setting will-change to
                    // 'auto' lets the browser reclaim the compositor layer.
                    setTimeout(() => {
                        entry.target.style.willChange = 'auto';
                    }, CONFIG.WILL_CHANGE_CLEANUP_DELAY);
                }
            });
        }, { threshold: 0.15 });
        document.querySelectorAll('.fade-in, .fade-in-left').forEach(el => observer.observe(el));
    } else {
        document.querySelectorAll('.fade-in, .fade-in-left').forEach(el => el.classList.add('visible'));
    }
}

window.addEventListener('beforeunload', () => {
    if (observer) observer.disconnect();
    if (infiniteScrollObserver) infiniteScrollObserver.disconnect();
    AppState.pendingIdleCallbacks.forEach(id => cancelIdleCallback(id));

    // Clean up debounce timer
    const searchBox = document.getElementById('searchBox');
    if (searchBox && searchBox._debounceTimer) {
        clearTimeout(searchBox._debounceTimer);
    }
});