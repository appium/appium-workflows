# appium-workflows
Shared GitHub Actions Workflows

## Workflows

### socket-scan.yml
Socket.io security scanning with configurable failure on issues.

**Inputs:**
- `fail-on-issues` (boolean, default: `true`) - Fail workflow if security issues are found

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
  security-scan:
    uses: appium/appium-workflows/.github/workflows/socket-scan.yml@main
    with:
      fail-on-issues: true
```
