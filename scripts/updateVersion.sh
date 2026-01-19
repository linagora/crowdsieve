#!/bin/bash
#
# updateVersion.sh - Update version in package.json files and Helm chart
#
# Updates version in:
#   - package.json
#   - dashboard/package.json
#   - helm/crowdsieve/Chart.yaml
#
# Only updates if there are changes since the last version tag.
#
# Usage:
#   ./scripts/updateVersion.sh [new_version]
#
# If new_version is not provided, it will auto-increment the patch version.
#

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Show help
show_help() {
  cat << EOF
Usage: $(basename "$0") [OPTIONS] [VERSION]

Update version in package.json, dashboard/package.json, and helm/crowdsieve/Chart.yaml.
Only updates if there are changes since the last version tag.

Options:
  -h, --help     Show this help message
  -f, --force    Force update even if no changes since last tag
  -n, --dry-run  Show what would be done without making changes

Arguments:
  VERSION        New version (e.g., 0.2.0 or v0.2.0). If not provided,
                 auto-increments the patch version (e.g., 0.1.5 -> 0.1.6)

Examples:
  $(basename "$0")           # Auto-increment patch: 0.1.5 -> 0.1.6
  $(basename "$0") 0.2.0     # Set specific version
  $(basename "$0") -n        # Dry run, show what would happen
  $(basename "$0") -f 1.0.0  # Force update to 1.0.0
EOF
}

# Parse options
FORCE=false
DRY_RUN=false
NEW_VERSION_ARG=""

while [[ $# -gt 0 ]]; do
  case $1 in
    -h|--help)
      show_help
      exit 0
      ;;
    -f|--force)
      FORCE=true
      shift
      ;;
    -n|--dry-run)
      DRY_RUN=true
      shift
      ;;
    -*)
      echo -e "${RED}Error: Unknown option $1${NC}"
      echo "Use --help for usage information"
      exit 1
      ;;
    *)
      NEW_VERSION_ARG="$1"
      shift
      ;;
  esac
done

# Get script directory and project root
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$PROJECT_ROOT"

# Get the latest version tag
LATEST_TAG=$(git tag --list 'v*' --sort=-v:refname | head -1)

if [ -z "$LATEST_TAG" ]; then
  echo -e "${YELLOW}No version tags found. Using v0.0.0 as baseline.${NC}"
  LATEST_TAG="v0.0.0"
fi

echo -e "Latest version tag: ${GREEN}$LATEST_TAG${NC}"

# Check if there are changes since the last tag
CHANGES=$(git log "$LATEST_TAG"..HEAD --oneline 2>/dev/null || echo "")

if [ -z "$CHANGES" ] && [ "$FORCE" = false ]; then
  echo -e "${YELLOW}No changes since $LATEST_TAG. Nothing to update.${NC}"
  echo -e "Use ${YELLOW}--force${NC} to update anyway."
  exit 0
fi

if [ -n "$CHANGES" ]; then
  echo -e "\n${GREEN}Changes since $LATEST_TAG:${NC}"
  echo "$CHANGES" | head -10
  CHANGE_COUNT=$(echo "$CHANGES" | wc -l)
  if [ "$CHANGE_COUNT" -gt 10 ]; then
    echo -e "${YELLOW}... and $((CHANGE_COUNT - 10)) more commits${NC}"
  fi
fi

# Extract current version (without 'v' prefix)
CURRENT_VERSION="${LATEST_TAG#v}"

# Parse version components
IFS='.' read -r MAJOR MINOR PATCH <<< "$CURRENT_VERSION"

# Determine new version
if [ -n "$NEW_VERSION_ARG" ]; then
  # Use provided version (strip 'v' prefix if present)
  NEW_VERSION="${NEW_VERSION_ARG#v}"

  # Validate version format (X.Y.Z)
  if ! [[ "$NEW_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    echo -e "${RED}Error: Invalid version format '$NEW_VERSION'${NC}"
    echo "Version must be in format X.Y.Z (e.g., 0.2.0)"
    exit 1
  fi
else
  # Auto-increment patch version
  NEW_PATCH=$((PATCH + 1))
  NEW_VERSION="$MAJOR.$MINOR.$NEW_PATCH"
fi

echo -e "\n${GREEN}Updating version: $CURRENT_VERSION -> $NEW_VERSION${NC}\n"

if [ "$DRY_RUN" = true ]; then
  echo -e "${YELLOW}[DRY RUN] Would update the following files:${NC}"
  echo "  - package.json"
  echo "  - dashboard/package.json"
  echo "  - helm/crowdsieve/Chart.yaml"
  exit 0
fi

# Function to update version in JSON files
update_json_version() {
  local file="$1"
  local version="$2"

  if [ ! -f "$file" ]; then
    echo -e "${RED}Error: $file not found${NC}"
    return 1
  fi

  # Use node for reliable JSON manipulation
  node -e "
    const fs = require('fs');
    const pkg = JSON.parse(fs.readFileSync('$file', 'utf8'));
    pkg.version = '$version';
    fs.writeFileSync('$file', JSON.stringify(pkg, null, 2) + '\n');
  "

  echo -e "  ${GREEN}✓${NC} Updated $file"
}

# Function to update version in Helm Chart.yaml
update_helm_version() {
  local file="$1"
  local version="$2"

  if [ ! -f "$file" ]; then
    echo -e "${RED}Error: $file not found${NC}"
    return 1
  fi

  # Update both version and appVersion to keep them in sync
  sed -i "s/^version: .*/version: $version/" "$file"
  sed -i "s/^appVersion: .*/appVersion: \"$version\"/" "$file"

  echo -e "  ${GREEN}✓${NC} Updated $file"
}

# Update all version files
echo "Updating version files..."
update_json_version "package.json" "$NEW_VERSION"
update_json_version "dashboard/package.json" "$NEW_VERSION"
update_helm_version "helm/crowdsieve/Chart.yaml" "$NEW_VERSION"

echo -e "\n${GREEN}Version updated to $NEW_VERSION${NC}"
echo -e "\nNext steps:"
echo -e "  1. Review changes: ${YELLOW}git diff${NC}"
echo -e "  2. Commit: ${YELLOW}git add -A && git commit -m \"Prepare v$NEW_VERSION\"${NC}"
echo -e "  3. Tag: ${YELLOW}git tag v$NEW_VERSION${NC}"
echo -e "  4. Push: ${YELLOW}git push && git push --tags${NC}"
