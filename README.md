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
- `unbundled-packages` (string, default: `''`) - Space-separated dependency names to exclude from
  bundling. `bundleDependencies` filtering only reaches direct dependencies, so an excluded
  package can still end up bundled as someone else's transitive dependency (a warning is printed
  when that happens); when that package also has platform-locked native siblings (e.g. sharp's
  `@img/sharp-*`), those siblings get deleted from every such transitively-bundled copy - keeping
  the package's own JS and `optionalDependencies` declaration intact so a normal `npm install`
  still fetches the right one - which is what actually shrinks the bundle in that case.
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

## Ruby Actions

### ruby-release-validate

Validates a prebuilt Ruby gem against `VERSION` / `DATE`, the root package in
`.release-please-manifest.json`, the latest `CHANGELOG.md` entry, and an optional
release tag. Checks the package name, version, integrity, and presence of the
version file. Supports historical and Release Please changelog headings and
RubyGems prerelease normalization (for example `1.2.0-rc.1` → `1.2.0.pre.rc.1`).

Install Ruby 3.1 or newer and build the gem in `pkg/` before calling the action.
It uses only Ruby standard/default libraries: no additional gem, Bundler setup,
or token is required by the validator itself. It does not build, tag, or publish.

| Input | Required | Description |
| --- | --- | --- |
| `gem-name` | Yes | Expected RubyGems name |
| `version-file` | Yes | Relative path to a file defining single-quoted `VERSION` and `DATE` constants |
| `working-directory` | No | Consumer repository root; defaults to `.` |
| `tag` | No | Exact `v<VERSION>` tag; omit for PR validation |

Output `gem-path` is the absolute path to the validated artifact. Validation
failure fails the step and emits no artifact output.

```yaml
- uses: actions/checkout@v7
- uses: ruby/setup-ruby@v1
  with:
    ruby-version: '4.0'
    bundler-cache: true
- run: bundle exec rake build
# Run the repository's tests here, before artifact validation/upload.
- uses: appium/appium-workflows/.github/actions/ruby-release-validate@main
  id: package
  with:
    gem-name: appium_console
    version-file: lib/appium_console/version.rb
    # For publication, pass the tag used to check out the source:
    # tag: ${{ inputs.tag }}
- uses: actions/upload-artifact@v4
  with:
    name: release-gem
    path: ${{ steps.package.outputs.gem-path }}
```

Consumers can pin the action to a reviewed commit SHA instead of `main`.
The consumer remains responsible for checking out the intended tag, checking its
ancestry, building/testing, and publishing the verified artifact. The publishing
workflow and OIDC permissions stay in the consumer repository, so its RubyGems
Trusted Publisher workflow filename and environment do not change.

| Repository | `gem-name` | `version-file` |
| --- | --- | --- |
| ruby_lib_core | appium_lib_core | lib/appium_lib_core/version.rb |
| ruby_lib | appium_lib | lib/appium_lib/version.rb |
| appium_capybara | appium_capybara | lib/appium_capybara/version.rb |
| ruby_console | appium_console | lib/appium_console/version.rb |

To migrate, replace the local `script/release.rb verify` step with this action,
update artifact references from `gem_path` to `gem-path`, and remove the duplicated
release helper, helper tests, and steps that run those tests. Keep each repository's
own tests, Release Please configuration, date annotation, and release runbook.
The validator's shared tests run in this repository.

For local checks, clone this repository and run the same script against a consumer:

```sh
ruby /path/to/appium-workflows/.github/actions/ruby-release-validate/release.rb \
  verify --root /path/to/ruby_console \
  --gem-name appium_console --version-file lib/appium_console/version.rb
```

Replace `verify` with `prepare-date` to copy the latest changelog date into the
version file for local recovery. This is an explicit local edit; normal releases
use Release Please's date annotation. Neither command pushes or publishes.
