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

### repo-graph-update.yml
Refreshes [repo-graph artifacts](https://github.com/James-Chahwan/repo-graph) when relevant source changes are detected and opens or updates a pull request with the generated graph data.

**Inputs:**
- `repo-root` (string, default: `.`) - Working directory for the workflow.
- `watch-paths` (string, default: `lib/**/*.ts`) - Newline-delimited globs that trigger the workflow.
- `branch-name` (string, default: `chore/update-repo-graph`) - Branch used for the graph PR.
- `pr-title` (string, default: `chore: update repo graph`) - PR title.
- `pr-body` (string, default: `Automated repo graph refresh generated from source changes.`) - PR body.

## Usage

```yaml
jobs:
  conventional-commits:
    uses: appium/appium-workflows/.github/workflows/pr-title.yml@main

  update-repo-graph:
    uses: appium/appium-workflows/.github/workflows/repo-graph-update.yml@main
    with:
      repo-root: .
      watch-paths: |
        lib/**/*.ts
        tests/**/*.ts
```
