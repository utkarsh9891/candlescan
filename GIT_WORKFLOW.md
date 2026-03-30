# Git Workflow & Versioning — CandleScan

> End-to-end guide for coding agents. Follow this exactly — no shortcuts.

---

## Branch Protection Rules (enforced by GitHub)

- **Direct push to `main` is blocked.** All changes must go through a pull request.
- Merge method: **merge commit only** (no squash, no rebase).
- No approval required (0 reviewers), but PR is mandatory.
- Branch deletion and force-push on `main` are blocked.

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
gh pr merge <pr-number> --merge
```

Only use `--merge`. Do not use `--squash` or `--rebase`.

### 6. After merge — versioning is automatic

Once the PR merges to `main`, GitHub Actions does everything:
1. Fetches the latest git tag (e.g., `v3.0.5`)
2. Increments the patch number → creates `v3.0.6`
3. Pushes the new tag
4. Runs `npm ci` → `npm test` → `npm run build`
5. Deploys to GitHub Pages

**You do NOT need to:**
- Edit any version field anywhere (there is none in package.json)
- Create tags manually
- Trigger deploys manually

---

## Versioning System

### Source of truth: git tags

Version is derived at build time via `git describe --tags --always` in `vite.config.js`.
There is no version field in `package.json`. Do not add one.

### Tag format

`vMAJOR.MINOR.PATCH` — e.g., `v3.0.6`

### What gets which version bump

| Change | Version bump | How it happens |
|--------|-------------|----------------|
| Bug fix, tuning, UI tweak, docs | **Patch** (auto) | Merge PR → CI auto-tags |
| New feature, page, pattern category, signal type | **Patch** (auto) | Same — let CI handle it |
| New engine mode, breaking API change | **Major/Minor** (manual) | Owner tags manually after merge |

**For coding agents: always let the auto-patch handle versioning.**
Only the repo owner manually tags major/minor versions when needed.

### How auto-tagging works (deploy.yml)

```
Push to main (PR merge)
  → CI checks: is HEAD already tagged?
    → Yes: skip tagging, proceed to build
    → No: read latest tag → increment patch → push new tag
  → npm ci → npm test → npm run build → deploy
```

If the owner pushes a manual tag (e.g., `v4.0.0`), CI triggers a second deploy
with that version. `cancel-in-progress: true` ensures the manual tag deploy
replaces any in-flight auto-patch deploy.

---

## Version Display

Shown in the hamburger menu footer. Format examples:
- `v3.0.6` — exactly on a tag
- `v3.0.6-3-gabcdef` — 3 commits after v3.0.6
- Injected via `__APP_VERSION__` global defined in `vite.config.js`

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
gh pr merge <number> --merge

# Done. CI auto-tags, builds, and deploys.
```
