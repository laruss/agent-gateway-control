#!/usr/bin/env bash
# Prints the patch release after <version>: the synthetic next release of the install test.
#
#   next-version.sh 0.1.0   # 0.1.1
set -euo pipefail
IFS=. read -r major minor patch <<<"${1:?version}"
echo "$major.$minor.$((patch + 1))"
