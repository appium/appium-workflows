#!/usr/bin/env node
/**
 * Stages a production-only, `bundleDependencies`-enabled copy of the package in the current
 * working directory into `.release-pkg` and installs its production tree - replacing the
 * pinning guarantee `npm-shrinkwrap.json` used to provide.
 *
 * Usage: prepare-npm-bundle.mjs <unbundledPackageName...>
 *
 * Every dependency (dependencies and optionalDependencies alike) gets exact-pinned to the
 * version actually resolved. On top of that, every dependency not named on the command line
 * also gets bundled (its resolved tree embedded verbatim in the tarball). Named packages are
 * excluded from bundling, left for the consumer's own npm install to fetch that exact pinned
 * version normally. Use this for anything bundling would be wrong for - most commonly
 * native/platform-specific packages, where bundling would ship whatever binary the CI runner
 * resolved for its own OS/arch and break every other platform.
 *
 * Dependency-free by design: this runs from wherever the action itself is checked out, not
 * from the calling repo's own node_modules, so it can't rely on packages like `asyncbox` or
 * `semver` being resolvable.
 */

import {execFile} from 'node:child_process';
import {cp, mkdir, readdir, readFile, rm, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {promisify} from 'node:util';

const RESOLVE_CONCURRENCY = 5;

const execFileAsync = promisify(execFile);
const ROOT = process.cwd();
const STAGING_DIR = path.join(ROOT, '.release-pkg');
// npm always includes these in a published tarball regardless of the files field
const ALWAYS_INCLUDED_RE = /^(readme|licen[sc]e)(\.|$)/i;

/**
 * Runs `mapper` over `items` with at most `concurrency` in flight at once.
 * @template T, R
 * @param {T[]} items
 * @param {(item: T) => Promise<R>} mapper
 * @param {number} concurrency
 * @returns {Promise<R[]>}
 */
async function mapWithConcurrency(items, mapper, concurrency) {
  const results = new Array(items.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await mapper(items[index]);
    }
  }
  await Promise.all(Array.from({length: Math.min(concurrency, items.length)}, worker));
  return results;
}

const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)(?:-(.+))?/;

/**
 * @param {string} version
 * @returns {{parts: number[], prerelease: string|null}|null}
 */
function parseVersion(version) {
  const match = VERSION_RE.exec(version);
  return match ? {parts: [+match[1], +match[2], +match[3]], prerelease: match[4] ?? null} : null;
}

/**
 * @param {{parts: number[], prerelease: string|null}} a
 * @param {{parts: number[], prerelease: string|null}} b
 * @returns {number} positive if `a` > `b`, per semver precedence (no prerelease beats any prerelease)
 */
function compareVersions(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a.parts[i] !== b.parts[i]) {
      return a.parts[i] - b.parts[i];
    }
  }
  if (a.prerelease === b.prerelease) {
    return 0;
  }
  if (a.prerelease === null || b.prerelease === null) {
    return a.prerelease === null ? 1 : -1;
  }
  return a.prerelease < b.prerelease ? -1 : 1;
}

/**
 * Highest of `versions` (all assumed valid `major.minor.patch(-prerelease)?` strings).
 * @param {string[]} versions
 * @returns {string|null}
 */
function maxVersion(versions) {
  let best = null;
  let bestParsed = null;
  for (const version of versions) {
    const parsed = parseVersion(version);
    if (parsed && (!bestParsed || compareVersions(parsed, bestParsed) > 0)) {
      best = version;
      bestParsed = parsed;
    }
  }
  return best;
}

/**
 * Resolves the exact version to pin a dependency to. The CI runner may not have installed it
 * (e.g. an optional dependency unsupported on this platform), so this falls back to asking the
 * registry for the highest version satisfying `range`, and to `range` itself as a last resort.
 * @param {string} name
 * @param {string} range
 * @returns {Promise<string>}
 */
async function resolveDependencyVersion(name, range) {
  try {
    const {version} = JSON.parse(await readFile(path.join(ROOT, 'node_modules', name, 'package.json'), 'utf8'));
    return version;
  } catch {}

  try {
    const {stdout} = await execFileAsync('npm', ['view', `${name}@${range}`, 'version', '--json']);
    const parsed = JSON.parse(stdout);
    const resolved = maxVersion(Array.isArray(parsed) ? parsed : [parsed]);
    if (resolved) {
      return resolved;
    }
  } catch {}

  console.warn(`Could not resolve a version of "${name}" satisfying "${range}", leaving as-is`);
  return range;
}

/**
 * Resets `.release-pkg` and copies everything a real `npm publish` from `ROOT` would pack:
 * the declared `files` entries plus the README, LICENSE, and "bin" targets npm always includes.
 * @param {Record<string, any>} pkg
 * @returns {Promise<void>}
 */
async function stageFiles(pkg) {
  await rm(STAGING_DIR, {recursive: true, force: true});
  await mkdir(STAGING_DIR, {recursive: true});

  // negated entries (e.g. "!scripts/ci") are for npm's own files-field packing logic, not paths to copy
  /** @type {string[]} */
  const fileEntries = pkg.files ?? [];
  for (const entry of fileEntries.filter((f) => !f.startsWith('!'))) {
    await cp(path.join(ROOT, entry), path.join(STAGING_DIR, entry), {recursive: true});
  }
  // README*/LICENSE* and "bin" entries are always packed by npm even if absent from files
  for (const name of (await readdir(ROOT)).filter((n) => ALWAYS_INCLUDED_RE.test(n))) {
    await cp(path.join(ROOT, name), path.join(STAGING_DIR, name), {recursive: true});
  }
  for (const binPath of Object.values(pkg.bin ?? {})) {
    await cp(path.join(ROOT, binPath), path.join(STAGING_DIR, binPath), {recursive: true});
  }
}

async function main() {
  const unbundledNames = new Set(process.argv.slice(2));
  const pkg = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8'));

  await stageFiles(pkg);

  // strip devDependencies/scripts - staging only ever gets a --omit=dev --omit=peer --ignore-scripts install
  const {devDependencies: _devDependencies, scripts: _scripts, ...stagedPkg} = pkg;
  stagedPkg.bundleDependencies = [
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.optionalDependencies ?? {}),
  ].filter((name) => !unbundledNames.has(name));

  // exact-pin every dependency, bundled or not: bundled ones are only enforced by npm's own
  // install, so this keeps the declared range accurate for other tooling (e.g. Yarn doesn't
  // fully honor bundleDependencies and may fall back to resolving the declared range itself)
  const depsToResolve = ['dependencies', 'optionalDependencies'].flatMap((depsField) =>
    Object.entries(pkg[depsField] ?? {}).map(([name, range]) => ({depsField, name, range})),
  );
  await mapWithConcurrency(
    depsToResolve,
    async ({depsField, name, range}) => {
      stagedPkg[depsField][name] = await resolveDependencyVersion(name, range);
    },
    RESOLVE_CONCURRENCY,
  );

  await writeFile(path.join(STAGING_DIR, 'package.json'), `${JSON.stringify(stagedPkg, null, 2)}\n`);

  await execFileAsync('npm', ['install', '--omit=dev', '--omit=peer', '--ignore-scripts'], {cwd: STAGING_DIR});
}

await main();
