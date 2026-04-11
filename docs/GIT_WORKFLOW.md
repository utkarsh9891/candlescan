# Git Workflow & Versioning — CandleScan

> End-to-end guide for coding agents. Follow this exactly — no shortcuts.

---

## Branch Protection Rules (enforced by GitHub)

- **Direct push to `main` is blocked.** All changes must go through a pull request.
- Merge method: **merge commit only** (no squash, no rebase).
- No approval required (0 reviewers), but PR is mandatory.
- Branch deletion and force-push on `main` are blocked.
- **Merged branches are deleted immediately** — all work is preserved in merge commits on main.

---

## End-to-End Workflow

### 1. Create a feature branch

```bash
git checkout main
git pull origin main
git checkout -b <branch-name>
```

**Branch naming:**
- `feat/<description>` — new features, patterns, pages
- `fix/<description>` — bug fixes, tuning
- `chore/<description>` — docs, config, cleanup

### 2. Make changes and commit

```bash
git add <specific-files>       # Never use `git add .` or `git add -A`
git commit -m "feat: description of change"
```

**Commit message format:** `<type>: <description>`
- `feat:` — new feature or capability
- `fix:` — bug fix
- `chore:` — docs, config, tooling (no code logic change)
- `refactor:` — code restructure without behavior change

### 3. Push the branch

```bash
git push -u origin <branch-name>
```

A **pre-push hook** runs automatically:
1. `npm test` — all tests must pass
2. `npm run build` — production build must succeed

If either fails, the push is aborted. Fix the issue and retry.
Do NOT bypass with `--no-verify` unless explicitly asked.

### 4. Create a pull request

```bash
gh pr create --title "<short title>" --body "$(cat <<'EOF'
## Summary
- <bullet points>

## Test plan
- [x] Tests pass
- [x] Build succeeds

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)" --base main
```

### 5. Merge the pull request

```bash
gh pr merge <pr-number> --merge --delete-branch
```

Only use `--merge`. Do not use `--squash` or `--rebase`.
Always pass `--delete-branch` to clean up after merge.

### 6. After merge — versioning and release are automatic

Once the PR merges to `main`, GitHub Actions does everything:
1. Fetches the latest git tag (e.g., `v0.10.0`)
2. Increments the patch number → creates `v0.10.1`
3. Pushes the new tag
4. Runs `npm ci` → `npm test` → `npm run build`
5. Deploys to GitHub Pages
6. Creates a **GitHub Release** (marked as **prerelease** while version is `0.x.y`)
   - Auto-generates release notes from PR titles

**You do NOT need to:**
- Edit any version field anywhere (there is none in package.json)
- Create tags manually
- Trigger deploys manually
- Create releases manually

---

## Versioning System

### Source of truth: git tags + GitHub Releases

Version is derived at build time via `git describe --tags --always` in `vite.config.js`.
There is no version field in `package.json`. Do not add one.

Each deploy creates a corresponding **GitHub Release** with auto-generated notes.
The app checks the GitHub Releases API (once per 24 hours) to detect updates.

### Tag format

`vMAJOR.MINOR.PATCH` — e.g., `v0.10.1`

**This project is pre-1.0 (in active development).** Version `0.x.y` signals the app is not production-ready.
- All `0.x.y` releases are marked as **prerelease** on GitHub.
- `v1.0.0` will be tagged only when the core scanning + simulation flow is stable and validated.
- From `v1.0.0` onward, releases will be marked as full (non-prerelease).

### What gets which version bump

| Change | Version bump | How it happens |
|--------|-------------|----------------|
| Any PR merge to main | **Patch** (auto) | CI auto-tags + creates release |
| Significant milestone | **Minor** (manual) | Owner tags `v0.11.0`, `v0.12.0`, etc. |
| Stable production release | **Major** (manual) | Owner tags `v1.0.0` |

**For coding agents: always let the auto-patch handle versioning.**
Only the repo owner manually tags minor/major versions when needed.

### How auto-tagging works (deploy.yml)

```
Push to main (PR merge)
  → CI checks: is HEAD already tagged?
    → Yes: skip tagging, proceed to build
    → No: read latest tag → increment patch → push new tag
  → npm ci → npm test → npm run build → deploy
  → Create GitHub Release (prerelease for 0.x.y)
```

If the owner pushes a manual tag (e.g., `v0.11.0`), CI triggers a second deploy
with that version. `cancel-in-progress: true` ensures the manual tag deploy
replaces any in-flight auto-patch deploy.

### Update detection

The app detects updates via two mechanisms:
1. **Passive**: Service worker change detection (built into PWA — no extra network cost)
2. **Active**: GitHub Releases API check (`/repos/utkarsh9891/candlescan/releases/latest`)
   - Runs **once per 24 hours** automatically (timestamp stored in localStorage)
   - Manual trigger: "Check for updates" button in Settings → About

---

## Version Display

Shown in Settings → About section. Format: `v0.10.1 (pre-release)`
- Injected via `__APP_VERSION__` global defined in `vite.config.js`
- Pre-release label shown while version is `0.x.y`

---

## What NOT to Do

| Don't | Why |
|-------|-----|
| Push directly to `main` | Branch protection blocks it |
| Add a `version` field to `package.json` | Version comes from git tags only |
| Create git tags manually | CI auto-tags on every merge |
| Use `git push --no-verify` | Skips test + build safety checks |
| Use `--squash` or `--rebase` merge | Only `--merge` is allowed |
| Amend commits after pushing | Creates force-push situations |
| Keep branches after merge | Always use `--delete-branch` on merge |

---

## Quick Reference

```bash
# Full cycle: branch → commit → push → PR → merge
git checkout main && git pull
git checkout -b feat/my-feature

# ... make changes ...
git add src/engine/myfile.js
git commit -m "feat: add new signal type"
git push -u origin feat/my-feature

gh pr create --title "Add new signal type" --body "## Summary ..."
gh pr merge <number> --merge --delete-branch

# Done. CI auto-tags, builds, deploys, and creates a GitHub Release.
```
