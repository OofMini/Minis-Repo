// ========== CONFIGURATION ==========
const CONFIG = {
    SEARCH_DEBOUNCE: 250,
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
    SW_UPDATE_INTERVAL: 30 * 60 * 1000,
    FEATURED_BUNDLE_ID: 'com.spotify.client'
};

const AppState = {
    apps: [],
    filteredApps: [],
    renderedIds: new Set(),
    searchTerm: '',
    activeCategory: 'all',
    sortMode: 'recent',
    isLoading: true,
    toastTimer: null,
    isOnline: navigator.onLine,
    deferredInstallPrompt: null,
    modalOpen: false,
    modalScrollY: 0,
    lastOpenedCardId: null,
    modalHistoryPushed: false,
    // Render generation counter — prevents stale idle-callback closures from
    // writing into a freshly-cleared grid when the user types quickly.
    _renderGen: 0
};

const AppCardTemplate = document.createElement('template');
AppCardTemplate.innerHTML = `
    <article class="app-card fade-in" role="article" tabindex="0">
        <div class="app-icon-container">
            <img class="app-icon" loading="lazy" decoding="async" width="72" height="72">
        </div>
        <div class="app-status"></div>
        <div class="app-card-content">
            <h3></h3>
            <p class="app-category-wrapper"><span class="app-category-tag"></span></p>
            <div class="app-description-text"></div>
            <button type="button" class="changelog-toggle" aria-expanded="false" style="display:none;">
                <span>What's New</span>
                <span class="changelog-toggle-arrow" aria-hidden="true">▶</span>
            </button>
            <div class="changelog-content">
                <div class="changelog-text"></div>
            </div>
            <p class="app-meta-size"></p>
            <button type="button" class="download-btn action-download"></button>
        </div>
    </article>
`;

const _escapeDiv = document.createElement('div');

let observer = null;
let infiniteScrollObserver = null;
let scrollTopObserver = null;
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
        setupScrollToTop();
        showLoadingState();

        AppState.apps = await loadAppData();
        AppState.isLoading = false;

        if (AppState.apps.length === 0) {
            showErrorState('No apps available in this repository');
        } else {
            updateAppCount(AppState.apps.length);
            setupFeaturedApp();
            updateCategoryPillCounts();
            const appGrid = document.getElementById('appGrid');
            if (appGrid) appGrid.innerHTML = '';
            AppState.renderedIds.clear();
            filterAndSortApps();
            setupInfiniteScroll();
            handleHashRoute();

            // Kick off GitHub download count fetching (non-blocking)
            if (window.GH_DOWNLOADS) {
                GH_DOWNLOADS.init(AppState.apps);
            }
        }
    } catch (error) {
        console.error('Initialization error:', error);
        handleError(error);
        showErrorState(error.message ?? 'Failed to initialize application');
    }
});

// ========== DATA LOADING ==========
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
                const minimumOS = latestVersion.minOSVersion ?? '15.0';
                const changelog = latestVersion.localizedDescription ?? '';
                const permissions = normalizePermissions(app.permissions ?? []);

                return {
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
                    changelog: changelog,
                    tintColor: sanitizeTintColor(app.tintColor),
                    subtitle: app.subtitle ?? '',
                    minimumOS: minimumOS,
                    permissions: permissions,
                    screenshots: app.screenshotURLs ?? [],
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

function normalizePermissions(perms) {
    if (!Array.isArray(perms)) return [];
    return perms.map(p => {
        if (typeof p === 'string') return { type: p, usageDescription: '' };
        if (typeof p === 'object' && p !== null && p.type) {
            return { type: p.type, usageDescription: p.usageDescription ?? '' };
        }
        return null;
    }).filter(Boolean);
}

// ========== APP COUNT ==========
function updateAppCount(count) {
    const el = document.getElementById('appCountText');
    if (el) el.textContent = `${count} Apps`;
}

// ========== CATEGORY PILL COUNTS ==========
function updateCategoryPillCounts() {
    const counts = { all: AppState.apps.length };
    AppState.apps.forEach(app => {
        counts[app.category] = (counts[app.category] || 0) + 1;
    });

    const pills = document.querySelectorAll('.category-pill');
    pills.forEach(pill => {
        const cat = pill.getAttribute('data-category');
        const count = counts[cat];
        if (count === undefined) return;

        if (!pill.querySelector('.category-count')) {
            const badge = document.createElement('span');
            badge.className = 'category-count';
            badge.textContent = count;
            badge.setAttribute('aria-hidden', 'true');
            pill.appendChild(badge);
        }
    });
}

// ========== FEATURED APP ==========
function setupFeaturedApp() {
    const app = AppState.apps.find(a => a.bundleId === CONFIG.FEATURED_BUNDLE_ID);
    if (!app) return;

    const section = document.getElementById('featuredSection');
    const card = document.getElementById('featuredCard');
    const icon = document.getElementById('featuredIcon');
    const name = document.getElementById('featuredName');
    const dev = document.getElementById('featuredDev');
    const desc = document.getElementById('featuredDesc');
    const btn = document.getElementById('featuredDownloadBtn');

    if (!section || !card) return;

    icon.src = app.icon;
    icon.alt = `${app.name} icon`;
    icon.onerror = () => { icon.src = CONFIG.FALLBACK_ICON; };
    name.textContent = app.name;
    dev.textContent = app.developer;
    desc.textContent = app.description;
    btn.setAttribute('data-id', app.id);
    btn.setAttribute('aria-label', `Download ${app.name} IPA`);
    card.setAttribute('data-app-id', app.id);
    card.setAttribute('aria-label', `${app.name} — featured app, tap to view details`);

    section.removeAttribute('hidden');
    section.classList.add('visible');

    card.addEventListener('click', (e) => {
        if (!e.target.closest('button')) openAppModal(app.id);
    });
    card.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            openAppModal(app.id);
        }
    });

    btn.addEventListener('click', (e) => {
        e.stopPropagation();
        trackDownload(app.id);
    });
}

// ========== FILTERING & SORTING ==========
function filterAndSortApps() {
    // Increment render generation BEFORE clearing the grid so any pending
    // idle callbacks from the previous filter run will abort when they check.
    AppState._renderGen++;

    AppState.filteredApps = AppState.apps.filter(app => {
        const matchesSearch = !AppState.searchTerm || app.searchString.includes(AppState.searchTerm);
        const matchesCategory = AppState.activeCategory === 'all' || app.category === AppState.activeCategory;
        return matchesSearch && matchesCategory;
    });

    if (AppState.sortMode === 'alpha') {
        AppState.filteredApps.sort((a, b) => a.name.localeCompare(b.name));
    } else {
        AppState.filteredApps.sort((a, b) => {
            if (b.date > a.date) return 1;
            if (b.date < a.date) return -1;
            return 0;
        });
    }

    const appGrid = document.getElementById('appGrid');
    if (appGrid) {
        appGrid.innerHTML = '';
        appGrid.setAttribute('aria-busy', 'true');
    }

    AppState.renderedIds.clear();

    // Render first batch synchronously to eliminate the flash-of-empty-grid.
    // Subsequent batches are deferred to idle time via updateGrid().
    if (AppState.filteredApps.length > 0 && appGrid) {
        const firstBatch = AppState.filteredApps.slice(0, CONFIG.BATCH_SIZE);
        renderBatch(firstBatch, appGrid);
    } else if (appGrid) {
        handleEmptyState(appGrid);
        appGrid.removeAttribute('aria-busy');
    }

    // Schedule any remaining batches and re-arm the infinite scroll observer.
    updateGrid();
    announceResultsCount();

    const sentinel = document.getElementById('scroll-sentinel');
    if (infiniteScrollObserver && sentinel) {
        infiniteScrollObserver.observe(sentinel);
    }
}

function announceResultsCount() {
    const countEl = document.getElementById('searchResultsCount');
    if (!countEl) return;

    const total = AppState.filteredApps.length;
    if (!AppState.searchTerm && AppState.activeCategory === 'all') {
        countEl.textContent = `Showing all ${total} apps`;
    } else if (total === 0) {
        countEl.textContent = 'No apps found';
    } else {
        countEl.textContent = `Found ${total} app${total !== 1 ? 's' : ''}`;
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

    // Capture the generation at call time. The idle callback checks this before
    // rendering so stale closures abort silently instead of corrupting a freshly-
    // cleared grid.
    const capturedGen = AppState._renderGen;

    const doRender = () => {
        if (capturedGen !== AppState._renderGen) return; // stale — abort
        renderBatch(nextBatch, appGrid);
        if (AppState.renderedIds.size >= AppState.filteredApps.length) {
            appGrid.removeAttribute('aria-busy');
        }
    };

    if ('requestIdleCallback' in window) {
        requestIdleCallback(doRender, { timeout: 300 });
    } else {
        setTimeout(doRender, 0);
    }
}

// FIX: renderBatch now collects newly created article elements BEFORE appending
// the fragment to the container, then observes only those new elements.
function renderBatch(batch, container) {
    if (!document.contains(container)) return;

    const fragment = document.createDocumentFragment();
    const newArticles = [];
    let addedCount = 0;

    batch.forEach(app => {
        if (!AppState.renderedIds.has(app.id)) {
            const actualIndex = AppState.renderedIds.size;
            const cardFrag = createAppCard(app, actualIndex);
            const article = cardFrag.querySelector('article');
            if (article) newArticles.push(article);
            fragment.appendChild(cardFrag);
            AppState.renderedIds.add(app.id);
            addedCount++;
        }
    });

    if (addedCount > 0) {
        container.appendChild(fragment);
        if (observer) {
            newArticles.forEach(el => observer.observe(el));
        }
    }

    if (AppState.renderedIds.size >= AppState.filteredApps.length) {
        if (infiniteScrollObserver) infiniteScrollObserver.disconnect();
    }

    handleEmptyState(container);
}

function handleEmptyState(container) {
    const noResultsEl = container.querySelector('.no-results');
    if (AppState.filteredApps.length === 0 && !noResultsEl) {
        container.innerHTML = `<div class="fade-in no-results visible"><h3>No apps found</h3><p>Try a different search or category</p></div>`;
        container.removeAttribute('aria-busy');
    } else if (AppState.filteredApps.length > 0 && noResultsEl) {
        noResultsEl.remove();
    }
}

// ========== CARD CREATION ==========
function createAppCard(app, index) {
    const cardFragment = document.importNode(AppCardTemplate.content, true);
    const article = cardFragment.querySelector('article');

    article.setAttribute('data-app-id', app.id);
    article.setAttribute('aria-label', `${app.name} — tap to view details`);
    article.classList.add(`stagger-${(index % 3) + 1}`);

    const tint = app.tintColor;
    article.style.setProperty('--tint', tint);
    article.style.setProperty('--tint-surface', hexToRgba(tint, 0.06));
    article.style.setProperty('--tint-border', hexToRgba(tint, 0.15));

    const img = article.querySelector('.app-icon');
    img.src = app.icon;
    img.alt = `${app.name} icon`;
    img.onerror = () => { img.src = CONFIG.FALLBACK_ICON; };

    article.querySelector('.app-status').textContent = `✅ Working · v${app.version}`;
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

    if (app.changelog) {
        const toggleBtn = article.querySelector('.changelog-toggle');
        toggleBtn.style.display = '';
        toggleBtn.setAttribute('data-app-id', app.id);
        article.querySelector('.changelog-text').textContent = app.changelog;
    }

    article.querySelector('.app-meta-size').textContent = `Size: ${app.size}`;

    const btn = article.querySelector('.download-btn');
    btn.setAttribute('data-id', app.id);
    btn.setAttribute('aria-label', `Download ${app.name} IPA`);
    btn.textContent = '⬇️ Download IPA';

    if (!AppState.isOnline) {
        btn.classList.add('offline-disabled');
    }

    return cardFragment;
}

// ========== INFINITE SCROLL ==========
function setupInfiniteScroll() {
    const sentinel = document.getElementById('scroll-sentinel');
    if (!sentinel) return;

    infiniteScrollObserver = new IntersectionObserver(
        entries => {
            if (entries[0].isIntersecting) updateGrid();
        },
        { rootMargin: '300px' }
    );

    infiniteScrollObserver.observe(sentinel);
}

// ========== SCROLL-TO-TOP ==========
function setupScrollToTop() {
    const btn = document.getElementById('scrollTopBtn');
    if (!btn) return;

    const heroEl = document.querySelector('.hero');
    if (!heroEl) return;

    scrollTopObserver = new IntersectionObserver(
        entries => {
            const isVisible = entries[0].isIntersecting;
            btn.classList.toggle('visible', !isVisible);
            btn.setAttribute('aria-hidden', String(isVisible));
        },
        { threshold: 0 }
    );

    scrollTopObserver.observe(heroEl);

    btn.addEventListener('click', () => {
        window.scrollTo({ top: 0, behavior: 'smooth' });
    });
}

// ========== HASH ROUTING ==========
function handleHashRoute() {
    const hash = window.location.hash;
    if (hash && hash.startsWith('#app-')) {
        const bundleId = decodeURIComponent(hash.substring(5));
        const app = AppState.apps.find(a => a.bundleId === bundleId || a.id === bundleId);
        if (app) {
            setTimeout(() => openAppModal(app.id, true), 100);
        }
    }
}

function updateHash(bundleId, fromUrl) {
    if (bundleId) {
        const newHash = `#app-${encodeURIComponent(bundleId)}`;
        if (fromUrl) {
            history.replaceState({ appModal: true }, '', newHash);
            AppState.modalHistoryPushed = false;
        } else {
            history.pushState({ appModal: true }, '', newHash);
            AppState.modalHistoryPushed = true;
        }
    } else {
        history.replaceState(null, '', window.location.pathname + window.location.search);
    }
}

window.addEventListener('popstate', () => {
    if (AppState.modalOpen && !window.location.hash) {
        AppState.modalHistoryPushed = false;
        closeAppModal(true);
    } else if (window.location.hash && window.location.hash.startsWith('#app-')) {
        handleHashRoute();
    }
});

// ========== GRID CLICK / KEYBOARD HANDLER ==========
function handleGridClick(e) {
    if (e.target.classList.contains('action-download')) {
        const appId = e.target.getAttribute('data-id');
        if (appId) trackDownload(appId);
        return;
    }

    if (e.target.classList.contains('action-retry')) {
        location.reload();
        return;
    }

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

    const card = e.target.closest('.app-card');
    if (card && !e.target.closest('button') && !e.target.closest('a')) {
        const appId = card.getAttribute('data-app-id');
        if (appId) openAppModal(appId);
    }
}

function handleGridKeydown(e) {
    const card = e.target.closest('.app-card');

    if (e.key === 'Enter' || e.key === ' ') {
        if (card && e.target === card) {
            e.preventDefault();
            const appId = card.getAttribute('data-app-id');
            if (appId) openAppModal(appId);
        }
        return;
    }

    if (card && (e.key === 'ArrowRight' || e.key === 'ArrowLeft' || e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
        e.preventDefault();
        const cards = Array.from(document.querySelectorAll('.app-card'));
        const idx = cards.indexOf(card);
        if (idx === -1) return;

        const gridEl = document.getElementById('appGrid');
        let cols = 1;
        if (gridEl) {
            const style = window.getComputedStyle(gridEl);
            const templateCols = style.gridTemplateColumns;
            if (templateCols && templateCols !== 'none') {
                cols = templateCols.trim().split(/\s+/).length;
            }
        }

        let nextIdx = idx;
        switch (e.key) {
            case 'ArrowRight': nextIdx = Math.min(idx + 1, cards.length - 1); break;
            case 'ArrowLeft':  nextIdx = Math.max(idx - 1, 0); break;
            case 'ArrowDown':  nextIdx = Math.min(idx + cols, cards.length - 1); break;
            case 'ArrowUp':    nextIdx = Math.max(idx - cols, 0); break;
        }

        cards[nextIdx].focus();
    }
}

// ========== IMAGE PRELOADING ==========
function preloadModalImages(app) {
    const urls = [app.icon, ...app.screenshots].filter(Boolean);

    const existing = new Set();
    document.querySelectorAll('link[rel="preload"][as="image"]').forEach(el => {
        existing.add(el.href);
    });

    urls.forEach(url => {
        let abs;
        try {
            abs = new URL(url, window.location.href).href;
        } catch {
            return;
        }

        if (existing.has(abs)) return;

        const link = document.createElement('link');
        link.rel = 'preload';
        link.as = 'image';
        link.href = url;
        document.head.appendChild(link);
        setTimeout(() => { if (link.parentNode) link.remove(); }, 30_000);
    });
}

// ========== APP DETAIL MODAL ==========
function buildModalActionRow(app) {
    const row = document.createElement('div');
    row.className = 'modal-action-row';

    const appUrl = `${window.location.origin}${window.location.pathname}#app-${encodeURIComponent(app.bundleId)}`;

    if (navigator.share) {
        const shareBtn = document.createElement('button');
        shareBtn.type = 'button';
        shareBtn.className = 'modal-action-btn modal-share-btn';
        shareBtn.setAttribute('aria-label', `Share ${app.name}`);
        shareBtn.innerHTML = '<span aria-hidden="true">↗️</span> Share';
        shareBtn.addEventListener('click', async () => {
            try {
                await navigator.share({
                    title: `${app.name} — Mini's Repo`,
                    text: `Get ${app.name} (v${app.version}) from Mini's IPA Repo`,
                    url: appUrl
                });
            } catch (err) {
                if (err.name !== 'AbortError') {
                    showToast('⚠️ Share failed', 'warning');
                }
            }
        });
        row.appendChild(shareBtn);
    }

    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'modal-action-btn modal-copy-link-btn';
    copyBtn.setAttribute('aria-label', `Copy link to ${app.name}`);
    copyBtn.innerHTML = '<span aria-hidden="true">🔗</span> Copy Link';
    copyBtn.addEventListener('click', async () => {
        try {
            await navigator.clipboard.writeText(appUrl);
        } catch {
            try {
                const ta = document.createElement('textarea');
                ta.value = appUrl;
                ta.style.cssText = 'position:fixed;left:-9999px;opacity:0';
                document.body.appendChild(ta);
                ta.select();
                document.execCommand('copy');
                document.body.removeChild(ta);
            } catch {
                showToast('⚠️ Could not copy link', 'warning');
                return;
            }
        }
        copyBtn.innerHTML = '<span aria-hidden="true">✅</span> Copied!';
        copyBtn.classList.add('copied');
        showToast('🔗 Link copied to clipboard', 'success');
        setTimeout(() => {
            copyBtn.innerHTML = '<span aria-hidden="true">🔗</span> Copy Link';
            copyBtn.classList.remove('copied');
        }, 2000);
    });
    row.appendChild(copyBtn);

    return row;
}

function openAppModal(appId, fromUrl = false) {
    const app = AppState.apps.find(a => a.id === appId);
    if (!app) return;

    if (AppState.modalOpen) return;

    AppState.modalOpen = true;
    AppState.modalScrollY = window.scrollY;
    AppState.lastOpenedCardId = appId;

    preloadModalImages(app);

    const existing = document.getElementById('appModal');
    if (existing) existing.remove();

    updateHash(app.bundleId, fromUrl);

    const modal = document.createElement('div');
    modal.id = 'appModal';
    modal.className = 'modal-overlay';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-label', `${app.name} details`);

    const screenshotsHtml = app.screenshots.length > 0
        ? `<div class="modal-screenshots" role="region" aria-label="Screenshots">
               ${app.screenshots.map((url, i) =>
                   `<img src="${escapeAttr(url)}" alt="${escapeAttr(app.name)} screenshot ${i + 1}" loading="eager" decoding="async" class="modal-screenshot" data-screenshot-idx="${i}">`
               ).join('')}
           </div>`
        : '';

    const permissionsHtml = app.permissions.length > 0
        ? `<div class="modal-permissions">
               <span class="modal-permissions-label">Permissions:</span>
               ${app.permissions.map(p =>
                   `<span class="modal-perm-tag" title="${escapeAttr(p.usageDescription)}">${escapeHtml(p.type)}</span>`
               ).join('')}
           </div>`
        : '';

    const changelogHtml = app.changelog
        ? `<div class="modal-changelog">
               <strong>What's New</strong>
               <p>${escapeHtml(app.changelog)}</p>
           </div>`
        : '';

    modal.innerHTML = `
        <div class="modal-backdrop"></div>
        <div class="modal-content" role="document">
            <div class="modal-tint-glow" aria-hidden="true"></div>
            <button type="button" class="modal-close" aria-label="Close dialog">&times;</button>
            <div class="modal-header">
                <div class="modal-icon-container">
                    <img src="${escapeAttr(app.icon)}" alt="${escapeAttr(app.name)} icon"
                         class="modal-icon" width="88" height="88">
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
                <button type="button" class="download-btn modal-download-btn" data-id="${escapeAttr(app.id)}" aria-label="Download ${escapeAttr(app.name)} IPA">
                    ⬇️ Download IPA
                </button>
            </div>
        </div>
    `;

    document.body.appendChild(modal);

    // Apply tint glow via JS style property
    const tintGlowEl = modal.querySelector('.modal-tint-glow');
    if (tintGlowEl) {
        tintGlowEl.style.background = `linear-gradient(180deg, ${hexToRgba(app.tintColor, 0.12)} 0%, transparent 100%)`;
    }

    const modalFooter = modal.querySelector('.modal-footer');
    if (modalFooter) {
        const actionRow = buildModalActionRow(app);
        modalFooter.insertBefore(actionRow, modalFooter.firstChild);
    }

    const modalIcon = modal.querySelector('.modal-icon');
    if (modalIcon) {
        modalIcon.addEventListener('error', () => { modalIcon.src = CONFIG.FALLBACK_ICON; }, { once: true });
    }

    modal.querySelectorAll('.modal-screenshot').forEach(img => {
        img.addEventListener('error', () => { img.style.display = 'none'; }, { once: true });
    });

    document.body.classList.add('modal-open');
    document.body.style.top = `-${AppState.modalScrollY}px`;

    modal.offsetHeight; // force reflow before adding .active
    modal.classList.add('active');

    // Inject download count into modal meta row if data is already cached
    if (window.GH_DOWNLOADS && window.__ghDownloadCounts) {
        GH_DOWNLOADS.injectModalBadge(window.__ghDownloadCounts, app);
    }

    const closeBtn = modal.querySelector('.modal-close');
    closeBtn.focus();

    modal.querySelector('.modal-backdrop').addEventListener('click', () => closeAppModal(false));
    closeBtn.addEventListener('click', () => closeAppModal(false));

    modal.querySelector('.modal-download-btn').addEventListener('click', () => {
        trackDownload(app.id);
        closeAppModal(false);
    });

    modal.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            e.stopPropagation();
            closeAppModal(false);
            return;
        }

        if (e.key === 'Tab') {
            const focusable = modal.querySelectorAll(
                'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
            );
            if (focusable.length === 0) return;

            const firstEl = focusable[0];
            const lastEl = focusable[focusable.length - 1];

            if (e.shiftKey) {
                if (document.activeElement === firstEl) {
                    e.preventDefault();
                    lastEl.focus();
                }
            } else {
                if (document.activeElement === lastEl) {
                    e.preventDefault();
                    firstEl.focus();
                }
            }
        }
    });
}

function closeAppModal(viaPopstate) {
    const modal = document.getElementById('appModal');
    if (!modal) return;

    if (!AppState.modalOpen) return;
    AppState.modalOpen = false;

    modal.classList.remove('active');

    document.body.classList.remove('modal-open');
    document.body.style.top = '';
    window.scrollTo({ top: AppState.modalScrollY, behavior: 'instant' });

    if (!viaPopstate && AppState.modalHistoryPushed) {
        AppState.modalHistoryPushed = false;
        history.back();
    } else {
        AppState.modalHistoryPushed = false;
        updateHash(null, false);
    }

    const cardId = AppState.lastOpenedCardId;
    AppState.lastOpenedCardId = null;

    setTimeout(() => {
        if (modal.parentNode) modal.remove();
    }, 350);

    if (cardId) {
        const cardToFocus = document.querySelector(
            `.app-card[data-app-id="${CSS.escape(cardId)}"]`
        );
        if (cardToFocus) cardToFocus.focus({ preventScroll: true });
    }
}

// ========== HTML ESCAPING ==========
function escapeHtml(str) {
    if (!str) return '';
    _escapeDiv.textContent = str;
    return _escapeDiv.innerHTML;
}

function escapeAttr(str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

// ========== COLOR UTILITIES ==========
function sanitizeTintColor(color) {
    if (color && /^#[0-9A-Fa-f]{6}$/.test(color)) return color;
    return '#a78bfa';
}

function hexToRgba(hex, alpha) {
    if (!hex || hex.length < 7) return `rgba(167, 139, 250, ${alpha})`;
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    if (isNaN(r) || isNaN(g) || isNaN(b)) return `rgba(167, 139, 250, ${alpha})`;
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
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
        actionBtn.type = 'button';
        actionBtn.textContent = action.text;
        actionBtn.addEventListener('click', action.callback);
        toast.appendChild(actionBtn);
    }

    toast.setAttribute('aria-live', (type === 'error' || type === 'warning') ? 'assertive' : 'polite');
    toast.className = `toast ${type} show`;

    AppState.toastTimer = setTimeout(() => {
        toast.classList.remove('show');
        AppState.toastTimer = null;
    }, CONFIG.TOAST_DURATION);
}

// ========== PWA ==========
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
            if (newWorker) newWorker.postMessage({ action: 'skipWaiting' });
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
        banner.removeAttribute('hidden');
        requestAnimationFrame(() => requestAnimationFrame(() => banner.classList.add('visible')));
    }
}

function hideInstallBanner() {
    const banner = document.getElementById('installBanner');
    if (banner) {
        banner.classList.remove('visible');
        setTimeout(() => { banner.setAttribute('hidden', ''); }, 400);
    }
}

async function handleInstallClick() {
    const prompt = AppState.deferredInstallPrompt;
    if (!prompt) return;
    prompt.prompt();
    const result = await prompt.userChoice;
    if (result.outcome === 'accepted') console.log('PWA install accepted');
    AppState.deferredInstallPrompt = null;
    hideInstallBanner();
}

// ========== ONLINE / OFFLINE ==========
function setupOnlineOfflineDetection() {
    const offlineBar = document.getElementById('offlineBar');

    function updateOnlineStatus() {
        AppState.isOnline = navigator.onLine;

        if (offlineBar) {
            if (AppState.isOnline) {
                offlineBar.classList.remove('visible');
                setTimeout(() => { offlineBar.setAttribute('hidden', ''); }, 350);
            } else {
                offlineBar.removeAttribute('hidden');
                requestAnimationFrame(() => requestAnimationFrame(() => offlineBar.classList.add('visible')));
            }
        }

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

    updateOnlineStatus();
}

// ========== COPY TO CLIPBOARD ==========
async function handleCopyUrl() {
    const urlText = 'https://OofMini.github.io/Minis-Repo/mini.json';
    const btn = document.getElementById('btn-copy-url');
    const label = document.getElementById('copyUrlLabel');

    try {
        await navigator.clipboard.writeText(urlText);
        showToast('✅ Manifest URL copied', 'success');
        if (btn && label) {
            label.textContent = '✅ Copied!';
            btn.classList.add('copied');
            setTimeout(() => {
                label.textContent = '📋 Copy URL';
                btn.classList.remove('copied');
            }, 2000);
        }
    } catch {
        try {
            const textarea = document.createElement('textarea');
            textarea.value = urlText;
            textarea.setAttribute('readonly', '');
            textarea.style.cssText = 'position:fixed;left:-9999px;top:-9999px;opacity:0';
            document.body.appendChild(textarea);
            textarea.select();
            document.execCommand('copy');
            document.body.removeChild(textarea);
            showToast('✅ Manifest URL copied', 'success');
        } catch {
            showToast('⚠️ Could not copy — please select and copy manually', 'warning');
        }
    }
}

// ========== UTILITIES ==========
function generateId(bundleId, index) {
    if (bundleId) return bundleId.toLowerCase();
    return `unknown-${index}`;
}

function inferCategory(bundleId) {
    const bid = bundleId.toLowerCase();
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
    grid.innerHTML = Array(6).fill(0).map((_, i) => `
        <div class="skeleton-card fade-in visible stagger-${(i % 3) + 1}" aria-hidden="true">
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
            <button type="button" class="download-btn action-retry">Retry</button>
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
                filterAndSortApps();
            }, CONFIG.SEARCH_DEBOUNCE);
        });
    }

    document.addEventListener('keydown', (e) => {
        if (e.key === '/' && searchBox) {
            const active = document.activeElement;
            const isInput = active && (
                active.tagName === 'INPUT' ||
                active.tagName === 'TEXTAREA' ||
                active.isContentEditable
            );
            if (!isInput && !AppState.modalOpen) {
                e.preventDefault();
                searchBox.focus();
            }
        }
    });

    const categoryFilters = document.getElementById('categoryFilters');
    if (categoryFilters) {
        categoryFilters.addEventListener('click', (e) => {
            const pill = e.target.closest('.category-pill');
            if (!pill) return;

            const category = pill.getAttribute('data-category');

            if (category === AppState.activeCategory && category !== 'all') {
                AppState.activeCategory = 'all';
            } else {
                AppState.activeCategory = category;
            }

            categoryFilters.querySelectorAll('.category-pill').forEach(p => {
                const isActive = p.getAttribute('data-category') === AppState.activeCategory;
                p.classList.toggle('active', isActive);
                p.setAttribute('aria-selected', String(isActive));
                p.setAttribute('tabindex', isActive ? '0' : '-1');
            });

            filterAndSortApps();
        });

        categoryFilters.addEventListener('keydown', (e) => {
            if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
                e.preventDefault();
                const pills = Array.from(categoryFilters.querySelectorAll('.category-pill'));
                const current = pills.indexOf(document.activeElement);
                if (current === -1) return;

                let next = e.key === 'ArrowRight' ? current + 1 : current - 1;
                next = Math.max(0, Math.min(next, pills.length - 1));
                pills[next].focus();
            }
        });
    }

    const sortRecent = document.getElementById('sortRecent');
    const sortAlpha = document.getElementById('sortAlpha');

    function activateSort(mode) {
        AppState.sortMode = mode;
        if (sortRecent) {
            sortRecent.classList.toggle('active', mode === 'recent');
            sortRecent.setAttribute('aria-pressed', String(mode === 'recent'));
        }
        if (sortAlpha) {
            sortAlpha.classList.toggle('active', mode === 'alpha');
            sortAlpha.setAttribute('aria-pressed', String(mode === 'alpha'));
        }
        filterAndSortApps();
    }

    if (sortRecent) sortRecent.addEventListener('click', () => activateSort('recent'));
    if (sortAlpha) sortAlpha.addEventListener('click', () => activateSort('alpha'));

    const resetBtn = document.getElementById('btn-reset');
    if (resetBtn) {
        resetBtn.addEventListener('click', async () => {
            if (confirm('Reset all local data and cache?')) {
                try {
                    localStorage.clear();
                    sessionStorage.clear();
                    if ('caches' in window) {
                        const keys = await caches.keys();
                        await Promise.all(keys.map(key => caches.delete(key)));
                    }
                    window.location.reload();
                } catch {
                    window.location.reload();
                }
            }
        });
    }

    const trollappsBtn = document.getElementById('btn-trollapps');
    if (trollappsBtn) {
        trollappsBtn.addEventListener('click', () => {
            window.location.href = `trollapps://add?url=${encodeURIComponent(CONFIG.API_ENDPOINT)}`;
        });
    }

    const sidestoreBtn = document.getElementById('btn-sidestore');
    if (sidestoreBtn) {
        sidestoreBtn.addEventListener('click', () => {
            window.location.href = `sidestore://source?url=${encodeURIComponent(CONFIG.API_ENDPOINT)}`;
        });
    }

    const installBtn = document.getElementById('btn-install');
    if (installBtn) installBtn.addEventListener('click', handleInstallClick);

    const installDismiss = document.getElementById('btn-install-dismiss');
    if (installDismiss) installDismiss.addEventListener('click', hideInstallBanner);

    const copyUrlBtn = document.getElementById('btn-copy-url');
    if (copyUrlBtn) copyUrlBtn.addEventListener('click', handleCopyUrl);

    const appGrid = document.getElementById('appGrid');
    if (appGrid) {
        appGrid.addEventListener('click', handleGridClick);
        appGrid.addEventListener('keydown', handleGridKeydown);
    }

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && AppState.modalOpen) {
            closeAppModal(false);
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
                }
            });
        }, { threshold: 0.05 });
        document.querySelectorAll('.fade-in').forEach(el => observer.observe(el));
    } else {
        document.querySelectorAll('.fade-in').forEach(el => el.classList.add('visible'));
    }
}

// ========== CLEANUP ==========
window.addEventListener('beforeunload', () => {
    if (observer) observer.disconnect();
    if (infiniteScrollObserver) infiniteScrollObserver.disconnect();
    if (scrollTopObserver) scrollTopObserver.disconnect();
    if (swUpdateTimer) clearInterval(swUpdateTimer);
    if (AppState.toastTimer) clearTimeout(AppState.toastTimer);

    const searchBox = document.getElementById('searchBox');
    if (searchBox && searchBox._debounceTimer) clearTimeout(searchBox._debounceTimer);
});
