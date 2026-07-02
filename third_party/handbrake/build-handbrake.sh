#!/usr/bin/env bash

set -euo pipefail

HANDBRAKE_VERSION="1.10.0"
HANDBRAKE_COMMIT="TODO"

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WORK_DIR="${ROOT_DIR}/.build/handbrake"
OUTPUT_DIR="${ROOT_DIR}/.build/output"

mkdir -p "${WORK_DIR}" "${OUTPUT_DIR}"

echo "Building HandBrakeCLI"
echo "Version: ${HANDBRAKE_VERSION}"
echo "Commit: ${HANDBRAKE_COMMIT}"
echo
echo "This script is a reproducibility scaffold only."
echo "The exact upstream revision, configure options, dependency versions and"
echo "patch status for the currently bundled binary are still TODO."
echo
echo "No build was started."
echo
echo "TODO:"
echo "1. Fetch the exact source revision."
echo "2. Verify the source revision."
echo "3. Apply patches from third_party/handbrake/patches/ if any exist."
echo "4. Configure the build with the exact hardware acceleration options."
echo "5. Build HandBrakeCLI without proprietary or license-incompatible components."
echo "6. Copy the result to OUTPUT_DIR."
echo "7. Print SHA-256 of the generated binary."

exit 1
