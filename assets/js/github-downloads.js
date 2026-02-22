// ============================================================
// Mini's IPA Repo — GitHub Download Tracker
// Fetches real, persistent download counts from GitHub's
// release asset API. Counts survive page refreshes, app
// updates, and downloads from any source (web, TrollApps,
// SideStore, direct link, etc.).
//
// API: GET /repos/{owner}/{repo}/releases
// Docs: https://docs.github.com/en/rest/releases/releases
// Rate limit: 60 req/hr (unauthenticated) — we use 5 calls max.
// ============================================================

const GH_DOWNLOADS = (() => {
    // ── CONFIG ──────────────────────────────────────────────
    const API_BASE = 'https://api.github.com';
    const CACHE_KEY = 'gh_downloads_cache';
    const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes
    const FETCH_TIMEOUT_MS = 8000;

    // Maps each app's bundleIdentifier → { repo, assetPattern }
    // assetPattern: regex matched against GitHub asset filenames
    // to find the correct .ipa within a repo that hosts multiple
    // apps (e.g., Minis-Heap).
    const BUNDLE_MAP = {
        'com.spotify.client': {
            repo: 'OofMini/eeveespotifyreborn',
            assetPattern: /EeveeSpotify\.ipa$/i
        },
        'com.google.ios.youtube': {
            repo: 'OofMini/YTLite',
            assetPattern: /YouTubePlus.*\.ipa$/i
        },
        'com.google.ios.youtubemusic': {
            repo: 'OofMini/YTMusicUltimate',
            assetPattern: /YTMusicUltimate\.ipa$/i
        },
        'com.atebits.Tweetie2': {
            repo: 'OofMini/tweak',
            assetPattern: /NeoFreeBird.*\.ipa$/i
        },
        'com.camerasideas.InstaShot': {
            repo: 'OofMini/Minis-Heap',
            assetPattern: /InShot\.ipa$/i
        },
        'org.xitrix.iTorrent2': {
            repo: 'OofMini/Minis-Heap',
            assetPattern: /iTorrent\.ipa$/i
        },
        'com.kdt.livecontainer': {
            repo: 'OofMini/Minis-Heap',
            assetPattern: /LiveContainer\.ipa$/i
        },
        'com.neocortext.doublicatapp': {
            repo: 'OofMini/Minis-Heap',
            assetPattern: /Reface\.ipa$/i
        }
    };

    // ── CACHE ────────────────────────────────────────────────
    function readCache() {
        try {
            const raw = sessionStorage.getItem(CACHE_KEY);
            if (!raw) return null;
            const parsed = JSON.parse(raw);
            if (!parsed || typeof parsed.ts !== 'number') return null;
            if (Date.now() - parsed.ts > CACHE_TTL_MS) return null;
            return parsed.data; // { [bundleId]: number }
        } catch {
            return null;
        }
    }

    function writeCache(data) {
        try {
            sessionStorage.setItem(CACHE_KEY, JSON.stringify({ ts: Date.now(), data }));
        } catch {
            // sessionStorage may be unavailable in some contexts (private mode quotas, etc.)
        }
    }

    // ── FETCH ────────────────────────────────────────────────
    async function fetchWithTimeout(url) {
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

    // Fetch ALL releases for a repo (handles pagination via Link header).
    // Sums download_count across EVERY release so the total reflects
    // historical downloads, not just the latest release.
    async function fetchRepoDownloads(repo) {
        let url = `${API_BASE}/repos/${repo}/releases?per_page=100`;
        let releases = [];

        // Follow pagination (GitHub returns up to 100 per page)
        while (url) {
            const res = await fetchWithTimeout(url);

            // Surface rate-limit state so callers can handle it gracefully
            if (res.status === 403 || res.status === 429) {
                const reset = res.headers.get('X-RateLimit-Reset');
                const resetTime = reset ? new Date(parseInt(reset, 10) * 1000).toLocaleTimeString() : 'soon';
                throw new Error(`rate_limited:${resetTime}`);
            }

            if (!res.ok) throw new Error(`http_${res.status}`);

            const page = await res.json();
            releases = releases.concat(page);

            // Follow the Link: <url>; rel="next" header if present
            const link = res.headers.get('Link') || '';
            const nextMatch = link.match(/<([^>]+)>;\s*rel="next"/);
            url = nextMatch ? nextMatch[1] : null;
        }

        return releases;
    }

    // For a list of releases, sum download_count for all assets
    // matching the given pattern.
    function sumAssetDownloads(releases, assetPattern) {
        let total = 0;
        for (const release of releases) {
            if (!Array.isArray(release.assets)) continue;
            for (const asset of release.assets) {
                if (assetPattern.test(asset.name)) {
                    total += asset.download_count ?? 0;
                }
            }
        }
        return total;
    }

    // ── PUBLIC API ───────────────────────────────────────────

    /**
     * Fetches download counts for all tracked apps.
     * Returns a Map<bundleId, count>.
     *
     * Strategy:
     * 1. Return cached data instantly if fresh (≤30 min old).
     * 2. Otherwise deduplicate repos, fetch in parallel, sum per-bundle.
     * 3. Write result to sessionStorage for subsequent calls this session.
     */
    async function fetchAllDownloads() {
        const cached = readCache();
        if (cached) return new Map(Object.entries(cached));

        // Deduplicate repos — Minis-Heap hosts 4 apps with 1 API call
        const repoToApps = new Map();
        for (const [bundleId, cfg] of Object.entries(BUNDLE_MAP)) {
            if (!repoToApps.has(cfg.repo)) repoToApps.set(cfg.repo, []);
            repoToApps.get(cfg.repo).push({ bundleId, assetPattern: cfg.assetPattern });
        }

        // Fetch all repos in parallel
        const repoResults = await Promise.allSettled(
            [...repoToApps.entries()].map(([repo]) => fetchRepoDownloads(repo))
        );

        const counts = {};
        let rateLimitedUntil = null;

        [...repoToApps.entries()].forEach(([repo, apps], i) => {
            const result = repoResults[i];
            if (result.status === 'rejected') {
                const msg = result.reason?.message ?? '';
                if (msg.startsWith('rate_limited:')) {
                    rateLimitedUntil = msg.replace('rate_limited:', '');
                }
                console.warn(`[GH Downloads] ${repo}: ${msg}`);
                apps.forEach(({ bundleId }) => { counts[bundleId] = null; });
                return;
            }

            const releases = result.value;
            apps.forEach(({ bundleId, assetPattern }) => {
                counts[bundleId] = sumAssetDownloads(releases, assetPattern);
            });
        });

        writeCache(counts);

        if (rateLimitedUntil) {
            console.warn(`[GH Downloads] GitHub rate limit hit. Resets at ${rateLimitedUntil}.`);
        }

        return new Map(Object.entries(counts));
    }

    // ── FORMATTING ───────────────────────────────────────────
    function formatCount(n) {
        if (n === null || n === undefined) return null;
        if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
        if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
        return n.toLocaleString();
    }

    // ── DOM INTEGRATION ──────────────────────────────────────
    /**
     * Inject download count badges into app cards.
     * Called after the app grid is rendered.
     * Uses MutationObserver to also update cards added by infinite scroll.
     *
     * @param {Map<string, number|null>} counts  bundleId → total downloads
     * @param {AppData[]} apps                   from AppState.apps
     */
    function injectBadges(counts, apps) {
        // Build a lookup: appId → bundleId
        const idToBundleId = new Map(apps.map(a => [a.id, a.bundleId]));

        function applyToCard(card) {
            // Skip if already has a badge
            if (card.querySelector('.gh-download-badge')) return;

            const appId = card.getAttribute('data-app-id');
            if (!appId) return;

            const bundleId = idToBundleId.get(appId);
            if (!bundleId) return;

            const count = counts.get(bundleId);
            if (count === null || count === undefined) return;

            const formatted = formatCount(count);
            if (!formatted) return;

            const badge = document.createElement('div');
            badge.className = 'gh-download-badge';
            badge.setAttribute('aria-label', `${count.toLocaleString()} total downloads`);
            badge.setAttribute('title', `${count.toLocaleString()} downloads across all sources`);
            badge.innerHTML = `
                <span class="gh-dl-icon" aria-hidden="true">⬇</span>
                <span class="gh-dl-count">${formatted}</span>
            `;

            // Insert after .app-status (the "✅ Working · v..." line)
            const statusEl = card.querySelector('.app-status');
            if (statusEl && statusEl.nextSibling) {
                statusEl.parentNode.insertBefore(badge, statusEl.nextSibling);
            } else {
                // Fallback: prepend to card content
                const content = card.querySelector('.app-card-content');
                if (content) content.prepend(badge);
            }
        }

        // Apply to all currently rendered cards
        document.querySelectorAll('.app-card').forEach(applyToCard);

        // Watch for new cards added by infinite scroll
        const observer = new MutationObserver(mutations => {
            for (const mutation of mutations) {
                for (const node of mutation.addedNodes) {
                    if (node.nodeType !== 1) continue;
                    if (node.classList?.contains('app-card')) {
                        applyToCard(node);
                    } else {
                        node.querySelectorAll?.('.app-card').forEach(applyToCard);
                    }
                }
            }
        });

        const grid = document.getElementById('appGrid');
        if (grid) {
            observer.observe(grid, { childList: true, subtree: true });
        }

        return observer; // caller can disconnect() if needed
    }

    /**
     * Also inject into the featured card if present.
     */
    function injectFeaturedBadge(counts, apps) {
        const featuredCard = document.getElementById('featuredCard');
        if (!featuredCard) return;

        const appId = featuredCard.getAttribute('data-app-id');
        if (!appId) return;

        const app = apps.find(a => a.id === appId);
        if (!app) return;

        const count = counts.get(app.bundleId);
        if (count === null || count === undefined) return;
        if (featuredCard.querySelector('.gh-download-badge')) return;

        const badge = document.createElement('div');
        badge.className = 'gh-download-badge gh-download-badge--featured';
        badge.setAttribute('aria-label', `${count.toLocaleString()} total downloads`);
        badge.innerHTML = `
            <span class="gh-dl-icon" aria-hidden="true">⬇</span>
            <span class="gh-dl-count">${formatCount(count)}</span>
            <span class="gh-dl-label">downloads</span>
        `;

        // Insert into the featured-info block, after the developer name
        const devEl = document.getElementById('featuredDev');
        if (devEl && devEl.parentNode) {
            devEl.parentNode.insertBefore(badge, devEl.nextSibling);
        }
    }

    /**
     * Update modal if it's open when we receive fresh data.
     */
    function injectModalBadge(counts, app) {
        const modal = document.getElementById('appModal');
        if (!modal) return;
        if (modal.querySelector('.gh-download-badge--modal')) return;

        const count = counts.get(app.bundleId);
        if (count === null || count === undefined) return;

        const badge = document.createElement('span');
        badge.className = 'modal-meta-item gh-download-badge--modal';
        badge.textContent = `${formatCount(count)} downloads`;
        badge.setAttribute('title', `${count.toLocaleString()} total downloads across all sources`);

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

    // ── INIT ─────────────────────────────────────────────────
    /**
     * Main entry point. Call this after AppState.apps is populated.
     *
     * @param {AppData[]} apps  — AppState.apps
     * @returns {Promise<void>}
     */
    async function init(apps) {
        if (!apps || apps.length === 0) return;

        try {
            const counts = await fetchAllDownloads();
            injectBadges(counts, apps);
            injectFeaturedBadge(counts, apps);

            // Expose counts so openAppModal can use them
            window.__ghDownloadCounts = counts;
        } catch (err) {
            // Non-fatal — download badges are purely decorative
            console.warn('[GH Downloads] Failed to load download counts:', err.message);
        }
    }

    return { init, injectModalBadge, formatCount };
})();

// Make available globally so app.js can call GH_DOWNLOADS.init(AppState.apps)
// and GH_DOWNLOADS.injectModalBadge(counts, app) when a modal opens.
window.GH_DOWNLOADS = GH_DOWNLOADS;
