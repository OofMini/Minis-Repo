// ============================================================
// Mini's IPA Repo — GitHub Download Tracker  v3.0
//
// Architecture:
//   • GitHub Releases API  → global source of truth
//   • localStorage (2-min TTL) → fast cross-session cache
//   • BroadcastChannel → real-time cross-tab live updates
//   • Optimistic +1 → instant feedback on download click
//   • Re-fetch 45 s after download → show real GitHub count
//   • 5-minute polling → keep numbers fresh for long sessions
//
// Public API:
//   GH_DOWNLOADS.init(apps)            — call once on page load
//   GH_DOWNLOADS.recordDownload(bundleId) — call on every download
//   GH_DOWNLOADS.injectModalBadge(counts, app) — inject into open modal
//   GH_DOWNLOADS.formatCount(n)        — format number for display
// ============================================================

const GH_DOWNLOADS = (() => {
    // ── CONSTANTS ───────────────────────────────────────────
    const API_BASE          = 'https://api.github.com';
    const CACHE_KEY         = 'gh_dl_cache_v3';           // bumped from v2 — old caches auto-expire
    const CACHE_TTL_MS      = 2 * 60 * 1000;              // 2 minutes (was 30 — too stale)
    const FETCH_TIMEOUT_MS  = 8000;
    const POLL_INTERVAL_MS  = 5 * 60 * 1000;             // re-fetch every 5 minutes
    const POST_DL_DELAY_MS  = 45 * 1000;                  // re-fetch 45 s after a download

    // ── LIVE STATE ──────────────────────────────────────────
    let _counts    = new Map();   // bundleId → download count
    let _apps      = [];          // apps array reference
    let _pollTimer = null;
    let _postDlTimer = null;
    let _gridObserver = null;
    let _pendingInit  = false;

    // ── BROADCASTCHANNEL (cross-tab live updates) ───────────
    let _channel = null;
    try {
        _channel = new BroadcastChannel('gh-downloads-v3');
        _channel.onmessage = (e) => {
            if (!e.data) return;

            if (e.data.type === 'counts-update') {
                // Merge: take the max of each count (prevents rollback from stale tabs)
                const incoming = new Map(Object.entries(e.data.counts || {}));
                let changed = false;
                for (const [bundleId, count] of incoming) {
                    const current = _counts.get(bundleId) ?? -1;
                    if (count > current) {
                        _counts.set(bundleId, count);
                        changed = true;
                    }
                }
                if (changed && _apps.length > 0) {
                    _injectBadges(_counts, _apps);
                    _injectFeaturedBadge(_counts, _apps);
                    window.__ghDownloadCounts = _counts;
                }
            }

            if (e.data.type === 'optimistic-increment') {
                const { bundleId } = e.data;
                if (!bundleId) return;
                const current = _counts.get(bundleId) ?? 0;
                _counts.set(bundleId, current + 1);
                window.__ghDownloadCounts = _counts;
                if (_apps.length > 0) {
                    _injectBadges(_counts, _apps);
                    _injectFeaturedBadge(_counts, _apps);
                }
            }
        };
    } catch {
        // Safari private mode or older browsers — degrade gracefully
        _channel = null;
    }

    function _broadcast(message) {
        if (!_channel) return;
        try { _channel.postMessage(message); } catch { /* ignore */ }
    }

    // ── LOCALSTORAGE CACHE ───────────────────────────────────
    function _readCache() {
        try {
            const raw = localStorage.getItem(CACHE_KEY);
            if (!raw) return null;
            const parsed = JSON.parse(raw);
            if (!parsed || typeof parsed.ts !== 'number') return null;
            if (Date.now() - parsed.ts > CACHE_TTL_MS) return null;
            return parsed.data;           // { [bundleId]: count }
        } catch {
            return null;
        }
    }

    function _writeCache(dataObj) {
        try {
            localStorage.setItem(CACHE_KEY, JSON.stringify({
                ts: Date.now(),
                data: dataObj
            }));
        } catch { /* storage full or unavailable */ }
    }

    function _invalidateCache() {
        try { localStorage.removeItem(CACHE_KEY); } catch { /* ignore */ }
    }

    // ── REPO DERIVATION ─────────────────────────────────────
    function _deriveRepoInfo(downloadUrl) {
        if (!downloadUrl) return null;
        const match = downloadUrl.match(
            /github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/releases\/download\/[^/]+\/([^/?#]+\.ipa)$/i
        );
        if (!match) return null;
        const repo     = match[1];
        const filename = match[2];
        const noExt    = filename.replace(/\.ipa$/i, '');
        const baseName = noExt.replace(/[_-]\d[\w.+-]*$/, '');
        return { repo, baseName };
    }

    function _assetMatches(assetName, baseName) {
        const lower = assetName.toLowerCase();
        return lower.endsWith('.ipa') && lower.startsWith(baseName.toLowerCase());
    }

    // ── FETCH HELPERS ────────────────────────────────────────
    async function _fetchWithTimeout(url) {
        const controller = new AbortController();
        const id = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
        try {
            const res = await fetch(url, {
                signal: controller.signal,
                headers: { Accept: 'application/vnd.github+json' }
            });
            return res;
        } finally {
            clearTimeout(id);
        }
    }

    async function _fetchAllReleases(repo) {
        let url      = `${API_BASE}/repos/${repo}/releases?per_page=100`;
        let releases = [];

        while (url) {
            const res = await _fetchWithTimeout(url);

            if (res.status === 403 || res.status === 429) {
                const reset     = res.headers.get('X-RateLimit-Reset');
                const resetTime = reset
                    ? new Date(parseInt(reset, 10) * 1000).toLocaleTimeString()
                    : 'soon';
                throw new Error(`rate_limited:${resetTime}`);
            }
            if (!res.ok) throw new Error(`http_${res.status}`);

            const page = await res.json();
            releases   = releases.concat(page);

            const link = res.headers.get('Link') || '';
            const next = link.match(/<([^>]+)>;\s*rel="next"/);
            url = next ? next[1] : null;
        }

        return releases;
    }

    function _sumDownloads(releases, baseName) {
        let total = 0;
        for (const release of releases) {
            if (!Array.isArray(release.assets)) continue;
            for (const asset of release.assets) {
                if (_assetMatches(asset.name, baseName)) {
                    total += asset.download_count ?? 0;
                }
            }
        }
        return total;
    }

    // ── CORE FETCH ALL DOWNLOADS ─────────────────────────────
    async function _fetchAllDownloads(apps, forceRefresh = false) {
        // Return cache if fresh (and not a forced post-download refresh)
        if (!forceRefresh) {
            const cached = _readCache();
            if (cached) {
                const map = new Map(Object.entries(cached));
                return map;
            }
        }

        // Build repo → [{bundleId, baseName}] map, deduplicating repos
        const repoMap = new Map();
        for (const app of apps) {
            const info = _deriveRepoInfo(app.downloadUrl);
            if (!info) {
                console.warn(`[GH Downloads] Cannot derive repo from: ${app.downloadUrl}`);
                continue;
            }
            if (!repoMap.has(info.repo)) repoMap.set(info.repo, []);
            repoMap.get(info.repo).push({ bundleId: app.bundleId, baseName: info.baseName });
        }

        if (repoMap.size === 0) return new Map();

        const repos   = [...repoMap.keys()];
        const results = await Promise.allSettled(repos.map(repo => _fetchAllReleases(repo)));

        const counts         = {};
        let rateLimitedUntil = null;

        repos.forEach((repo, i) => {
            const result      = results[i];
            const appsForRepo = repoMap.get(repo);

            if (result.status === 'rejected') {
                const msg = result.reason?.message ?? '';
                if (msg.startsWith('rate_limited:')) {
                    rateLimitedUntil = msg.replace('rate_limited:', '');
                }
                console.warn(`[GH Downloads] ${repo} failed: ${msg}`);
                appsForRepo.forEach(({ bundleId }) => { counts[bundleId] = null; });
                return;
            }

            const releases      = result.value;
            const allAssetNames = [...new Set(
                releases.flatMap(r => (r.assets || []).map(a => a.name))
            )];
            console.log(`[GH Downloads] ${repo} — ${releases.length} releases, assets: ${allAssetNames.join(', ') || '(none)'}`);

            appsForRepo.forEach(({ bundleId, baseName }) => {
                const count         = _sumDownloads(releases, baseName);
                counts[bundleId]    = count;
                console.log(`[GH Downloads] ${bundleId} baseName="${baseName}" → ${count} downloads`);
            });
        });

        if (rateLimitedUntil) {
            console.warn(`[GH Downloads] Rate limit hit. Resets at ${rateLimitedUntil}.`);
        }

        _writeCache(counts);
        return new Map(Object.entries(counts));
    }

    // ── FORMATTING ────────────────────────────────────────────
    function formatCount(n) {
        if (n === null || n === undefined || n < 0) return null;
        if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
        if (n >= 1_000)     return `${(n / 1_000).toFixed(1)}K`;
        return n.toLocaleString();
    }

    // ── DOM: BADGE BUILDER ────────────────────────────────────
    function _buildCardBadge(count) {
        const formatted = formatCount(count);
        if (!formatted) return null;

        const badge = document.createElement('div');
        badge.className = 'gh-download-badge';
        badge.setAttribute('aria-label', `${count.toLocaleString()} total downloads`);
        badge.setAttribute('title', `${count.toLocaleString()} downloads tracked via GitHub Releases`);
        badge.innerHTML = `<span class="gh-dl-icon" aria-hidden="true">⬇</span><span class="gh-dl-count">${formatted}</span>`;
        return badge;
    }

    function _updateBadgeText(badge, count) {
        const formatted = formatCount(count);
        if (!formatted) return;
        const countEl = badge.querySelector('.gh-dl-count');
        if (countEl) countEl.textContent = formatted;
        badge.setAttribute('aria-label', `${count.toLocaleString()} total downloads`);
        badge.setAttribute('title', `${count.toLocaleString()} downloads tracked via GitHub Releases`);
    }

    // ── DOM: INJECT / UPDATE CARD BADGES ─────────────────────
    function _applyToCard(card, counts, idToBundleId) {
        const appId    = card.getAttribute('data-app-id');
        if (!appId) return;

        const bundleId = idToBundleId.get(appId);
        if (!bundleId) return;

        const count = counts.get(bundleId);
        if (count === null || count === undefined) return;

        const existing = card.querySelector('.gh-download-badge');

        if (existing) {
            // Live update in place — no DOM thrash, no animation replay
            _updateBadgeText(existing, count);
            return;
        }

        const badge = _buildCardBadge(count);
        if (!badge) return;

        const statusEl = card.querySelector('.app-status');
        if (statusEl?.nextSibling) {
            statusEl.parentNode.insertBefore(badge, statusEl.nextSibling);
        } else {
            const content = card.querySelector('.app-card-content');
            if (content) content.prepend(badge);
        }
    }

    function _injectBadges(counts, apps) {
        const idToBundleId = new Map(apps.map(a => [a.id, a.bundleId]));
        document.querySelectorAll('.app-card').forEach(card => {
            _applyToCard(card, counts, idToBundleId);
        });
    }

    // ── DOM: FEATURED BADGE ───────────────────────────────────
    function _injectFeaturedBadge(counts, apps) {
        const featuredCard = document.getElementById('featuredCard');
        if (!featuredCard) return;

        const appId = featuredCard.getAttribute('data-app-id');
        if (!appId) return;

        const app = apps.find(a => a.id === appId);
        if (!app) return;

        const count = counts.get(app.bundleId);
        if (count === null || count === undefined) return;

        const existing = featuredCard.querySelector('.gh-download-badge--featured');
        if (existing) {
            // Live update
            const countEl = existing.querySelector('.gh-dl-count');
            if (countEl) countEl.textContent = formatCount(count);
            return;
        }

        const badge = document.createElement('div');
        badge.className = 'gh-download-badge gh-download-badge--featured';
        badge.setAttribute('aria-label', `${count.toLocaleString()} total downloads`);
        badge.innerHTML = `<span class="gh-dl-icon" aria-hidden="true">⬇</span><span class="gh-dl-count">${formatCount(count)}</span><span class="gh-dl-label"> downloads</span>`;

        const devEl = document.getElementById('featuredDev');
        if (devEl?.parentNode) {
            devEl.parentNode.insertBefore(badge, devEl.nextSibling);
        }
    }

    // ── DOM: MODAL BADGE ──────────────────────────────────────
    function injectModalBadge(counts, app) {
        const modal = document.getElementById('appModal');
        if (!modal) return;

        const count = counts.get(app.bundleId);
        if (count === null || count === undefined) return;

        const existing = modal.querySelector('.gh-download-badge--modal');
        if (existing) {
            existing.textContent = `${formatCount(count)} downloads`;
            existing.title = `${count.toLocaleString()} downloads tracked via GitHub Releases`;
            return;
        }

        const badge = document.createElement('span');
        badge.className = 'modal-meta-item gh-download-badge--modal';
        badge.textContent = `${formatCount(count)} downloads`;
        badge.setAttribute('title', `${count.toLocaleString()} downloads tracked via GitHub Releases`);

        const metaEl = modal.querySelector('.modal-meta');
        if (metaEl) {
            const sep = document.createElement('span');
            sep.className = 'modal-meta-sep';
            sep.setAttribute('aria-hidden', 'true');
            sep.textContent = '•';
            metaEl.appendChild(sep);
            metaEl.appendChild(badge);
        }
    }

    // ── INFINITE-SCROLL OBSERVER ──────────────────────────────
    function _watchGrid(counts, apps) {
        const grid = document.getElementById('appGrid');
        if (!grid) return;

        if (_gridObserver) _gridObserver.disconnect();

        const idToBundleId = new Map(apps.map(a => [a.id, a.bundleId]));

        _gridObserver = new MutationObserver(mutations => {
            for (const mutation of mutations) {
                for (const node of mutation.addedNodes) {
                    if (node.nodeType !== 1) continue;
                    if (node.classList?.contains('app-card')) {
                        _applyToCard(node, counts, idToBundleId);
                    } else {
                        node.querySelectorAll?.('.app-card').forEach(card => {
                            _applyToCard(card, counts, idToBundleId);
                        });
                    }
                }
            }
        });

        _gridObserver.observe(grid, { childList: true, subtree: true });
    }

    // ── POLLING ───────────────────────────────────────────────
    function _startPolling() {
        if (_pollTimer) clearInterval(_pollTimer);

        _pollTimer = setInterval(async () => {
            if (!_apps.length) return;
            try {
                console.log('[GH Downloads] Polling for fresh counts...');
                _invalidateCache();
                const fresh = await _fetchAllDownloads(_apps, true);

                // Merge: take max to avoid rolling back optimistic increments
                for (const [bundleId, count] of fresh) {
                    if (count !== null && (count > (_counts.get(bundleId) ?? -1))) {
                        _counts.set(bundleId, count);
                    }
                }

                window.__ghDownloadCounts = _counts;
                _injectBadges(_counts, _apps);
                _injectFeaturedBadge(_counts, _apps);

                // Update open modal if present
                const modal = document.getElementById('appModal');
                if (modal) {
                    const appId    = modal.querySelector('.modal-download-btn')?.getAttribute('data-id');
                    const openApp  = _apps.find(a => a.id === appId);
                    if (openApp) injectModalBadge(_counts, openApp);
                }

                _broadcast({ type: 'counts-update', counts: Object.fromEntries(_counts) });

                // Rewrite cache with merged values
                _writeCache(Object.fromEntries(_counts));
            } catch (err) {
                console.warn('[GH Downloads] Poll failed:', err.message);
            }
        }, POLL_INTERVAL_MS);
    }

    // ── PUBLIC: recordDownload ────────────────────────────────
    // Called by app.js every time a user triggers a download.
    // 1. Optimistically increments the local count immediately.
    // 2. Broadcasts the increment to all other open tabs.
    // 3. Schedules a real GitHub re-fetch after POST_DL_DELAY_MS (45 s).
    function recordDownload(bundleId) {
        if (!bundleId) return;

        // 1 — Optimistic local increment
        const current = _counts.get(bundleId) ?? 0;
        _counts.set(bundleId, current + 1);
        window.__ghDownloadCounts = _counts;

        if (_apps.length > 0) {
            _injectBadges(_counts, _apps);
            _injectFeaturedBadge(_counts, _apps);

            // Update modal if it's open for this app
            const modal = document.getElementById('appModal');
            if (modal) {
                const app = _apps.find(a => a.bundleId === bundleId);
                if (app) injectModalBadge(_counts, app);
            }
        }

        // 2 — Broadcast optimistic increment to other tabs
        _broadcast({ type: 'optimistic-increment', bundleId });

        // 3 — Schedule a real re-fetch so the GitHub-confirmed count appears soon
        if (_postDlTimer) clearTimeout(_postDlTimer);
        _postDlTimer = setTimeout(async () => {
            if (!_apps.length) return;
            try {
                console.log('[GH Downloads] Post-download re-fetch...');
                _invalidateCache();
                const fresh = await _fetchAllDownloads(_apps, true);

                // Merge using max (our optimistic may already be higher)
                for (const [bid, count] of fresh) {
                    if (count !== null && count > (_counts.get(bid) ?? -1)) {
                        _counts.set(bid, count);
                    }
                }

                window.__ghDownloadCounts = _counts;
                _injectBadges(_counts, _apps);
                _injectFeaturedBadge(_counts, _apps);

                const modal = document.getElementById('appModal');
                if (modal) {
                    const appId   = modal.querySelector('.modal-download-btn')?.getAttribute('data-id');
                    const openApp = _apps.find(a => a.id === appId);
                    if (openApp) injectModalBadge(_counts, openApp);
                }

                _writeCache(Object.fromEntries(_counts));
                _broadcast({ type: 'counts-update', counts: Object.fromEntries(_counts) });
            } catch (err) {
                console.warn('[GH Downloads] Post-download fetch failed:', err.message);
            }
        }, POST_DL_DELAY_MS);
    }

    // ── PUBLIC: init ──────────────────────────────────────────
    async function init(apps) {
        if (!apps?.length) return;
        if (_pendingInit) return;          // guard against double-init
        _pendingInit = true;

        _apps = apps;

        try {
            const counts = await _fetchAllDownloads(apps);

            // Merge: take max against any optimistic increments already in memory
            for (const [bundleId, count] of counts) {
                if (count !== null && count > (_counts.get(bundleId) ?? -1)) {
                    _counts.set(bundleId, count);
                }
            }

            window.__ghDownloadCounts = _counts;
            _injectBadges(_counts, apps);
            _injectFeaturedBadge(_counts, apps);
            _watchGrid(_counts, apps);
            _startPolling();

            // Broadcast initial counts to any already-open tabs
            _broadcast({ type: 'counts-update', counts: Object.fromEntries(_counts) });
        } catch (err) {
            console.warn('[GH Downloads] Init failed:', err.message);
        } finally {
            _pendingInit = false;
        }
    }

    // ── CLEANUP (called on page unload by app.js) ─────────────
    function destroy() {
        if (_pollTimer)   { clearInterval(_pollTimer);  _pollTimer   = null; }
        if (_postDlTimer) { clearTimeout(_postDlTimer); _postDlTimer = null; }
        if (_gridObserver){ _gridObserver.disconnect(); _gridObserver = null; }
        if (_channel)     { try { _channel.close(); } catch {} _channel = null; }
    }

    return { init, recordDownload, injectModalBadge, formatCount, destroy };
})();

window.GH_DOWNLOADS = GH_DOWNLOADS;
