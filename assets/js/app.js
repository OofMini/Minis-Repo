// ========== TYPE DEFINITIONS ==========
/**
 * @typedef {Object} AppData
 * @property {string} id
 * @property {string} name
 * @property {string} developer
 * @property {string} description
 * @property {string} icon
 * @property {string} version
 * @property {string} downloadUrl
 * @property {string} category
 * @property {string} size
 * @property {string} searchString
 */

// ========== APP CONFIGURATION ==========
const CONFIG = {
    SEARCH_DEBOUNCE: 300,
    TOAST_DURATION: 4000,
    // FIX: Flexible Endpoint for Dev vs Prod
    API_ENDPOINT:
        window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
            ? './sidestore.json'
            : 'https://OofMini.github.io/Minis-Repo/sidestore.json',
    FALLBACK_ICON: './apps/repo-icon.png',
    BATCH_SIZE: 12
};

const AppState = {
    /** @type {AppData[]} */
    apps: [],
    /** @type {AppData[]} */
    filteredApps: [],
    renderedIds: new Set(),
    searchTerm: '',
    isLoading: true
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
let newWorker;

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

        const appGrid = document.getElementById('appGrid');
        if (appGrid) appGrid.innerHTML = '';
        AppState.renderedIds.clear();

        filterApps();
    } catch (error) {
        console.error('Initialization error:', error);
        handleError(error);
        showErrorState(error.message || 'Failed to initialize application');
    }
});

async function loadAppData() {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);

    try {
        const response = await fetch(CONFIG.API_ENDPOINT, { signal: controller.signal, cache: 'no-cache' });
        clearTimeout(timeoutId);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);

        const data = await response.json();
        if (!data?.apps || !Array.isArray(data.apps)) throw new Error('Invalid sidestore.json structure');

        const processedApps = data.apps
            .filter(app => app.versions && app.versions.length > 0)
            .map(app => {
                const latestVersion = app.versions[0];
                return {
                    id: generateId(app.bundleIdentifier),
                    name: app.name || '',
                    developer: app.developerName || 'Unknown',
                    description: app.localizedDescription || '',
                    icon: app.iconURL ?? CONFIG.FALLBACK_ICON,
                    version: latestVersion.version || 'Unknown',
                    downloadUrl: latestVersion.downloadURL || '',
                    category: inferCategory(app.bundleIdentifier || ''),
                    size: formatSize(latestVersion.size),
                    searchString: `${app.name} ${app.localizedDescription} ${app.developerName}`.toLowerCase()
                };
            });

        if (processedApps.length === 0) {
            console.warn('sidestore.json loaded but contains 0 valid apps.');
        }

        return processedApps;
    } catch (error) {
        throw error;
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

    if (infiniteScrollObserver) {
        const sentinel = document.getElementById('scroll-sentinel');
        if (sentinel) infiniteScrollObserver.observe(sentinel);
    }
}

function updateGrid() {
    const appGrid = document.getElementById('appGrid');
    if (!appGrid) return;

    const fragment = document.createDocumentFragment();
    let addedCount = 0;
    const currentCount = AppState.renderedIds.size;

    const nextBatch = AppState.filteredApps.slice(currentCount, currentCount + CONFIG.BATCH_SIZE);

    nextBatch.forEach(app => {
        if (!AppState.renderedIds.has(app.id)) {
            const actualIndex = AppState.renderedIds.size;
            const card = createAppCard(app, actualIndex);
            fragment.appendChild(card);
            AppState.renderedIds.add(app.id);
            addedCount++;
        }
    });

    if (addedCount > 0) {
        appGrid.appendChild(fragment);
        if (observer) {
            appGrid.querySelectorAll('.fade-in:not(.visible)').forEach(card => observer.observe(card));
        }
    }

    if (AppState.renderedIds.size >= AppState.filteredApps.length) {
        if (infiniteScrollObserver) infiniteScrollObserver.disconnect();
    }

    const noResultsEl = appGrid.querySelector('.no-results');
    if (AppState.filteredApps.length === 0) {
        if (!noResultsEl) {
            appGrid.innerHTML = `<div class="fade-in no-results visible"><h3>No apps found</h3><p>Try different search terms</p></div>`;
        }
    } else if (noResultsEl) {
        noResultsEl.remove();
    }
}

/**
 * @param {AppData} app
 * @param {number} index
 */
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
    img.onerror = () => {
        img.src = CONFIG.FALLBACK_ICON;
    };

    article.querySelector('.app-status').textContent = `✅ Fully Working • v${app.version}`;
    article.querySelector('h3').textContent = app.name;
    article.querySelector('.app-category-tag').textContent = app.category;

    const descEl = article.querySelector('.app-description-text');
    descEl.innerHTML = `By <b>${escapeHtml(app.developer)}</b><br>${escapeHtml(app.description)}`;
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
            if (entries[0].isIntersecting) updateGrid();
        },
        { rootMargin: '200px' }
    );

    infiniteScrollObserver.observe(sentinel);
}

function handleGridClick(e) {
    if (e.target.classList.contains('action-download')) {
        trackDownload(e.target.getAttribute('data-id'));
    }
}

// ========== ACTIONS ==========
async function trackDownload(appId) {
    const app = AppState.apps.find(a => a.id === appId);
    if (!app) return;

    if (!isValidDownloadUrl(app.downloadUrl)) {
        showToast('Security Block: Invalid Download URL', 'error');
        return;
    }

    window.open(app.downloadUrl, '_blank', 'noopener,noreferrer');
    showToast(`✅ Downloading ${app.name}`, 'success');
}

/**
 * Validates download URLs against a strict whitelist.
 * Rejects subdomains unless explicitly allowed.
 * @param {string} url
 * @returns {boolean}
 */
function isValidDownloadUrl(url) {
    try {
        const parsed = new URL(url);
        if (parsed.protocol !== 'https:') return false;

        // Strict Domain Whitelist (No Wildcards)
        const allowedDomains = new Set([
            'github.com',
            'raw.githubusercontent.com',
            'archive.org',
            'objects.githubusercontent.com'
        ]);

        return allowedDomains.has(parsed.hostname);
    } catch {
        return false;
    }
}

// ========== UI HELPERS ==========
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
        navigator.serviceWorker
            .register('./sw.js')
            .then(reg => {
                reg.addEventListener('updatefound', () => {
                    newWorker = reg.installing;
                    newWorker.addEventListener('statechange', () => {
                        if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
                            showUpdateNotification();
                        }
                    });
                });
            })
            .catch(err => {
                console.error('SW Registration Failed:', err);
            });

        let refreshing;
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
        callback: () => newWorker?.postMessage({ action: 'skipWaiting' })
    });
}

function escapeHtml(unsafe) {
    if (!unsafe) return '';
    return unsafe
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

function generateId(bid) {
    return bid ? bid.split('.').pop().toLowerCase() : 'unknown';
}

function inferCategory(bid) {
    const b = bid.toLowerCase();
    if (b.includes('spotify') || b.includes('music')) return 'Music';
    if (b.includes('youtube') || b.includes('video')) return 'Video';
    if (b.includes('social') || b.includes('gram') || b.includes('tweet')) return 'Social';
    return 'Utilities';
}

function formatSize(b) {
    return b ? `${(b / (1024 * 1024)).toFixed(0)} MB` : 'Unknown';
}

function showLoadingState() {
    const grid = document.getElementById('appGrid');
    if (!grid) return;
    grid.innerHTML = Array(6)
        .fill(0)
        .map(
            (_, i) => `
        <div class="skeleton-card fade-in stagger-${(i % 3) + 1}">
            <div class="skeleton skeleton-icon"></div>
            <div class="skeleton skeleton-text short"></div>
            <div class="skeleton skeleton-text medium"></div>
            <div class="skeleton skeleton-text medium"></div>
            <div class="skeleton skeleton-button"></div>
        </div>
    `
        )
        .join('');

    requestAnimationFrame(() => {
        grid.querySelectorAll('.fade-in').forEach(el => el.classList.add('visible'));
    });
}

function showErrorState(msg) {
    const grid = document.getElementById('appGrid');
    if (!grid) return;
    grid.innerHTML = `
        <div class="error-state fade-in visible">
            <div class="error-emoji">⚠️</div>
            <h3>Error</h3>
            <p>${escapeHtml(msg)}</p>
            <button class="download-btn" onclick="location.reload()">Retry</button>
        </div>
    `;
}

function setupEventListeners() {
    const searchBox = document.getElementById('searchBox');
    if (searchBox) {
        let debounceTimer;
        searchBox.addEventListener('input', e => {
            clearTimeout(debounceTimer);
            debounceTimer = setTimeout(() => {
                AppState.searchTerm = e.target.value.toLowerCase().trim();
                filterApps();
            }, CONFIG.SEARCH_DEBOUNCE);
        });
    }

    document.getElementById('btn-reset')?.addEventListener('click', async () => {
        if (confirm('Reset all local data?')) {
            try {
                localStorage.clear();
                if ('caches' in window) {
                    const keys = await caches.keys();
                    await Promise.all(keys.map(key => caches.delete(key)));
                }
                window.location.reload();
            } catch (e) {
                console.error('Reset failed:', e);
                window.location.reload();
            }
        }
    });

    document.getElementById('btn-trollapps')?.addEventListener('click', () => {
        window.location.href = `trollapps://add-repo?url=${encodeURIComponent(CONFIG.API_ENDPOINT.replace('sidestore.json', 'trollapps.json'))}`;
    });

    document.getElementById('btn-sidestore')?.addEventListener('click', () => {
        window.location.href = `sidestore://add-source?url=${encodeURIComponent(CONFIG.API_ENDPOINT)}`;
    });

    document.getElementById('appGrid')?.addEventListener('click', handleGridClick);
}

function setupGlobalErrorHandling() {
    window.addEventListener('unhandledrejection', event => {
        console.warn('Unhandled promise rejection:', event.reason);
    });
    window.addEventListener('error', event => {
        console.error('Global error:', event.error);
    });
}

function handleError(error) {
    console.error(error);
    showToast(error.message || 'An error occurred', 'error');
}

function initializeScrollAnimations() {
    if ('IntersectionObserver' in window) {
        observer = new IntersectionObserver(
            entries => {
                entries.forEach(entry => {
                    if (entry.isIntersecting) {
                        entry.target.classList.add('visible');
                        observer.unobserve(entry.target);
                    }
                });
            },
            { threshold: 0.1 }
        );

        document.querySelectorAll('.fade-in, .fade-in-left').forEach(el => observer.observe(el));
    } else {
        document.querySelectorAll('.fade-in, .fade-in-left').forEach(el => el.classList.add('visible'));
    }
}
