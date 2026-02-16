// ========== CONFIGURATION ==========
const CONFIG = {
    SEARCH_DEBOUNCE: 300,
    TOAST_DURATION: 4000,
    FETCH_TIMEOUT: 10000,
    API_ENDPOINT:
        window.location.hostname === 'localhost' ||
        window.location.hostname === '127.0.0.1' ||
        window.location.hostname === '0.0.0.0' ||
        window.location.hostname === '[::1]'
            ? './mini.json'
            : 'https://OofMini.github.io/Minis-Repo/mini.json',
    FALLBACK_ICON: './apps/repo-icon.png',
    BATCH_SIZE: 12,
    WILL_CHANGE_CLEANUP_DELAY: 700,
    SW_UPDATE_INTERVAL: 30 * 60 * 1000 // 30 minutes
};

const AppState = {
    apps: [],
    filteredApps: [],
    renderedIds: new Set(),
    searchTerm: '',
    isLoading: true,
    toastTimer: null,
    isOnline: navigator.onLine,
    deferredInstallPrompt: null,
    modalOpen: false
};

const AppCardTemplate = document.createElement('template');
AppCardTemplate.innerHTML = `
    <article class="app-card fade-in" role="article" tabindex="0">
        <div class="app-icon-container">
            <img class="app-icon" loading="lazy" decoding="async" width="80" height="80">
        </div>
        <div class="app-status"></div>
        <div class="app-card-content">
            <h3></h3>
            <p class="app-category-wrapper"><span class="app-category-tag"></span></p>
            <div class="app-description-text"></div>
            <button class="changelog-toggle" aria-expanded="false" style="display:none;">
                <span>What's New</span>
                <span class="changelog-toggle-arrow" aria-hidden="true">▶</span>
            </button>
            <div class="changelog-content">
                <div class="changelog-text"></div>
            </div>
            <p class="app-meta-size"></p>
            <button class="download-btn action-download"></button>
        </div>
    </article>
`;

let observer = null;
let infiniteScrollObserver = null;
let newWorker = null;
let swUpdateTimer = null;

document.addEventListener('DOMContentLoaded', async function () {
    try {
        setupEventListeners();
        setupGlobalErrorHandling();
        setupPWA();
        setupInstallPrompt();
        setupOnlineOfflineDetection();
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
            .map((app, idx) => {
                const latestVersion = app.versions[0];
                const category = inferCategory(app.bundleIdentifier ?? '');
                return {
                    // BUG FIX: generateId now uses index fallback to prevent
                    // duplicate 'unknown' IDs when bundleIdentifier is missing.
                    id: generateId(app.bundleIdentifier, idx),
                    name: app.name ?? 'Unknown App',
                    bundleId: app.bundleIdentifier ?? '',
                    developer: app.developerName ?? 'Unknown',
                    description: app.localizedDescription ?? '',
                    icon: app.iconURL ?? CONFIG.FALLBACK_ICON,
                    version: latestVersion.version ?? 'Unknown',
                    date: latestVersion.date ?? '',
                    downloadUrl: latestVersion.downloadURL ?? '',
                    category: category,
                    size: formatSize(latestVersion.size),
                    sizeBytes: latestVersion.size ?? 0,
                    changeDescription: latestVersion.changeDescription ?? '',
                    tintColor: app.tintColor ?? '#1DB954',
                    subtitle: app.subtitle ?? '',
                    minimumOS: app.minimumOSVersion ?? '15.0',
                    permissions: app.permissions ?? [],
                    // BUG FIX: Screenshots were loaded from mini.json but never
                    // stored or displayed. Now stored for the detail modal.
                    screenshots: app.screenshotURLs ?? [],
                    // FIX #6: Include category in searchString so users can filter
                    // by category name (e.g., "music", "video", "utilities", "creative").
                    searchString: `${app.name} ${app.localizedDescription} ${app.developerName} ${category}`.toLowerCase()
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
        appGrid.setAttribute('aria-busy', 'true');
    }

    AppState.renderedIds.clear();
    updateGrid();

    const searchBox = document.getElementById('searchBox');
    if (searchBox && document.activeElement === searchBox) {
        // User is typing — keep focus on search box
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
    article.setAttribute('aria-label', `${app.name} — tap to view details`);
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

    // Changelog toggle — only show if changeDescription exists
    if (app.changeDescription) {
        const toggleBtn = article.querySelector('.changelog-toggle');
        toggleBtn.style.display = '';
        toggleBtn.setAttribute('data-app-id', app.id);

        article.querySelector('.changelog-text').textContent = app.changeDescription;
    }

    article.querySelector('.app-meta-size').textContent = `Size: ${app.size}`;

    const btn = article.querySelector('.download-btn');
    btn.setAttribute('data-id', app.id);
    btn.textContent = '⬇️ Download IPA';

    // Dim download button when offline
    if (!AppState.isOnline) {
        btn.classList.add('offline-disabled');
    }

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

// ========== GRID CLICK / KEYBOARD HANDLER ==========
function handleGridClick(e) {
    if (e.target.classList.contains('action-download')) {
        const appId = e.target.getAttribute('data-id');
        if (appId) {
            trackDownload(appId);
        }
        return;
    }

    if (e.target.classList.contains('action-retry')) {
        location.reload();
        return;
    }

    // Changelog toggle — handle clicks on the button or its children
    const toggleBtn = e.target.closest('.changelog-toggle');
    if (toggleBtn) {
        e.stopPropagation();
        const expanded = toggleBtn.getAttribute('aria-expanded') === 'true';
        toggleBtn.setAttribute('aria-expanded', String(!expanded));
        const content = toggleBtn.nextElementSibling;
        if (content && content.classList.contains('changelog-content')) {
            content.classList.toggle('expanded', !expanded);
        }
        return;
    }

    // Card click — open detail modal (but not for button/link clicks)
    const card = e.target.closest('.app-card');
    if (card && !e.target.closest('button') && !e.target.closest('a')) {
        const appId = card.getAttribute('data-app-id');
        if (appId) openAppModal(appId);
    }
}

function handleGridKeydown(e) {
    if (e.key === 'Enter' || e.key === ' ') {
        const card = e.target.closest('.app-card');
        if (card && e.target === card) {
            e.preventDefault();
            const appId = card.getAttribute('data-app-id');
            if (appId) openAppModal(appId);
        }
    }
}

// ========== APP DETAIL MODAL ==========
function openAppModal(appId) {
    const app = AppState.apps.find(a => a.id === appId);
    if (!app) return;

    AppState.modalOpen = true;

    const existing = document.getElementById('appModal');
    if (existing) existing.remove();

    const modal = document.createElement('div');
    modal.id = 'appModal';
    modal.className = 'modal-overlay';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-label', `${app.name} details`);

    const screenshotsHtml = app.screenshots.length > 0
        ? `<div class="modal-screenshots" role="region" aria-label="Screenshots">
               ${app.screenshots.map((url, i) =>
                   `<img src="${escapeAttr(url)}" alt="${escapeAttr(app.name)} screenshot ${i + 1}" loading="lazy" decoding="async" class="modal-screenshot">`
               ).join('')}
           </div>`
        : '';

    const permissionsHtml = app.permissions.length > 0
        ? `<div class="modal-permissions">
               <span class="modal-permissions-label">Permissions:</span>
               ${app.permissions.map(p => `<span class="modal-perm-tag">${escapeHtml(p)}</span>`).join('')}
           </div>`
        : '';

    const changelogHtml = app.changeDescription
        ? `<div class="modal-changelog">
               <strong>What's New:</strong>
               <p>${escapeHtml(app.changeDescription)}</p>
           </div>`
        : '';

    modal.innerHTML = `
        <div class="modal-backdrop"></div>
        <div class="modal-content" role="document">
            <button class="modal-close" aria-label="Close dialog">&times;</button>
            <div class="modal-header">
                <div class="modal-icon-container">
                    <img src="${escapeAttr(app.icon)}" alt="${escapeAttr(app.name)} icon"
                         class="modal-icon" width="96" height="96"
                         onerror="this.src='${CONFIG.FALLBACK_ICON}'">
                </div>
                <div class="modal-title-block">
                    <h2 class="modal-title">${escapeHtml(app.name)}</h2>
                    <p class="modal-developer">${escapeHtml(app.developer)}</p>
                    <div class="modal-meta">
                        <span class="modal-meta-item">v${escapeHtml(app.version)}</span>
                        <span class="modal-meta-sep">•</span>
                        <span class="modal-meta-item">${escapeHtml(app.size)}</span>
                        <span class="modal-meta-sep">•</span>
                        <span class="modal-meta-item">iOS ${escapeHtml(app.minimumOS)}+</span>
                    </div>
                </div>
            </div>
            ${screenshotsHtml}
            <div class="modal-body">
                <p class="modal-description">${escapeHtml(app.description)}</p>
                ${changelogHtml}
                ${permissionsHtml}
                <p class="modal-date">Last updated: ${escapeHtml(app.date)}</p>
            </div>
            <div class="modal-footer">
                <button class="download-btn modal-download-btn" data-id="${escapeAttr(app.id)}">
                    ⬇️ Download IPA
                </button>
            </div>
        </div>
    `;

    document.body.appendChild(modal);
    document.body.classList.add('modal-open');

    // Force reflow then animate in
    modal.offsetHeight;
    modal.classList.add('active');

    // Focus trap
    const closeBtn = modal.querySelector('.modal-close');
    closeBtn.focus();

    // Close handlers
    modal.querySelector('.modal-backdrop').addEventListener('click', closeAppModal);
    closeBtn.addEventListener('click', closeAppModal);
    modal.querySelector('.modal-download-btn').addEventListener('click', () => {
        trackDownload(app.id);
    });

    modal.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            e.stopPropagation();
            closeAppModal();
        }
    });
}

function closeAppModal() {
    const modal = document.getElementById('appModal');
    if (!modal) return;

    AppState.modalOpen = false;
    modal.classList.remove('active');
    document.body.classList.remove('modal-open');

    // Wait for animation to complete before removing from DOM
    setTimeout(() => {
        if (modal.parentNode) modal.remove();
    }, 300);
}

function escapeHtml(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

function escapeAttr(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ========== DOWNLOAD HANDLER ==========
function trackDownload(appId) {
    const app = AppState.apps.find(a => a.id === appId);
    if (!app) return;

    if (!AppState.isOnline) {
        showToast('📴 You are offline. Downloads require an internet connection.', 'warning');
        return;
    }

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

// ========== TOAST NOTIFICATIONS ==========
function showToast(msg, type = 'info', action = null) {
    const toast = document.getElementById('toast');
    if (!toast) return;

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

    // ACCESSIBILITY FIX: Use assertive for errors/warnings so screen
    // readers announce them immediately, polite for info/success.
    toast.setAttribute('aria-live', (type === 'error' || type === 'warning') ? 'assertive' : 'polite');
    toast.className = `toast ${type} show`;

    AppState.toastTimer = setTimeout(() => {
        toast.classList.remove('show');
        AppState.toastTimer = null;
    }, CONFIG.TOAST_DURATION);
}

// ========== PWA SERVICE WORKER ==========
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

            // Periodic SW update check for long-lived PWA sessions
            swUpdateTimer = setInterval(() => {
                reg.update().catch(() => {});
            }, CONFIG.SW_UPDATE_INTERVAL);
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

// ========== PWA INSTALL PROMPT ==========
function setupInstallPrompt() {
    window.addEventListener('beforeinstallprompt', (e) => {
        e.preventDefault();
        AppState.deferredInstallPrompt = e;
        showInstallBanner();
    });

    window.addEventListener('appinstalled', () => {
        AppState.deferredInstallPrompt = null;
        hideInstallBanner();
        showToast('✅ App installed successfully!', 'success');
    });
}

function showInstallBanner() {
    const banner = document.getElementById('installBanner');
    if (banner) {
        banner.classList.add('visible');
        banner.removeAttribute('hidden');
    }
}

function hideInstallBanner() {
    const banner = document.getElementById('installBanner');
    if (banner) {
        banner.classList.remove('visible');
        banner.setAttribute('hidden', '');
    }
}

async function handleInstallClick() {
    const prompt = AppState.deferredInstallPrompt;
    if (!prompt) return;

    prompt.prompt();
    const result = await prompt.userChoice;

    if (result.outcome === 'accepted') {
        console.log('PWA install accepted');
    }
    AppState.deferredInstallPrompt = null;
    hideInstallBanner();
}

// ========== ONLINE / OFFLINE DETECTION ==========
function setupOnlineOfflineDetection() {
    const offlineBar = document.getElementById('offlineBar');

    function updateOnlineStatus() {
        AppState.isOnline = navigator.onLine;

        if (offlineBar) {
            if (AppState.isOnline) {
                offlineBar.classList.remove('visible');
                offlineBar.setAttribute('hidden', '');
            } else {
                offlineBar.classList.add('visible');
                offlineBar.removeAttribute('hidden');
            }
        }

        // Toggle download button states
        document.querySelectorAll('.action-download').forEach(btn => {
            btn.classList.toggle('offline-disabled', !AppState.isOnline);
        });
    }

    window.addEventListener('online', () => {
        updateOnlineStatus();
        showToast('✅ Back online', 'success');
    }, { passive: true });

    window.addEventListener('offline', () => {
        updateOnlineStatus();
        showToast('📴 You are offline', 'warning');
    }, { passive: true });

    // Set initial state
    updateOnlineStatus();
}

// ========== UTILITIES ==========
function generateId(bundleId, index) {
    if (bundleId) return bundleId.toLowerCase();
    // BUG FIX: Use index as fallback to prevent duplicate 'unknown' IDs
    return `unknown-${index}`;
}

function inferCategory(bundleId) {
    const bid = bundleId.toLowerCase();
    // Check 'youtubemusic' before 'youtube' to avoid mis-categorization
    if (bid.includes('youtubemusic')) return 'Music';
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

// ========== LOADING / ERROR STATES ==========
function showLoadingState() {
    const grid = document.getElementById('appGrid');
    if (!grid) return;

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

// ========== EVENT LISTENERS ==========
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

    // CRITICAL FIX #1: TrollApps URL scheme — "trollapps://add?url="
    const trollappsBtn = document.getElementById('btn-trollapps');
    if (trollappsBtn) {
        trollappsBtn.addEventListener('click', () => {
            window.location.href = `trollapps://add?url=${encodeURIComponent(CONFIG.API_ENDPOINT)}`;
        });
    }

    // CRITICAL FIX #2: SideStore URL scheme — "sidestore://source?url="
    const sidestoreBtn = document.getElementById('btn-sidestore');
    if (sidestoreBtn) {
        sidestoreBtn.addEventListener('click', () => {
            window.location.href = `sidestore://source?url=${encodeURIComponent(CONFIG.API_ENDPOINT)}`;
        });
    }

    // Install button
    const installBtn = document.getElementById('btn-install');
    if (installBtn) {
        installBtn.addEventListener('click', handleInstallClick);
    }

    const installDismiss = document.getElementById('btn-install-dismiss');
    if (installDismiss) {
        installDismiss.addEventListener('click', hideInstallBanner);
    }

    const appGrid = document.getElementById('appGrid');
    if (appGrid) {
        appGrid.addEventListener('click', handleGridClick);
        // ACCESSIBILITY FIX: Cards are now keyboard-navigable with
        // tabindex="0" and Enter/Space opens the detail modal.
        appGrid.addEventListener('keydown', handleGridKeydown);
    }

    // Close modal on Escape (document-level fallback)
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && AppState.modalOpen) {
            closeAppModal();
        }
    });
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

// ========== CLEANUP ==========
window.addEventListener('beforeunload', () => {
    if (observer) observer.disconnect();
    if (infiniteScrollObserver) infiniteScrollObserver.disconnect();
    if (swUpdateTimer) clearInterval(swUpdateTimer);

    if (AppState.toastTimer) {
        clearTimeout(AppState.toastTimer);
    }

    const searchBox = document.getElementById('searchBox');
    if (searchBox && searchBox._debounceTimer) {
        clearTimeout(searchBox._debounceTimer);
    }
});
