#!/bin/sh
# Builds dist/<uuid>.shell-extension.zip, the file users install with
# `gnome-extensions install`.
set -eu
cd "$(dirname "$0")/.."
UUID=$(sed -n 's/^ *"uuid": "\(.*\)",$/\1/p' metadata.json)
rm -rf build dist
mkdir -p build/schemas dist
cp extension.js prefs.js model.js t3client.js stylesheet.css metadata.json LICENSE build/
cp schemas/*.gschema.xml build/schemas/
glib-compile-schemas --strict build/schemas
(cd build && zip -qr "../dist/$UUID.shell-extension.zip" .)
rm -rf build
echo "dist/$UUID.shell-extension.zip"
