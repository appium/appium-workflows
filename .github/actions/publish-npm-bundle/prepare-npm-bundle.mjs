#!/usr/bin/env node
/**
 * Stages a production-only, `bundleDependencies`-enabled copy of the package in the current
 * working directory into `.release-pkg/<BUNDLE_FILENAME>`, ready for `npm publish` - replacing
 * the pinning guarantee `npm-shrinkwrap.json` used to provide.
 *
 * Usage: UNBUNDLED_PACKAGES="name1 name2" NATIVE_PLATFORMS="linux-x64 darwin-arm64"
 * BUNDLE_FILENAME="package.tgz" prepare-npm-bundle.mjs
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
 * Warns (without failing) if an excluded package is also reachable as a transitive dependency of
 * a bundled one - npm embeds it there too, from that ancestor's own resolved tree, alongside the
 * separate pinned copy the exclusion still leaves for the consumer's own install to fetch.
 *
 * If NATIVE_PLATFORMS lists any "os-cpu[-libc]" targets (e.g. "linux-x64 darwin-arm64
 * win32-x64"), every platform-locked optional dependency found anywhere in the resolved tree
 * (any package whose own package.json restricts installation via "os"/"cpu", npm's own
 * convention for per-platform native binary packages - sharp's `@img/sharp-*`, koffi's
 * `@koromix/koffi-*`, etc) gets its sibling package installed for each listed platform that
 * isn't already present, before bundling. Without this, a bundled package's native optional
 * dependency only ever contains the one binary the CI runner itself resolved - most consumers
 * are fine regardless (npm's own installer re-resolves a correct sibling for its own platform,
 * and packages built on `node-gyp-build`/`prebuildify` typically already ship every platform's
 * binary in one package), but bundling every requested platform up front removes the reliance on
 * that entirely, including for `--ignore-scripts` installs or package managers that don't hoist
 * the way npm does.
 *
 * The opposite pattern - a package that ships every platform's binary bundled together in one
 * `prebuilds/` directory (`node-gyp-build`/`prebuildify`'s own convention) - ships every platform
 * unconditionally, so whenever NATIVE_PLATFORMS is non-empty, every `prebuilds/<platform>`
 * subdirectory not matching the CI runner's own platform or a configured target also gets
 * deleted before bundling, trimming dead weight (e.g. iOS/Android prebuilds pulled in by an
 * unrelated dependency).
 *
 * Dependency-free by design: this runs from wherever the action itself is checked out, not
 * from the calling repo's own node_modules, so it can't rely on packages like `asyncbox` or
 * `semver` being resolvable.
 */

import {execFile} from 'node:child_process';
import {cp, mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {promisify} from 'node:util';

const RESOLVE_CONCURRENCY = 5;
// npm ls/pack --json emit one entry per file (including every bundled dependency's own files),
// easily exceeding execFile's default 1 MiB stdout buffer well before the tarball itself gets big
const EXEC_MAX_BUFFER = 200 * 1024 * 1024;

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
 * CI tested against), as `npm ls --long --json` reports it. `--long` adds each node's own
 * install `path` and its raw `_dependencies` map (its own declared `dependencies` and
 * `optionalDependencies`, merged - never `peerDependencies`), which is what npm's bundler
 * actually follows and what distinguishes same-named packages resolved to different versions at
 * different points in the tree. npm exits non-zero whenever anything in the tree is missing or
 * extraneous (e.g. an optional dependency unsupported on this platform), but still emits a usable
 * tree on stdout, so a failed exit is only fatal if stdout is empty.
 * @returns {Promise<Record<string, any>>}
 */
async function getInstalledDependencyGraph() {
  const args = ['ls', '--all', '--omit=dev', '--omit=peer', '--long', '--json'];
  try {
    const {stdout} = await execFileAsync('npm', args, {cwd: ROOT, maxBuffer: EXEC_MAX_BUFFER});
    return JSON.parse(stdout).dependencies ?? {};
  } catch (err) {
    if (err.stdout) {
      return JSON.parse(err.stdout).dependencies ?? {};
    }
    throw err;
  }
}

/**
 * All package names reachable (transitively) from `node` by real dependency edges alone. Each
 * `npm ls --long` node's `_dependencies` is the exact map of what that specific installed
 * instance declares - so a child only counts if its name is a key there, which both excludes
 * peer-only edges and, since `node` is a specific resolved instance rather than just a name,
 * correctly follows same-named dependencies resolved to different versions at different points
 * in the tree. `visitedPaths` (each instance's unique install path) guards against cycles
 * without conflating distinct instances the way de-duping by name alone would.
 * @param {Record<string, any>} node - an `npm ls --long --json` node
 * @param {Set<string>} [reachableNames]
 * @param {Set<string>} [visitedPaths]
 * @returns {Set<string>}
 */
function collectTransitiveNames(node, reachableNames = new Set(), visitedPaths = new Set()) {
  if (visitedPaths.has(node.path)) {
    return reachableNames;
  }
  visitedPaths.add(node.path);
  const ownDependencyNames = new Set(Object.keys(node._dependencies ?? {}));
  for (const [name, childNode] of Object.entries(node.dependencies ?? {})) {
    if (!ownDependencyNames.has(name)) {
      continue;
    }
    reachableNames.add(name);
    collectTransitiveNames(childNode, reachableNames, visitedPaths);
  }
  return reachableNames;
}

/**
 * Warns about exclusions npm can't fully honor: if a bundled package transitively depends on an
 * excluded one, npm's packer still embeds it as part of the bundled package's own resolved
 * subtree, regardless of it being left out of `bundleDependencies`. That's not necessarily wrong
 * for the caller - the excluded name still ends up pinned and installed normally at the top
 * level too - so this only warns rather than blocking the publish.
 * @param {Record<string, any>} graph
 * @param {string[]} bundledNames
 * @param {Set<string>} unbundledNames
 * @returns {Promise<void>}
 */
async function warnAboutUnhonorableExclusions(graph, bundledNames, unbundledNames) {
  if (unbundledNames.size === 0) {
    return;
  }
  for (const bundledName of bundledNames) {
    const node = graph[bundledName];
    if (!node) {
      continue;
    }
    const transitiveNames = collectTransitiveNames(node);
    for (const unbundledName of unbundledNames) {
      if (transitiveNames.has(unbundledName)) {
        console.warn(
          `"${unbundledName}" is listed as an unbundled package, but bundled package "${bundledName}" ` +
            `transitively depends on it - npm will still embed it inside "${bundledName}"'s bundle, ` +
            `alongside the separate pinned copy installed normally at the top level.`,
        );
      }
    }
  }
}

/**
 * Manages which platforms' native binaries end up in the bundle, for both ways npm packages ship
 * them: `inflate()` ensures every platform-locked optional dependency found anywhere in the
 * resolved tree (any package whose own package.json restricts installation via "os"/"cpu" - npm's
 * own convention for per-platform native binary packages, e.g. sharp's `@img/sharp-*` or koffi's
 * `@koromix/koffi-*`) has its sibling package installed for each requested target platform.
 * `trim()` handles the opposite pattern - packages like `bare-fs` that ship a `prebuilds/`
 * directory containing every supported platform's binary bundled together in one package - by
 * deleting whichever platform subdirectories aren't wanted.
 */
class NativePlatformManager {
  // "<prefix>-<os>-<cpu>[-<libc>]" is the convention nearly every per-platform native npm
  // package follows (sharp's `@img/sharp-linux-x64`, koffi's `@koromix/koffi-win32-arm64`, etc)
  // - matched against a package's basename (after any "@scope/") to tell which platform it
  // targets.
  static #SUFFIX_RE =
    /-(darwin|linux|win32|freebsd|openbsd|android)-(x64|arm64|ia32|arm|loong64|riscv64)(?:-(musl|glibc))?$/;

  /** @type {{os: string, cpu: string, libc: string|undefined}[]} */
  #targetPlatforms;

  /**
   * @param {string} rawTargetPlatforms - NATIVE_PLATFORMS env value: space-separated
   * "os-cpu[-libc]" entries, e.g. "linux-x64 linux-arm64-musl darwin-arm64"
   */
  constructor(rawTargetPlatforms) {
    this.#targetPlatforms = (rawTargetPlatforms ?? '')
      .split(/\s+/)
      .filter(Boolean)
      .map((entry) => {
        const [os, cpu, libc] = entry.split('-');
        return {os, cpu, libc};
      });
  }

  /**
   * @returns {boolean} whether any target platforms were configured
   */
  get isEnabled() {
    return this.#targetPlatforms.length > 0;
  }

  /**
   * The "<os>-<cpu>[-<libc>]" platform `name` targets, per the near-universal
   * "<prefix>-<os>-<cpu>[-<libc>]" naming convention for per-platform native binary packages -
   * or `null` if `name`'s basename doesn't match it.
   * @param {string} name
   * @returns {string|null}
   */
  static #platformSuffixOf(name) {
    const match = NativePlatformManager.#SUFFIX_RE.exec(name.split('/').pop());
    return match ? `${match[1]}-${match[2]}${match[3] ? `-${match[3]}` : ''}` : null;
  }

  /**
   * Every `optionalDependencies` entry, anywhere in `graph`, whose name matches one of this
   * instance's target platforms and isn't already installed at `ROOT/node_modules/<name>` -
   * these are the sharp/koffi-style per-platform sibling packages this driver's own CI runner
   * never had a reason to install. Returns a `name -> declared range` map, read from whichever
   * parent package (however deep in the tree) actually declares that optional dependency, so the
   * range is correct even for a platform variant nobody in this tree currently has installed.
   * @param {Record<string, any>} graph - an `npm ls --long --json` dependency graph
   * @returns {Promise<Map<string, string>>}
   */
  async #findMissing(graph) {
    const wantedSuffixes = new Set(
      this.#targetPlatforms.map(({os, cpu, libc}) => `${os}-${cpu}${libc ? `-${libc}` : ''}`),
    );
    const missing = new Map();
    const visitedPaths = new Set();

    const visit = async (node) => {
      if (visitedPaths.has(node.path)) {
        return;
      }
      visitedPaths.add(node.path);

      let ownPkg;
      try {
        ownPkg = JSON.parse(await readFile(path.join(node.path, 'package.json'), 'utf8'));
      } catch {
        ownPkg = {};
      }
      for (const [name, range] of Object.entries(ownPkg.optionalDependencies ?? {})) {
        const suffix = NativePlatformManager.#platformSuffixOf(name);
        if (!suffix || !wantedSuffixes.has(suffix) || missing.has(name)) {
          continue;
        }
        const isInstalled = await readFile(path.join(ROOT, 'node_modules', ...name.split('/'), 'package.json'))
          .then(() => true)
          .catch(() => false);
        if (!isInstalled) {
          missing.set(name, range);
        }
      }
      await Promise.all(Object.values(node.dependencies ?? {}).map(visit));
    };

    await Promise.all(Object.values(graph).map(visit));
    return missing;
  }

  /**
   * Installs `name@range` into an isolated scratch directory and copies the result into
   * `ROOT/node_modules/<name>`. Installing multiple platform-locked packages in the same
   * directory doesn't work - npm resolves one "ideal tree" per invocation and drops whatever
   * doesn't match the latest one requested - so each gets its own throwaway install directory.
   * `--force` is needed since this package's own "os"/"cpu" fields don't match the actual CI
   * runner; that's the entire point of naming an exact per-platform sibling package rather than
   * the platform-agnostic parent.
   * @param {string} name
   * @param {string} range
   * @returns {Promise<void>}
   */
  async #install(name, range) {
    const scratchDir = await mkdtemp(path.join(tmpdir(), 'native-platform-'));
    try {
      await writeFile(path.join(scratchDir, 'package.json'), JSON.stringify({name: 'scratch', version: '0.0.0'}));
      await execFileAsync(
        'npm',
        ['install', `${name}@${range}`, '--force', '--no-audit', '--no-fund'],
        {cwd: scratchDir, maxBuffer: EXEC_MAX_BUFFER},
      );
      const relativeSegments = name.split('/');
      const dest = path.join(ROOT, 'node_modules', ...relativeSegments);
      await rm(dest, {recursive: true, force: true});
      await mkdir(path.dirname(dest), {recursive: true});
      await cp(path.join(scratchDir, 'node_modules', ...relativeSegments), dest, {recursive: true});
    } catch (err) {
      console.warn(`Could not install native platform package "${name}@${range}", skipping: ${err.message}`);
    } finally {
      await rm(scratchDir, {recursive: true, force: true});
    }
  }

  /**
   * Installs every missing per-platform sibling package found in `graph` for this instance's
   * target platforms, so the bundle embeds every requested platform's native binary rather than
   * only the one the CI runner itself resolved. No-op if no target platforms were configured.
   * @param {Record<string, any>} graph
   * @returns {Promise<void>}
   */
  async inflate(graph) {
    if (!this.isEnabled) {
      return;
    }
    const missing = await this.#findMissing(graph);
    if (missing.size === 0) {
      return;
    }
    console.log(`Installing ${missing.size} missing native platform package(s): ${[...missing.keys()].join(', ')}`);
    await mapWithConcurrency(
      [...missing.entries()],
      ([name, range]) => this.#install(name, range),
      RESOLVE_CONCURRENCY,
    );
  }

  /**
   * Deletes every `prebuilds/<platform>` subdirectory, anywhere under `ROOT/node_modules`, that
   * isn't wanted - `node-gyp-build`/`prebuildify`'s own convention for bundling every supported
   * platform's binary together in one package (unlike sharp/koffi's one-package-per-platform
   * approach), meaning every install otherwise ships every platform's binary regardless of what's
   * actually wanted. The CI runner's own platform is always wanted, on top of whatever target
   * platforms were configured. No-op if no target platforms were configured at all - trimming
   * down to just the CI runner's own platform isn't something every caller wants by default.
   * @returns {Promise<void>}
   */
  async trim() {
    if (!this.isEnabled) {
      return;
    }
    const wantedNames = new Set([
      `${process.platform}-${process.arch}`,
      ...this.#targetPlatforms.map(({os, cpu}) => `${os}-${cpu}`),
    ]);
    /** @type {string[]} */
    const trimmed = [];

    const walk = async (dir) => {
      let entries;
      try {
        entries = await readdir(dir, {withFileTypes: true});
      } catch {
        return;
      }
      await mapWithConcurrency(
        entries.filter((entry) => entry.isDirectory()),
        async (entry) => {
          const entryPath = path.join(dir, entry.name);
          if (entry.name !== 'prebuilds') {
            await walk(entryPath);
            return;
          }
          // `dir` is the package's own directory (prebuilds's parent) - everything after the
          // innermost "node_modules/" segment is its name, scope included
          const packageName = dir.split(`${path.sep}node_modules${path.sep}`).pop();
          const platformDirs = await readdir(entryPath, {withFileTypes: true}).catch(() => []);
          await mapWithConcurrency(
            platformDirs.filter((platformDir) => platformDir.isDirectory() && !wantedNames.has(platformDir.name)),
            async (platformDir) => {
              await rm(path.join(entryPath, platformDir.name), {recursive: true, force: true});
              trimmed.push(`${packageName} (${platformDir.name})`);
            },
            RESOLVE_CONCURRENCY,
          );
        },
        RESOLVE_CONCURRENCY,
      );
    };

    await walk(path.join(ROOT, 'node_modules'));
    if (trimmed.length > 0) {
      console.log(`Trimmed ${trimmed.length} unwanted platform prebuild(s): ${trimmed.join(', ')}`);
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
    {cwd: ROOT, maxBuffer: EXEC_MAX_BUFFER},
  );
  const [{filename}] = JSON.parse(stdout);
  await rename(path.join(STAGING_DIR, filename), path.join(STAGING_DIR, BUNDLE_FILENAME));
}

async function main() {
  const unbundledNames = new Set((process.env.UNBUNDLED_PACKAGES ?? '').split(/\s+/).filter(Boolean));
  const nativePlatforms = new NativePlatformManager(process.env.NATIVE_PLATFORMS);
  const originalPkgRaw = await readFile(path.join(ROOT, 'package.json'), 'utf8');
  const pkg = JSON.parse(originalPkgRaw);

  const bundledNames = [
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.optionalDependencies ?? {}),
  ].filter((name) => !unbundledNames.has(name));

  if (unbundledNames.size > 0 || nativePlatforms.isEnabled) {
    const graph = await getInstalledDependencyGraph();
    await warnAboutUnhonorableExclusions(graph, bundledNames, unbundledNames);
    await nativePlatforms.inflate(graph);
    await nativePlatforms.trim();
  }

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
