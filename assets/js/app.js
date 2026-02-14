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
    // Duration (ms) to wait after adding .visible before clearing will-change.
    // Matches the 600ms CSS transition + stagger delays + buffer.
    WILL_CHANGE_CLEANUP_DELAY: 700
};

const AppState = {
    apps: [],
    filteredApps: [],
    renderedIds: new Set(),
    searchTerm: '',
    isLoading: true,
    toastTimer: null
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
            showErrorState('No apps available in this repository');
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

    // CRIT-3 FIX: Set aria-busy during data loading
    const appGrid = document.getElementById('appGrid');
    if (appGrid) appGrid.setAttribute('aria-busy', 'true');

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
            throw new Error('Data corruption: Unable to parse app manifest.');
        }

        if (!data?.apps || !Array.isArray(data.apps)) {
            throw new Error('Invalid manifest structure');
        }

        const processedApps = data.apps
            .filter(app => app.versions?.length > 0)
            .map(app => {
                const latestVersion = app.versions[0];
                return {
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
            throw new Error('Request timeout — please check your connection');
        }
        throw error;
    } finally {
        clearTimeout(timeoutId);
        // CRIT-3 FIX: Clear aria-busy after loading completes (success or failure)
        if (appGrid) appGrid.removeAttribute('aria-busy');
    }
}

function filterApps() {
    AppState.filteredApps = AppState.apps.filter(app => {
        if (!AppState.searchTerm) return true;
        return app.searchString.includes(AppState.searchTerm);
    });

    const appGrid = document.getElementById('appGrid');
    if (appGrid) {
        appGrid.innerHTML = '';
        // CRIT-3 FIX: Set aria-busy during grid rebuild
        appGrid.setAttribute('aria-busy', 'true');
    }

    AppState.renderedIds.clear();
    updateGrid();

    // After grid re-render from search, manage focus for keyboard users.
    const searchBox = document.getElementById('searchBox');
    if (searchBox && document.activeElement === searchBox) {
        // User is typing in search — keep focus on search box
    } else if (appGrid && AppState.filteredApps.length > 0) {
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
        // CRIT-3 FIX: Clear aria-busy when grid is fully rendered
        appGrid.removeAttribute('aria-busy');
        return;
    }

    if ('requestIdleCallback' in window) {
        requestIdleCallback(() => renderBatch(nextBatch, appGrid));
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
        // CRIT-3 FIX: All items rendered — clear aria-busy
        container.removeAttribute('aria-busy');
    }

    handleEmptyState(container);
}

function handleEmptyState(container) {
    const noResultsEl = container.querySelector('.no-results');
    if (AppState.filteredApps.length === 0 && !noResultsEl) {
        container.innerHTML = `<div class="fade-in no-results visible"><h3>No apps found</h3><p>Try different search terms</p></div>`;
        container.removeAttribute('aria-busy');
    } else if (AppState.filteredApps.length > 0 && noResultsEl) {
        noResultsEl.remove();
    }
}

function createAppCard(app, index) {
    const cardFragment = document.importNode(AppCardTemplate.content, true);
    const article = cardFragment.querySelector('article');

    article.setAttribute('data-app-id', app.id);
    article.setAttribute('aria-label', app.name);
    article.classList.add(`stagger-${(index % 3) + 1}`);

    const img = article.querySelector('.app-icon');
    img.src = app.icon;
    img.alt = `${app.name} icon`;
    img.onerror = () => { img.src = CONFIG.FALLBACK_ICON; };

    article.querySelector('.app-status').textContent = `✅ Working • v${app.version}`;
    article.querySelector('h3').textContent = app.name;
    article.querySelector('.app-category-tag').textContent = app.category;

    const descEl = article.querySelector('.app-description-text');
    const byText = document.createTextNode('By ');
    const devBold = document.createElement('b');
    devBold.textContent = app.developer;
    descEl.appendChild(byText);
    descEl.appendChild(devBold);
    descEl.appendChild(document.createElement('br'));
    descEl.appendChild(document.createTextNode(app.description));

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
    if (e.target.classList.contains('action-retry')) {
        location.reload();
    }
}

// HIGH-3 FIX: Use a temporary <a> element instead of window.open to avoid
// popup blockers. The click() call on an <a> element with target="_blank"
// is treated as a user-initiated navigation by browsers, even when called
// from an async path within a click handler.
function trackDownload(appId) {
    const app = AppState.apps.find(a => a.id === appId);
    if (!app) return;

    if (!isValidDownloadUrl(app.downloadUrl)) {
        showToast('⚠️ Security Block: URL must be HTTPS', 'error');
        return;
    }

    const link = document.createElement('a');
    link.href = app.downloadUrl;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.style.display = 'none';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);

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

// CRIT-1 FIX: Clear previous toast timer before setting a new one.
// Without this, rapid showToast calls cause the old timer to fire and
// dismiss the current toast prematurely.
function showToast(msg, type = 'info', action = null) {
    const toast = document.getElementById('toast');
    if (!toast) return;

    // Clear any existing dismiss timer
    if (AppState.toastTimer) {
        clearTimeout(AppState.toastTimer);
        AppState.toastTimer = null;
    }

    toast.innerHTML = '';
    const textSpan = document.createElement('span');
    textSpan.textContent = msg;
    toast.appendChild(textSpan);

    if (action) {
        const actionBtn = document.createElement('button');
        actionBtn.textContent = action.text;
        actionBtn.addEventListener('click', action.callback);
        toast.appendChild(actionBtn);
    }

    toast.className = `toast ${type} show`;

    AppState.toastTimer = setTimeout(() => {
        toast.classList.remove('show');
        AppState.toastTimer = null;
    }, CONFIG.TOAST_DURATION);
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
        }).catch(err => console.error('SW registration failed:', err));

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
            if (newWorker) {
                newWorker.postMessage({ action: 'skipWaiting' });
            }
        }
    });
}

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
    if (!bytes || typeof bytes !== 'number') return 'Unknown';
    if (bytes >= 1073741824) return `${(bytes / 1073741824).toFixed(1)} GB`;
    return `${(bytes / 1048576).toFixed(0)} MB`;
}

function showLoadingState() {
    const grid = document.getElementById('appGrid');
    if (!grid) return;

    // CRIT-3 FIX: Signal loading state
    grid.setAttribute('aria-busy', 'true');

    grid.innerHTML = Array(3).fill(0).map((_, i) => `
        <div class="skeleton-card fade-in visible stagger-${(i % 3) + 1}">
            <div class="skeleton skeleton-icon"></div>
            <div class="skeleton skeleton-text short"></div>
            <div class="skeleton skeleton-text medium"></div>
            <div class="skeleton skeleton-text medium"></div>
            <div class="skeleton skeleton-button"></div>
        </div>
    `).join('');
}

function showErrorState(msg) {
    const grid = document.getElementById('appGrid');
    if (!grid) return;

    grid.removeAttribute('aria-busy');
    grid.innerHTML = `
        <div class="error-state fade-in visible">
            <div class="error-emoji">⚠️</div>
            <h3>Something went wrong</h3>
            <p></p>
            <button class="download-btn action-retry">Retry</button>
        </div>
    `;
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
            if (confirm('Reset all local data and cache?')) {
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

function initializeScrollAnimations() {
    if ('IntersectionObserver' in window) {
        observer = new IntersectionObserver(entries => {
            entries.forEach(entry => {
                if (entry.isIntersecting) {
                    entry.target.classList.add('visible');
                    observer.unobserve(entry.target);

                    // Clear will-change after entrance animation finishes to reclaim
                    // the GPU compositor layer.
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

    if (AppState.toastTimer) {
        clearTimeout(AppState.toastTimer);
    }

    const searchBox = document.getElementById('searchBox');
    if (searchBox && searchBox._debounceTimer) {
        clearTimeout(searchBox._debounceTimer);
    }
});
