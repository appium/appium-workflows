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
v12 removed shrinkwrap support ([appium/appium#22736](https://github.com/appium/appium/issues/22736)).
Every dependency not named in `pinned-packages` gets bundled (its resolved tree embedded
verbatim in the tarball); named ones are exact-pinned instead and left for the consumer's own
`npm install` to fetch - use this for anything bundling would be wrong for, most commonly
native/platform-specific packages (bundling would ship whatever binary the CI runner resolved
for its own OS/arch and break every other platform).

Run this as a step in the calling repo's own release job, after the package has been built and
any version bump has already happened - it operates on `package.json`/`node_modules` as they
currently exist in the checkout. The job must grant `permissions: id-token: write` for npm's
OIDC trusted publishing (composite actions can't request permissions beyond what the calling
job already has).

**Inputs:**
- `pinned-packages` (string, default: `''`) - Space-separated dependency names to exclude from bundling and exact-pin instead.

**Usage:**
```yaml
- uses: appium/appium-workflows/.github/actions/publish-npm-bundle@main
  if: env.PREV_VERSION != env.NEW_VERSION
  with:
    pinned-packages: koffi
```

## Usage

```yaml
jobs:
  conventional-commits:
    uses: appium/appium-workflows/.github/workflows/pr-title.yml@main
```
