'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { computeBuildId } = require('../build-id');
const { checkConsistency, collectVersions } = require('../../scripts/check-version-consistency');

const ROOT = path.join(__dirname, '..', '..');

describe('Release-scoped versioning', () => {
  describe('build id', () => {
    let tmp;

    beforeEach(() => {
      tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-build-id-'));
      for (const dir of ['js', 'css', 'lib', 'vendor']) {
        fs.mkdirSync(path.join(tmp, dir), { recursive: true });
      }
    });

    afterEach(() => {
      fs.rmSync(tmp, { recursive: true, force: true });
    });

    const write = (relative, content) => {
      const full = path.join(tmp, relative);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content);
    };

    test('is deterministic for unchanged assets', () => {
      write('js/app.js', 'console.log(1);');
      write('css/app.css', 'body{}');
      const first = computeBuildId(tmp);
      const second = computeBuildId(tmp);
      expect(first).toBe(second);
      expect(first).toHaveLength(12);
    });

    test('changes when a served asset changes', () => {
      write('js/app.js', 'console.log(1);');
      const before = computeBuildId(tmp);
      write('js/app.js', 'console.log(2);');
      expect(computeBuildId(tmp)).not.toBe(before);
    });

    test('changes when an asset is added', () => {
      write('js/app.js', 'console.log(1);');
      const before = computeBuildId(tmp);
      write('js/pages/new.js', '// new');
      expect(computeBuildId(tmp)).not.toBe(before);
    });

    test('changes when an asset is renamed even with identical content', () => {
      write('js/app.js', 'same');
      const before = computeBuildId(tmp);
      write('js/renamed.js', 'same');
      expect(computeBuildId(tmp)).not.toBe(before);
    });

    test('ignores files outside the served asset directories', () => {
      write('js/app.js', 'console.log(1);');
      const before = computeBuildId(tmp);
      // index.html carries the token itself — hashing it would be circular.
      write('index.html', '<html>v=__BUILD__</html>');
      write('fonts/font.woff2', 'binary');
      expect(computeBuildId(tmp)).toBe(before);
    });

    test('returns a placeholder when there are no assets', () => {
      expect(computeBuildId(tmp)).toBe('dev');
    });

    test('the repository build id is stable across calls', () => {
      const publicDir = path.join(ROOT, 'public');
      const first = computeBuildId(publicDir);
      expect(first).toHaveLength(12);
      expect(first).toBe(computeBuildId(publicDir));
    });
  });

  describe('version consistency', () => {
    test('the repository version locations agree', () => {
      expect(checkConsistency()).toEqual([]);
    });

    test('every location reports the same version', () => {
      const versions = collectVersions();
      expect(versions.packageJson).toBe(versions.packageLock);
      expect(versions.packageJson).toBe(versions.packageLockRoot);
      expect(versions.packageJson).toBe(versions.versionJs);
      expect(versions.compose).toEqual([versions.packageJson]);
      expect(versions.whatsNew).toBe(versions.packageJson);
    });
  });

  describe("What's New unreleased list", () => {
    const whatsNew = fs.readFileSync(
      path.join(ROOT, 'public', 'js', 'pages', 'whatsnew.js'),
      'utf8',
    );

    test('the page declares an unreleased list', () => {
      expect(whatsNew).toContain('_unreleased:');
    });

    test('the unreleased list is rendered above the numbered releases', () => {
      // The unreleased card is emitted before the numbered release cards.
      const render = whatsNew.slice(whatsNew.indexOf('_renderReleases()'));
      expect(render).toContain('unreleased');
      expect(render.indexOf('unreleased + releases')).toBeGreaterThan(-1);
    });

    test('unreleased changes carry the same shape as released ones', () => {
      // Each entry is { type, text } — the same shape _releases uses.
      const unreleased = whatsNew.match(/_unreleased:\s*\[([\s\S]*?)\]/);
      expect(unreleased).not.toBeNull();
      // The list starts empty; entries are added by contributors.
      expect(unreleased[1].trim()).toBe('');
    });
  });

  describe('release-scoped versioning contract', () => {
    test('the release version is written to every version location', () => {
      const versions = collectVersions();
      // The five locations the proposal names.
      expect(versions.packageJson).toBeTruthy();
      expect(versions.packageLock).toBe(versions.packageJson);
      expect(versions.packageLockRoot).toBe(versions.packageJson);
      expect(versions.versionJs).toBe(versions.packageJson);
      expect(versions.compose.length).toBeGreaterThan(0);
      for (const compose of versions.compose) {
        expect(compose).toBe(versions.packageJson);
      }
    });

    test("the What's New page records the current release", () => {
      const versions = collectVersions();
      expect(versions.whatsNew).toBe(versions.packageJson);
    });

    test('the cache-busting token is computed, not hand-maintained', () => {
      const buildId = require('../build-id');
      expect(buildId.ASSET_DIRS).toEqual(['js', 'css', 'lib', 'vendor']);
      // index.html is excluded on purpose — it is where the token is injected.
      expect(buildId.ASSET_DIRS).not.toContain('index.html');
    });
  });
});
