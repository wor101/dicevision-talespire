#!/usr/bin/env bash
# Package the symbiote for release.
#
#   scripts-dev/build-zip.sh v1.2.0     -> dist/DiceVision.zip
#
# TaleSpire wants manifest.json directly inside the zip's first folder, so the
# zip holds one DiceVision/ folder with the symbiote's files. The manifest's
# "version" is set from the tag (v1.2.0 -> 1.2.0). Unzip into TaleSpire's
# Symbiotes folder to install.
set -euo pipefail

tag="${1:?usage: build-zip.sh vX.Y.Z}"
version="${tag#v}"
if ! [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]]; then
  echo "not a version tag: $tag" >&2
  exit 1
fi

rm -rf dist
mkdir -p dist/DiceVision
# The symbiote's files only (no dev files such as icons/README.md)
cp -r symbiote/index.html symbiote/app.js symbiote/app.css symbiote/manifest.json symbiote/readme.md dist/DiceVision/
mkdir -p dist/DiceVision/icons
cp symbiote/icons/icon_64.png dist/DiceVision/icons/
cp LICENSE dist/DiceVision/

node -e '
  const fs = require("fs");
  const path = "dist/DiceVision/manifest.json";
  const manifest = JSON.parse(fs.readFileSync(path, "utf8"));
  manifest.version = process.argv[1];
  fs.writeFileSync(path, JSON.stringify(manifest, null, 2) + "\n");
' "$version"

(cd dist && zip -qr DiceVision.zip DiceVision)
echo "dist/DiceVision.zip ($version)"
