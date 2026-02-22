// ============================================================
// Mini's IPA Repo — GitHub Download Tracker
//
// Derives repo + asset pattern directly from each app's
// downloadURL in mini.json. No hardcoded filename guesses.
//
// API: GET /repos/{owner}/{repo}/releases
// Rate limit: 60 req/hr unauthenticated — 5 repos max here.
// ============================================================

const GH_DOWNLOADS = (() => {
    const API_BASE = 'https://api.github.com';
    const CACHE_KEY = 'gh_downloads_v2';
    const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes
    const FETCH_TIMEOUT_MS = 8000;

    // ── CACHE ────────────────────────────────────────────────
    function readCache() {
        try {
            const raw = sessionStorage.getItem(CACHE_KEY);
            if (!raw) return null;
            const parsed = JSON.parse(raw);
            if (!parsed || typeof parsed.ts !== 'number') return null;
            if (Date.now() - parsed.ts > CACHE_TTL_MS) return null;
            return parsed.data;
        } catch {
            return null;
        }
    }

    function writeCache(data) {
        try {
            sessionStorage.setItem(CACHE_KEY, JSON.stringify({ ts: Date.now(), data }));
        } catch { /* storage unavailable */ }
    }

    // ── DERIVE REPO INFO FROM downloadUrl ───────────────────
    // Given:  https://github.com/OofMini/YTLite/releases/download/New/YouTubePlus_5.2b4.ipa
    // Returns: { repo: 'OofMini/YTLite', baseName: 'YouTubePlus' }
    //
    // Given:  https://github.com/OofMini/Minis-Heap/releases/download/New/InShot.ipa
    // Returns: { repo: 'OofMini/Minis-Heap', baseName: 'InShot' }
    //
    // baseName strips .ipa and any trailing _version/-version suffix,
    // so it matches the asset across every historical release even when
    // the version number in the filename changes.
    function deriveRepoInfo(downloadUrl) {
        if (!downloadUrl) return null;

        // Match: github.com/{owner}/{repo}/releases/download/{tag}/{filename.ipa}
        const match = downloadUrl.match(
            /github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/releases\/download\/[^/]+\/([^/?#]+\.ipa)$/i
        );
        if (!match) return null;

        const repo = match[1];     // e.g. OofMini/YTLite
        const filename = match[2]; // e.g. YouTubePlus_5.2b4.ipa

        // Strip .ipa, then strip trailing _version or -version segment
        //   "YouTubePlus_5.2b4.ipa" → "YouTubePlus_5.2b4" → "YouTubePlus"
        //   "EeveeSpotify.ipa"      → "EeveeSpotify"       → "EeveeSpotify"
        //   "InShot.ipa"            → "InShot"             → "InShot"
        const noExt = filename.replace(/\.ipa$/i, '');
        const baseName = noExt.replace(/[_-]\d[\w.+-]*$/, '');

        return { repo, baseName };
    }

    // ── ASSET MATCHING ───────────────────────────────────────
    // An asset matches if it ends in .ipa AND starts with baseName (case-insensitive).
    function assetMatches(assetName, baseName) {
        const lower = assetName.toLowerCase();
        return lower.endsWith('.ipa') && lower.startsWith(baseName.toLowerCase());
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

    // Fetch ALL releases for a repo, following Link pagination.
    // Summing across every release gives the real all-time download total.
    async function fetchAllReleases(repo) {
        let url = `${API_BASE}/repos/${repo}/releases?per_page=100`;
        let releases = [];

        while (url) {
            const res = await fetchWithTimeout(url);

            if (res.status === 403 || res.status === 429) {
                const reset = res.headers.get('X-RateLimit-Reset');
                const resetTime = reset
                    ? new Date(parseInt(reset, 10) * 1000).toLocaleTimeString()
                    : 'soon';
                throw new Error(`rate_limited:${resetTime}`);
            }

            if (!res.ok) throw new Error(`http_${res.status}`);

            const page = await res.json();
            releases = releases.concat(page);

            const link = res.headers.get('Link') || '';
            const next = link.match(/<([^>]+)>;\s*rel="next"/);
            url = next ? next[1] : null;
        }

        return releases;
    }

    // Sum download_count across all releases for assets matching baseName.
    function sumDownloads(releases, baseName) {
        let total = 0;
        for (const release of releases) {
            if (!Array.isArray(release.assets)) continue;
            for (const asset of release.assets) {
                if (assetMatches(asset.name, baseName)) {
                    total += asset.download_count ?? 0;
                }
            }
        }
        return total;
    }

    // ── PUBLIC: fetchAllDownloads ────────────────────────────
    // Accepts the apps array from AppState.apps.
    // Returns Map<bundleId, count|null>.
    async function fetchAllDownloads(apps) {
        const cached = readCache();
        if (cached) return new Map(Object.entries(cached));

        // Build repo → [{bundleId, baseName}] map from app data.
        // Deduplicates repos so Minis-Heap is only fetched once for all 4 apps.
        const repoMap = new Map();

        for (const app of apps) {
            const info = deriveRepoInfo(app.downloadUrl);
            if (!info) {
                console.warn(`[GH Downloads] Cannot derive repo from: ${app.downloadUrl}`);
                continue;
            }

            if (!repoMap.has(info.repo)) repoMap.set(info.repo, []);
            repoMap.get(info.repo).push({ bundleId: app.bundleId, baseName: info.baseName });
        }

        if (repoMap.size === 0) return new Map();

        // Fetch all repos in parallel
        const repos = [...repoMap.keys()];
        const results = await Promise.allSettled(repos.map(repo => fetchAllReleases(repo)));

        const counts = {};
        let rateLimitedUntil = null;

        repos.forEach((repo, i) => {
            const result = results[i];
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

            const releases = result.value;

            // Log found assets for debugging (visible in DevTools console)
            const allAssetNames = [...new Set(
                releases.flatMap(r => (r.assets || []).map(a => a.name))
            )];
            console.log(`[GH Downloads] ${repo} — ${releases.length} releases, assets: ${allAssetNames.join(', ') || '(none)'}`);

            appsForRepo.forEach(({ bundleId, baseName }) => {
                const count = sumDownloads(releases, baseName);
                counts[bundleId] = count;
                console.log(`[GH Downloads] ${bundleId} baseName="${baseName}" → ${count} downloads`);
            });
        });

        if (rateLimitedUntil) {
            console.warn(`[GH Downloads] Rate limit hit. Resets at ${rateLimitedUntil}.`);
        }

        writeCache(counts);
        return new Map(Object.entries(counts));
    }

    // ── FORMATTING ───────────────────────────────────────────
    function formatCount(n) {
        if (n === null || n === undefined || n < 0) return null;
        if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
        if (n >= 1_000)     return `${(n / 1_000).toFixed(1)}K`;
        return n.toLocaleString();
    }

    // ── DOM: inject badges into app cards ───────────────────
    function injectBadges(counts, apps) {
        const idToBundleId = new Map(apps.map(a => [a.id, a.bundleId]));

        function applyToCard(card) {
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
            badge.setAttribute('title', `${count.toLocaleString()} downloads tracked via GitHub Releases`);
            badge.innerHTML = `<span class="gh-dl-icon" aria-hidden="true">⬇</span><span class="gh-dl-count">${formatted}</span>`;

            const statusEl = card.querySelector('.app-status');
            if (statusEl && statusEl.nextSibling) {
                statusEl.parentNode.insertBefore(badge, statusEl.nextSibling);
            } else {
                const content = card.querySelector('.app-card-content');
                if (content) content.prepend(badge);
            }
        }

        document.querySelectorAll('.app-card').forEach(applyToCard);

        // Watch for cards added by infinite scroll
        const grid = document.getElementById('appGrid');
        if (!grid) return null;

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

        observer.observe(grid, { childList: true, subtree: true });
        return observer;
    }

    // ── DOM: inject badge into featured card ─────────────────
    function injectFeaturedBadge(counts, apps) {
        const featuredCard = document.getElementById('featuredCard');
        if (!featuredCard || featuredCard.querySelector('.gh-download-badge')) return;

        const appId = featuredCard.getAttribute('data-app-id');
        if (!appId) return;

        const app = apps.find(a => a.id === appId);
        if (!app) return;

        const count = counts.get(app.bundleId);
        if (count === null || count === undefined) return;

        const badge = document.createElement('div');
        badge.className = 'gh-download-badge gh-download-badge--featured';
        badge.setAttribute('aria-label', `${count.toLocaleString()} total downloads`);
        badge.innerHTML = `<span class="gh-dl-icon" aria-hidden="true">⬇</span><span class="gh-dl-count">${formatCount(count)}</span><span class="gh-dl-label"> downloads</span>`;

        const devEl = document.getElementById('featuredDev');
        if (devEl && devEl.parentNode) {
            devEl.parentNode.insertBefore(badge, devEl.nextSibling);
        }
    }

    // ── DOM: inject download count into open modal ───────────
    function injectModalBadge(counts, app) {
        const modal = document.getElementById('appModal');
        if (!modal || modal.querySelector('.gh-download-badge--modal')) return;

        const count = counts.get(app.bundleId);
        if (count === null || count === undefined) return;

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

    // ── INIT ─────────────────────────────────────────────────
    async function init(apps) {
        if (!apps || apps.length === 0) return;
        try {
            const counts = await fetchAllDownloads(apps);
            injectBadges(counts, apps);
            injectFeaturedBadge(counts, apps);
            window.__ghDownloadCounts = counts;
        } catch (err) {
            console.warn('[GH Downloads] Failed:', err.message);
        }
    }

    return { init, injectModalBadge, formatCount };
})();

window.GH_DOWNLOADS = GH_DOWNLOADS;
