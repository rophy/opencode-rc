---
name: check-versions
description: Check which component versions need bumping after code changes
user_invocable: true
---

# Check Component Versions

Use this skill when determining which components need version bumps after code changes.

## Component Version Registry

| Component | Version source | Registry | CI workflow | Trigger paths |
|-----------|---------------|----------|-------------|---------------|
| **API** | `api/package.json` | ghcr.io docker image | `.github/workflows/api.yml` | `api/**`, `config/**`, `vendor/opencode-v1`, `vendor/opencode-v2` |
| **UI** | `ui/package.json` | ghcr.io docker image | `.github/workflows/ui.yml` | `ui/**`, `config/**`, `vendor/opencode-v1`, `vendor/opencode-v2`, `vendor/patches/**` |
| **Gateway** | `gateway/VERSION` | ghcr.io docker image | `.github/workflows/gateway.yml` | `gateway/**`, `config/opencode-versions.json` |
| **Helm** | `charts/opencode-rc/Chart.yaml` | ghcr.io OCI chart | `.github/workflows/helm.yml` | `charts/**` |
| **CLI** | `cli/package.json` | npm (`opencode-rc`) | `.github/workflows/cli.yml` | `cli/**` |
| **iOS** | `ui/ios/App/App.xcodeproj/project.pbxproj` (MARKETING_VERSION-CURRENT_PROJECT_VERSION) | `releases/ios` branch + `ios/<ver>` git tag | `.github/workflows/ios.yml` | same as UI |
| **Android** | `ui/android/app/build.gradle` (versionName-versionCode) | `releases/android` branch + `android/<ver>` git tag | `.github/workflows/android.yml` | same as UI |

## How CI publishing works

Each CI workflow checks if the current version is already published on the registry. If yes, it skips publishing. A version bump in the source file is required to trigger a new publish.

## Steps

1. **Identify changed paths** — check `git diff` or recent commits to see which directories changed.

2. **Check each component's published version:**
   ```bash
   # API
   cat api/package.json | grep '"version"'
   docker manifest inspect ghcr.io/<owner>/opencode-rc/api:<version> 2>/dev/null && echo "published" || echo "not published"

   # UI
   cat ui/package.json | grep '"version"'
   docker manifest inspect ghcr.io/<owner>/opencode-rc/ui:<version> 2>/dev/null && echo "published" || echo "not published"

   # Gateway
   cat gateway/VERSION
   docker manifest inspect ghcr.io/<owner>/opencode-rc/gateway:<version> 2>/dev/null && echo "published" || echo "not published"

   # Helm
   grep '^version:' charts/opencode-rc/Chart.yaml
   # Check ghcr.io for OCI chart

   # CLI
   cat cli/package.json | grep '"version"'
   npm view opencode-rc version

   # iOS
   grep -E 'MARKETING_VERSION|CURRENT_PROJECT_VERSION' ui/ios/App/App.xcodeproj/project.pbxproj | head -4
   git tag -l 'ios/*'

   # Android
   grep -E 'versionCode|versionName' ui/android/app/build.gradle
   git ls-remote --tags origin 'android/*'
   ```

3. **Determine bumps needed** — a component needs a bump when:
   - Its trigger paths have changes AND
   - Its current version is already published on the registry

4. **Important: Helm chart pins image tags** — `charts/opencode-rc/values.yaml` pins `api.image.tag`, `ui.image.tag`, and `gateway.image.tag`. When bumping api, ui, or gateway versions, also update the corresponding image tag in `values.yaml`, the image tags in the chart tests (`charts/opencode-rc/tests/*_deployment_test.yaml`) and the README's image table, and bump the chart version in `Chart.yaml`. The chart is a downstream consumer of api, ui, and gateway images.

5. **Present results as a table** with: component, current version, published version, whether changes exist, and whether a bump is needed. Include cascading bumps (e.g. api bump → chart bump).

6. **ALWAYS run `make unit-test` after making changes** — before pushing, run the full test suite to catch any test failures locally.
