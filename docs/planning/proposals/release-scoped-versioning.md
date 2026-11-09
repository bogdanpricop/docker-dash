# Proposal — Release-Scoped Versioning

**Status:** Proposal · 2026-11-09
**Trigger:** External PR #14 (pinned navigation entries) became unmergeable after four upstream releases landed during the review window
**Target release:** v8.97.0
**Decision needed:** adopt, adopt with changes, or pass

---

## The problem

Every feature commit bumps the version in five files. A PR that follows the
documented contributor workflow must therefore also bump the version, and two
PRs that bump the version can never merge without a manual edit.

This is not theoretical. PR #14 was open while four upstream releases landed
(8.96.36 → 8.96.39). Replaying that merge today reproduces the failure
exactly:

```
$ git merge upstream/main
CONFLICT (content): Merge conflict in docker-compose.yml
CONFLICT (content): Merge conflict in package-lock.json
CONFLICT (content): Merge conflict in package.json
CONFLICT (content): Merge conflict in public/js/pages/whatsnew.js
CONFLICT (content): Merge conflict in src/version.js
```

Five files. Every single conflict hunk is a version number — not one hunk of
actual feature code conflicts:

```
$ for f in $(git diff --name-only --diff-filter=U); do echo "$f: $(grep -c '^<<<<<<<' $f)"; done
docker-compose.yml: 2 hunk(s)
package-lock.json: 2 hunk(s)
package.json: 1 hunk(s)
public/js/pages/whatsnew.js: 1 hunk(s)
src/version.js: 1 hunk(s)
```

The contributor's only correct resolution is to pick the *next* version number
and hand-edit five files — and to redo it again after every subsequent
upstream release, for as long as the PR stays open. The number they write is a
guess that is wrong the moment the maintainer ships.

### Why the current scheme does this

`docs/CONTRIBUTING.md` §6 tells contributors to run `npm version patch` and
add a matching entry to `public/js/pages/whatsnew.js`. Both instructions exist
to keep the *release* metadata current — but they are applied per *commit*,
and upstream has been treating every merge to `main` as a release:

- 26 of the last 40 upstream commits bump the version.
- 38 distinct versions were minted between the `v8.96.1` tag and `upstream/main`
  (106 commits), i.e. `8.96.2` through `8.96.39`, while only `v8.96.1` was
  ever pushed as a GitHub release.

So the version number in `package.json` is not a release identifier. It is a
commit counter. It has already run 38 versions ahead of the newest actual
release (`v8.96.1`, published 2026-08-21) — the last GitHub release predates
106 upstream commits.

---

## The proposal

**Split the two jobs the version number is doing today.**

Today a single string serves as both *release identity* and *cache-busting
token*. The proposal separates them:

| Concern | Owner | Changes when | Mechanism |
|---|---|---|---|
| **Release identity** — `8.96.40` | Maintainer, at release time | A release is cut | `npm version patch`, tagged `v8.96.40` |
| **Cache-busting token** — `?v=__BUILD__` | Nobody — computed automatically | Any served asset changes | Content hash of `public/`, computed at server start |

### 1. Contributors never touch version files

A feature PR changes:

- its own source files,
- `CHANGELOG.md` (appending under the existing `## [Unreleased]` heading),
- `public/js/pages/whatsnew.js` **only** to add an entry under an
  `## [Unreleased]` heading, not a new numbered release.

It does **not** touch `package.json`, `package-lock.json`, `src/version.js`,
or `docker-compose.yml`. No version number appears anywhere in the diff.

### 2. The maintainer bumps the version at release time

Releasing becomes an explicit, single-purpose act:

```bash
npm version patch        # or minor / major
git tag v8.96.40 && git push origin v8.96.40
```

`npm version` already propagates the number to `src/version.js` and
`docker-compose.yml` via the `version` lifecycle hook
(`scripts/sync-version.js`), and `package-lock.json` is updated by npm itself.
No new script is needed for the bump itself.

### 3. The cache-busting token becomes automatic

The `?v=__VERSION__` query on every `<script>`/`<link>` in `public/index.html`
exists so browsers refetch assets after a deploy. If the version only changes
at release time, that token stops changing between releases — and stale JS
would be served for the whole interval.

So the token is replaced by a content hash of the served assets, computed once
at server start (`src/build-id.js`):

```
public/js  +  public/css  +  public/lib  +  public/vendor
   →  sha256 over (relative path, file contents)  →  first 12 hex chars
```

Measured on this tree: **13 ms**, over 221 files, deterministic, and it changes
if and only if a served asset changes. `public/index.html` is excluded — it is
served `Cache-Control: no-cache` and is never cached, so hashing it would be
circular.

---

## What changes in the repository

### `src/version.js` — unchanged, but no longer written per commit

Still the single source of truth for the release number, still synced by
`scripts/sync-version.js`. It simply stops being edited by feature commits.

### `src/build-id.js` — new

Computes the cache-busting token from the served assets:

```
public/js  +  public/css  +  public/lib  +  public/vendor
   →  sha256 over (relative path, file contents)  →  first 12 hex chars
```

Measured on this tree: **13 ms**, over 221 files, deterministic, and it changes
if and only if a served asset changes. `public/index.html` is excluded — it is
served `Cache-Control: no-cache` and is never cached, so hashing it would be
circular.

It lives in `src/`, not `scripts/`, because the running server needs it at
startup and the production image copies only `src/` and `public/`
(`Dockerfile:75-76`). Putting it in `scripts/` breaks the container with
`Cannot find module '../scripts/build-id'`.

### `src/server.js` — compute the build token

```js
const _appVersion = require('./version');
const { computeBuildId } = require('./build-id');
const _buildId = computeBuildId(path.join(__dirname, '..', 'public'));
const _indexHtml = fs
  .readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8')
  .replace(/__BUILD__/g, _buildId)      // cache-busting token
  .replace(/__VERSION__/g, _appVersion); // display + API version
```

`__VERSION__` keeps its two display uses (the GitHub link and the sidebar
version chip, `public/index.html:80` and `:93`); the 127 `?v=__VERSION__`
occurrences become `?v=__BUILD__`.

### `public/index.html` — 127 token swaps

`?v=__VERSION__` → `?v=__BUILD__` on all asset URLs. Two display uses keep
`__VERSION__`.

### `public/js/pages/whatsnew.js` — an `Unreleased` section

The release entries are keyed by version. A contributor does not know the
version their change will ship in, so they cannot add a keyed entry. The file
gains an unreleased list that the release process folds into a numbered entry:

```js
_releases: [ /* numbered releases, newest first — written at release time */ ],

_unreleased: [
  { type: 'feature', text: 'Pin left navigation entries to a Pinned group …' },
],
```

The What's New page renders `_unreleased` above the numbered releases, labelled
"Unreleased". At release time the maintainer moves those entries into a new
numbered release.

This also removes the last conflict source in the replay: with `whatsnew.js`
untouched by the PR, the merge is clean.

### `CHANGELOG.md` — no change

The `## [Unreleased]` heading already exists and is already where upstream
accumulates entries. The proposal only requires contributors to append there
rather than mint a version section.

### `docs/CONTRIBUTING.md` §6 — rewritten

Replaced with: *"Do not bump the version. Add your entry to `CHANGELOG.md`
under `## [Unreleased]` and to the `_unreleased` list in
`public/js/pages/whatsnew.js`. The maintainer assigns the version at release
time."*

### `docs/CONTRIBUTING.md` feature checklist — step 12 removed

`12. Bump version + CHANGELOG + What's New` becomes `12. CHANGELOG + What's New
(unreleased)`. The 12-step feature checklist is otherwise unchanged.

### `scripts/check-version-consistency.js` — new, plus a CI step

New check `npm run check:version-consistency`, run in `ci.yml`, asserting:

- `package.json` version == `package-lock.json` version (both root fields)
- `src/version.js` export == the same value
- every `APP_VERSION:-` default in `docker-compose.yml` == the same value
- the newest `whatsnew.js` release entry == the same value

The last clause is what makes the scheme safe: it is impossible to bump the
version without recording the release notes, and impossible to record a
release without bumping the version. Today nothing checks any of this — the
`8.96.10` pin in `scripts/smoke-auth-upgrade.js` is stale by 29 versions and
nothing flags it.

The script lives in `scripts/` because only CI runs it — unlike
`src/build-id.js`, the server never loads it.

---

## Why this resolves the conflict

Replaying the PR #14 merge under each variant, on this tree:

| Variant | Conflicting files |
|---|---|
| Today (PR bumps the version) | 5 — `docker-compose.yml`, `package-lock.json`, `package.json`, `whatsnew.js`, `src/version.js` |
| PR bumps nothing, `whatsnew.js` still edited | 1 — `whatsnew.js` |
| **Proposal (PR bumps nothing, `whatsnew.js` untouched)** | **0 — clean merge** |

In the clean case both sides' changelog content survives — upstream's four new
entries and the PR's two both land under `## [Unreleased]`:

```
+- Sort the Stacks table by CPU or RAM and open linked Docker networks and
+  volumes. Compact the toolbar and mark expanded stacks with a side accent.
+- Show host-scoped CPU and RAM totals, network and disk rates, sample times,
+  and per-container charts for expanded Stacks table rows.
+- Add a compact Stacks table with expandable services and quick links to logs
+  and stats. Keep the selected host visible and remember list filters.
+- Download individual local database backups, including encrypted copies, in
+  their original format.
 - Select and delete multiple local database backup copies in one confirmed
   operation. Review any copies that changed or could not be removed.
 - Pin left navigation entries to a Pinned group at the top of the sidebar.
```

The contributor never guesses a version number, so there is nothing to redo
when upstream releases.

---

## What this does not change

- **The version scheme stays `8.96.x`.** The patch component still increments
  per release. This proposal is about *when* the number is written, not *what*
  it looks like.
- **Docker image tags are unaffected.** `docker-build.yml` already derives
  image tags from git tags (`type=semver,pattern={{version}}`) and from
  `type=sha`. Nothing there reads `package.json`.
- **`?v=` cache busting keeps working.** It is just computed rather than
  hand-maintained — and it becomes *more* precise, since it now changes when
  an asset actually changes rather than when a number is bumped.
- **The update checker is unaffected.** `src/services/update-check.js`
  compares the running version against the latest GitHub release tag; that
  comparison becomes *more* meaningful once the running version is a real
  release rather than a commit counter.
- **Provider plugin compatibility checks are unaffected.**
  `src/services/provider-plugins.js` compares `package.json`'s version
  against `minCoreVersion`/`maxCoreVersion` in a plugin manifest.

---

## What this branch contains

This branch is the proposal **plus a working reference implementation**, so the
maintainer can review the mechanism rather than take it on faith. Everything
except the release cut itself is implemented and tested:

| File | Change |
|---|---|
| `docs/planning/proposals/release-scoped-versioning.md` | This document |
| `src/build-id.js` | **new** — computes the cache-busting token from asset contents |
| `src/server.js` | Injects `__BUILD__` alongside `__VERSION__` |
| `public/index.html` | 127 `?v=__VERSION__` → `?v=__BUILD__` |
| `public/js/pages/whatsnew.js` | `_unreleased` list + rendering it above the releases |
| `scripts/check-version-consistency.js` | **new** — the CI guard |
| `src/__tests__/release-scoped-versioning.test.js` | **new** — 15 tests |
| `.github/workflows/ci.yml` | Runs the guard |
| `docs/CONTRIBUTING.md` | §6 rewritten; feature-checklist step 12; PR checklist |
| `CLAUDE.md`, `.github/PULL_REQUEST_TEMPLATE.md`, `examples/sample-feature/README.md` | Follow the new convention |

The version files (`package.json`, `package-lock.json`, `src/version.js`,
`docker-compose.yml`) are deliberately **untouched** — that is the point of the
proposal.

**One unrelated fix is included.** `src/services/provider-sdk/privileged-compliance.js`
has a pre-existing bug on `upstream/main`: `provider_compliance_exports.bundle_hash`
is `UNIQUE`, but the hash was computed over a bundle that did not include the
export id, so two exports of the same scope created in the same millisecond
collide. The test fails intermittently — 1 run in 12 on `upstream/main`. The
fix (include the export id and format in the hashed bundle) plus a regression
test is included here so this branch is green; the same fix is also on the
pinned-navigation branch and can be taken from whichever lands first.

---

## Risks

**The 127-token change in `public/index.html` is large but mechanical.**
It is a single `sed`, reviewable as one line. Three existing assertions on
`?v=__VERSION__`
(`src/__tests__/{edge-platform,compose-catalog-page,workstation-fleet-page}.test.js`)
are updated to `?v=__BUILD__`.

**`src/build-id.js` must live in `src/`, not `scripts/`.** The production image
copies only `src/` and `public/` (`Dockerfile:75-76`), and the dev overlay
mounts only `./src` and `./public` (`docker-compose.dev.yml:12-13`). A
`require('../scripts/build-id')` from `src/server.js` therefore fails in the
container with `Cannot find module '../scripts/build-id'` — verified by
restarting the running container against this branch.

**Two version-ish numbers will coexist** (`__VERSION__` for display, `__BUILD__`
for cache busting). They are named to make the distinction obvious, and the
proposal keeps `__VERSION__` for every user-visible and API surface so no
external consumer sees the hash.

**The `?v=` token changes on every deploy instead of every release.** That is
the intended effect — it means browsers refetch assets as soon as they change,
rather than relying on the version bump to force it. Verified end to end: the
served token moved from `6ceb11f69efb` to `0afe50003aae` after a one-line
change to `public/css/app.css` and a server restart, and returned when the
file was restored.

**A contributor could still bump the version by mistake.** The CI consistency
check catches the drift; the `Unreleased`/`_releases` split means a stray
numbered entry is visible in review.

---

## Migration

One-time, on `main`, in a single commit — no history rewrite, no force-push.
This branch already contains steps 1, 3, 4 and the `_unreleased` list, so
landing it is steps 1 + 3 + 4; only the release cut remains.

1. Land the `__BUILD__` mechanism and the `whatsnew.js` `_unreleased` list.
   The current `8.96.39` in `package.json` stays as-is; it becomes the version
   of the next release.  *in this branch*
2. Move the existing numbered `whatsnew.js` entries' most recent one into
   `_releases` unchanged, and start `_unreleased` empty.  *in this branch*
3. Add `npm run check:version-consistency` to `ci.yml`.  *in this branch*
4. Rewrite `docs/CONTRIBUTING.md` §6 and the feature checklist step 12.  *in this branch*
5. Open the next release as `npm version patch` → `v8.96.40`.

Existing tags and releases are untouched. `v8.96.1` remains the newest GitHub
release until the next one is cut; the intermediate `8.96.2`–`8.96.39` numbers
that were minted per commit were never published, so nothing downstream
depends on them.

---

## Alternatives considered

**Keep the version bump but let contributors skip it.** Requires the
maintainer to renumber on merge — the current state, with the same conflict.

**Compute the version from the git tag at runtime.** `src/version.js` would
become `git describe --tags`. Rejected: the Docker image copies only
`src/` and `public/`, not `.git`, so the tag is unavailable at runtime. The
version has to be a committed file.

**Use a `CalVer` scheme (`2026.11.9`).** Would make every day a new version
and stop the minor component from being pinned at `96`, but it is a much
larger change to the release tooling, the `update-check.js` comparison, and
every version reference in the tree — and it does not itself fix the conflict.
It is worth revisiting separately.

**Bump the version on `main` but in a single commit per batch.** Reduces but
does not remove the conflict, and leaves the version meaning "commit count".

---

## Decision requested

1. Adopt the release-scoped version bump, the `__BUILD__` cache-busting token,
   and the `whatsnew.js` `_unreleased` list?
2. If yes — should the migration land as one commit on `main`, or as a
   sequence: mechanism first, contributor-doc change once the mechanism is
   proven?
3. Should `8.96.39` become `v8.96.40` as the next release, or should the
   maintainer re-base the counter on the last real release (`v8.96.1`) first?

---

## Evidence

All measurements above were taken on this repository at `upstream/main`
(`2525827`), against `origin/feature/pinned-nav-entries` (`effd6b4`), by
replaying the merge in a scratch worktree and inspecting the resulting index.
