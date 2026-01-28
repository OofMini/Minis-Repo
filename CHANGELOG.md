### 2026-01-27

- Revamp docs and scripts for hybrid repo model

Updated README and WORKFLOWS.md to reflect the new hybrid architecture, atomic updates, and improved automation. Refactored verify-links.js to check live download URLs from sidestore.json instead of the config file, improving accuracy. Bumped service worker cache versions in sw.js to ensure proper cache invalidation for the new model.

### 2026-01-27

- chore: regenerate package-lock.json

### 2026-01-27

- jbubj

### 2026-01-27

- Update app-version-updates.yml

## [3.5.0] - 2026-01-25

- Update sw.js (a26f425)
- Update index.html (bb6c3c7)
- Delete package-lock.json (91454bd)
- Update sync-all-forks.yml (7439f3e)
- Update bulk-tweaked-apps-updates.yml (eda0ab2)
- Update app-version-updates.yml (58fac97)
- Update validate.yml (fca8f64)
- Update package.json (f79d584)
- Update sync-all-forks.yml (85e25b0)
- Update validate-configs.js (2d22b6f)
- Create sync-forks.js (ea8edf2)
- Delete sync_forks.sh (35a9158)
- Update package.json (b85b422)
- Update add-apps.js (da3dcb8)
- Update update-manager.js (eb18a83)
- Update package.json (2a1738b)
- Update README.md (f9d2ae9)
- Update package.json (97c1070)
- Create add-new-app.yml (2b910d3)

# Changelog

All notable changes to the **Mini's IPA Repo** project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [3.3.0] - 2026-01-23

- refactor: Architecture 2.0 (Config-driven updates & strict validation)
- feat: Added professional formatting and config validation
- fix: Resolved race conditions in GitHub Actions
