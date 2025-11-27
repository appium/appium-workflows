# appium-workflows
Shared GitHub Actions Workflows

## Workflows

### pr-title.yml
Validates PR titles against Conventional Commits format.

**Inputs:**
- `config-preset` (string, default: `angular`) - Conventional Commits preset

### node-lts-matrix.yml
Generates a matrix of Node.js LTS versions for testing.

**Inputs:**
- `output-type` (string, default: `lts`) - Version type: `lts`, `all`, or `current`

**Outputs:**
- `versions` - JSON array of Node.js versions

## Usage

```yaml
jobs:
  conventional-commits:
    uses: appium/appium-workflows/.github/workflows/pr-title.yml@main
```
