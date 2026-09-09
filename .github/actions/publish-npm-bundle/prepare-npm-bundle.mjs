#!/usr/bin/env node
/**
 * Stages a production-only, `bundleDependencies`-enabled copy of the package in the current
 * working directory into `.release-pkg/<BUNDLE_FILENAME>`, ready for `npm publish` - replacing
 * the pinning guarantee `npm-shrinkwrap.json` used to provide.
 *
 * Usage: UNBUNDLED_PACKAGES="name1 name2" BUNDLE_FILENAME="package.tgz" prepare-npm-bundle.mjs
 *
 * Every dependency (dependencies and optionalDependencies alike) gets exact-pinned to the
 * version actually resolved. On top of that, every dependency not named in UNBUNDLED_PACKAGES
 * also gets bundled (its resolved tree embedded verbatim in the tarball, taken from this
 * package's own already-installed node_modules - the same tree CI tested against, via
 * `npm pack` itself rather than a fresh re-resolving install). Named packages are excluded from
 * bundling, left for the consumer's own npm install to fetch that exact pinned version normally.
 * Use this for anything bundling would be wrong for - most commonly native/platform-specific
 * packages, where bundling would ship whatever binary the CI runner resolved for its own
 * OS/arch and break every other platform.
 *
 * Fails fast if an excluded package is unavoidably reachable as a transitive dependency of a
 * bundled one - npm would embed it anyway from that ancestor's own resolved tree, silently
 * defeating the exclusion.
 *
 * Dependency-free by design: this runs from wherever the action itself is checked out, not
 * from the calling repo's own node_modules, so it can't rely on packages like `asyncbox` or
 * `semver` being resolvable.
 */

import {execFile} from 'node:child_process';
import {mkdir, readFile, rename, rm, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {promisify} from 'node:util';

const RESOLVE_CONCURRENCY = 5;

const execFileAsync = promisify(execFile);
const ROOT = process.cwd();
const STAGING_DIR = path.join(ROOT, '.release-pkg');
const BUNDLE_FILENAME = process.env.BUNDLE_FILENAME || 'package.tgz';

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

/**
 * A parsed `major.minor.patch(-prerelease)?` semver string, comparable by precedence.
 */
class Version {
  static #RE = /^(\d+)\.(\d+)\.(\d+)(?:-(.+))?/;

  /**
   * @param {number[]} parts
   * @param {string|null} prerelease
   */
  constructor(parts, prerelease) {
    this.parts = parts;
    this.prerelease = prerelease;
  }

  /**
   * @param {string} version
   * @returns {Version|null}
   */
  static parse(version) {
    const match = Version.#RE.exec(version);
    return match ? new Version([+match[1], +match[2], +match[3]], match[4] ?? null) : null;
  }

  /**
   * @param {Version} other
   * @returns {number} positive if `this` > `other`, per semver precedence (no prerelease beats any prerelease)
   */
  compareTo(other) {
    for (let i = 0; i < 3; i++) {
      if (this.parts[i] !== other.parts[i]) {
        return this.parts[i] - other.parts[i];
      }
    }
    if (this.prerelease === other.prerelease) {
      return 0;
    }
    if (this.prerelease === null || other.prerelease === null) {
      return this.prerelease === null ? 1 : -1;
    }
    return Version.#comparePrerelease(this.prerelease, other.prerelease);
  }

  /**
   * Compares two dot-separated semver prerelease strings per semver precedence rules: identifiers
   * are compared field by field, numeric fields compare numerically and always sort below
   * alphanumeric fields, alphanumeric fields compare lexically, and a prerelease with more fields
   * outranks an otherwise-equal prefix with fewer.
   * @param {string} a
   * @param {string} b
   * @returns {number} positive if `a` > `b`
   */
  static #comparePrerelease(a, b) {
    if (a === b) {
      return 0;
    }
    const aParts = a.split('.');
    const bParts = b.split('.');
    for (let i = 0; i < Math.max(aParts.length, bParts.length); i++) {
      if (aParts[i] === undefined) {
        return -1;
      }
      if (bParts[i] === undefined) {
        return 1;
      }
      const aIsNum = /^\d+$/.test(aParts[i]);
      const bIsNum = /^\d+$/.test(bParts[i]);
      if (aIsNum && bIsNum) {
        const diff = Number(aParts[i]) - Number(bParts[i]);
        if (diff !== 0) {
          return diff;
        }
      } else if (aIsNum !== bIsNum) {
        return aIsNum ? -1 : 1;
      } else if (aParts[i] !== bParts[i]) {
        return aParts[i] < bParts[i] ? -1 : 1;
      }
    }
    return 0;
  }

  /**
   * Highest of `versions` (all assumed valid `major.minor.patch(-prerelease)?` strings).
   * @param {string[]} versions
   * @returns {string|null}
   */
  static max(versions) {
    let best = null;
    let bestParsed = null;
    for (const version of versions) {
      const parsed = Version.parse(version);
      if (parsed && (!bestParsed || parsed.compareTo(bestParsed) > 0)) {
        best = version;
        bestParsed = parsed;
      }
    }
    return best;
  }
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
    const resolved = Version.max(Array.isArray(parsed) ? parsed : [parsed]);
    if (resolved) {
      return resolved;
    }
  } catch {}

  console.warn(`Could not resolve a version of "${name}" satisfying "${range}", leaving as-is`);
  return range;
}

/**
 * The production dependency tree npm actually resolved into `ROOT/node_modules` (the same tree
 * CI tested against), as `npm ls --json` reports it. npm exits non-zero whenever anything in the
 * tree is missing or extraneous (e.g. an optional dependency unsupported on this platform), but
 * still emits a usable tree on stdout, so a failed exit is only fatal if stdout is empty.
 * @returns {Promise<Record<string, any>>}
 */
async function getInstalledDependencyGraph() {
  try {
    const {stdout} = await execFileAsync('npm', ['ls', '--all', '--omit=dev', '--omit=peer', '--json'], {
      cwd: ROOT,
    });
    return JSON.parse(stdout).dependencies ?? {};
  } catch (err) {
    if (err.stdout) {
      return JSON.parse(err.stdout).dependencies ?? {};
    }
    throw err;
  }
}

/**
 * All package names reachable (transitively) from `depsNode`, per `npm ls`'s nested
 * `dependencies` shape.
 * @param {Record<string, any>|undefined} depsNode
 * @param {Set<string>} [seen]
 * @returns {Set<string>}
 */
function collectTransitiveNames(depsNode, seen = new Set()) {
  for (const [name, info] of Object.entries(depsNode ?? {})) {
    if (seen.has(name)) {
      continue;
    }
    seen.add(name);
    collectTransitiveNames(info.dependencies, seen);
  }
  return seen;
}

/**
 * Rejects exclusions npm can't actually honor: if a bundled package transitively depends on an
 * excluded one, npm's packer will still embed it as part of the bundled package's own resolved
 * subtree, regardless of it being left out of `bundleDependencies`.
 * @param {string[]} bundledNames
 * @param {Set<string>} unbundledNames
 * @returns {Promise<void>}
 */
async function assertUnbundledDepsAreHonorable(bundledNames, unbundledNames) {
  if (unbundledNames.size === 0) {
    return;
  }
  const graph = await getInstalledDependencyGraph();
  for (const bundledName of bundledNames) {
    const transitiveNames = collectTransitiveNames(graph[bundledName]?.dependencies);
    for (const unbundledName of unbundledNames) {
      if (transitiveNames.has(unbundledName)) {
        throw new Error(
          `"${unbundledName}" is listed as an unbundled package, but bundled package "${bundledName}" ` +
            `transitively depends on it - npm would still embed it inside "${bundledName}"'s bundle, ` +
            `silently defeating the exclusion. Exclude "${bundledName}" too, or restructure the dependency.`,
        );
      }
    }
  }
}

/**
 * Packs `pkg` (the caller's package.json, already pinned and `bundleDependencies`-enabled) with
 * `npm pack`, so file selection and bundled-dependency embedding both come straight from npm's
 * own packer - reading `ROOT/node_modules` exactly as CI resolved it - instead of being
 * approximated here. The result is normalized to a fixed filename for the publish step.
 * @returns {Promise<void>}
 */
async function packBundle() {
  await rm(STAGING_DIR, {recursive: true, force: true});
  await mkdir(STAGING_DIR, {recursive: true});
  const {stdout} = await execFileAsync(
    'npm',
    ['pack', '--ignore-scripts', '--pack-destination', STAGING_DIR, '--json'],
    {cwd: ROOT},
  );
  const [{filename}] = JSON.parse(stdout);
  await rename(path.join(STAGING_DIR, filename), path.join(STAGING_DIR, BUNDLE_FILENAME));
}

async function main() {
  const unbundledNames = new Set((process.env.UNBUNDLED_PACKAGES ?? '').split(/\s+/).filter(Boolean));
  const originalPkgRaw = await readFile(path.join(ROOT, 'package.json'), 'utf8');
  const pkg = JSON.parse(originalPkgRaw);

  if (!Array.isArray(pkg.files) || pkg.files.length === 0) {
    throw new Error(
      'package.json must declare a non-empty "files" field - without it there is no reliable way to know ' +
        'what belongs in the published bundle',
    );
  }

  const bundledNames = [
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.optionalDependencies ?? {}),
  ].filter((name) => !unbundledNames.has(name));

  await assertUnbundledDepsAreHonorable(bundledNames, unbundledNames);

  // strip devDependencies/scripts - the published bundle only ever ships the production tree
  const {devDependencies: _devDependencies, scripts: _scripts, ...stagedPkg} = pkg;
  stagedPkg.bundleDependencies = bundledNames;

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

  // temporarily rewrite package.json so `npm pack` bundles from the caller's already-resolved
  // node_modules and applies its own "files" selection, then restore the original
  await writeFile(path.join(ROOT, 'package.json'), `${JSON.stringify(stagedPkg, null, 2)}\n`);
  try {
    await packBundle();
  } finally {
    await writeFile(path.join(ROOT, 'package.json'), originalPkgRaw);
  }
}

await main();
