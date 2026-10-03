# Appium's Renovate Configuration

> Reusable [Renovate](https://www.mend.io) config for Appium and Appium-adjacent projects

## Usage

Modify your Renovate config file (`renovate.json`, etc.) to extend:

```json
"github>appium/appium-workflows//renovate/default"
```

For example, a JSON config should contain:

```json
{
  "extends": [
    "github>appium/appium-workflows//renovate/default"
  ]
}
```

If you already have a top-level `extends`, then append this to the list.

## Notes

> See the [Renovate docs](https://docs.renovatebot.com/) for more information on what does what.

## Why

Appium-the-project has many repos--not just this one!  We found ourselves duplicating most of this config across packages, so here's a reusable config.

Appium extension authors--or anyone else--may use this config as well.

### Presets in Use

- `config:recommended` - Renovate's recommended defaults (dependencies are not pinned)
- `group:definitelyTyped` - Groups all `@types/*` packages into one PR
- `security:minimumReleaseAgeNpm` - Delays updates for 3 days after they have been published to `npm`, protecting against supply chain attacks
  - Packages under the Appium organization are excluded from this
- `:automergeStableNonMajor` - Automatically merges "patch" and "minor" updates for semver stable (>=1.0.0) packages (assuming they pass CI)
- `:automergeDigest` - Automatically merges "digest" updates (assuming they pass CI)
- `:configMigration` - Automatically creates PRs for Renovate config file migration updates
- `:enableVulnerabilityAlerts` - For "security" purposes
- `:rebaseStalePrs` - Renovate will automatically rebase its PRs
- `:semanticCommits` - Renovate will use semantic commit messages
- `:semanticCommitTypeAll(chore)` - Renovate's PRs have the `chore` prefix in its semantic commit message
- `schedule:weekly` - Renovate runs once a week (before 4am on Monday), so consuming repos don't need their own schedule
  - Updates for packages under the Appium organization are excluded from this and can run at any time

### Additional Config

- Use the `update-lockfile` strategy instead of the default `auto`. In practice, the only difference is that peer dependency ranges are replaced rather than widened.

## License

Apache-2.0
