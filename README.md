# appium-workflows
Shared GitHub Actions Workflows

## Workflows

### pr-title.yml
Validates PR titles against the Conventional Commits format.

**Inputs:**
- `config-preset` (string, default: `angular`) - Deprecated compatibility input; the workflow validates the Conventional Commits spec directly.

### node-lts-matrix.yml
Generates a matrix of Node.js LTS versions for testing.

**Inputs:**
- `output-type` (string, default: `lts`) - Version type: `lts`, `all`, or `current`

**Outputs:**
- `versions` - JSON array of Node.js versions

## Actions

### publish-npm-bundle
Stages a production-only, `bundleDependencies`-enabled copy of the current npm package and
publishes it - replacing the pinning guarantee `npm-shrinkwrap.json` used to provide before npm
v12 removed shrinkwrap support entirely.
Every dependency is exact-pinned to the version actually resolved; on top of that, every
dependency not named in `unbundled-packages` also gets bundled (its resolved tree embedded
verbatim in the tarball). Named ones are left for the consumer's own `npm install` to fetch
that pinned version normally - use this for anything bundling would be wrong for, most commonly
native/platform-specific packages (bundling would ship whatever binary the CI runner resolved
for its own OS/arch and break every other platform).

Run this as a step in the calling repo's own release job, after the package has been built and
any version bump has already happened - it operates on `package.json`/`node_modules` as they
currently exist in the checkout. The job must grant `permissions: id-token: write` for npm's
OIDC trusted publishing (composite actions can't request permissions beyond what the calling
job already has).

**Inputs:**
- `unbundled-packages` (string, default: `''`) - Space-separated dependency names to exclude from bundling.
- `native-platforms` (string, default: `''`) - Space-separated `os-cpu[-libc]` targets (e.g.
  `linux-x64 linux-arm64 darwin-arm64 win32-x64`) to additionally embed a native
  binary for, on top of whatever the CI runner itself resolved. Applies to every platform-locked
  optional dependency anywhere in the resolved tree (any package whose own `package.json`
  restricts installation via `os`/`cpu` - npm's own convention for per-platform native binary
  packages, e.g. sharp's `@img/sharp-*` or koffi's `@koromix/koffi-*`), not just ones named in
  `unbundled-packages`. The opposite pattern - a package that ships every platform's binary
  bundled together in one `prebuilds/` directory (`node-gyp-build`/`prebuildify`'s own
  convention, e.g. `bare-fs`) - ships every platform unconditionally, so whenever this input is
  non-empty, any `prebuilds/<platform>` subdirectory not matching the CI runner's own platform or
  a configured target here also gets deleted before bundling, trimming otherwise-unavoidable dead
  weight (e.g. iOS/Android prebuilds pulled in by an unrelated dependency).

**Usage:**
```yaml
- uses: appium/appium-workflows/.github/actions/publish-npm-bundle@main
  if: env.PREV_VERSION != env.NEW_VERSION
  with:
    unbundled-packages: koffi
    native-platforms: linux-x64 linux-arm64 darwin-arm64 win32-x64
```

## Usage

```yaml
jobs:
  conventional-commits:
    uses: appium/appium-workflows/.github/workflows/pr-title.yml@main
```
