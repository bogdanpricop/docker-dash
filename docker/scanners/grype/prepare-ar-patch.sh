#!/bin/sh
set -eu

# GO-2026-6905 has no fixed upstream release. Apply the guard to the verified
# source outside the Go module cache and test the exact replacement file.
module=github.com/blakesmith/ar
version=v0.0.0-20190502131153-809d4375e1fb
source_json=$(go mod download -json "$module@$version")
actual=$(printf '%s\n' "$source_json" | sed -n 's/^[[:space:]]*"Sum": "\([^"]*\)",*$/\1/p')
test "$actual" = 'h1:m935MPodAbYS46DG4pJSv7WO+VECIWUQ7OJYSoTrMh4='
module_dir=$(printf '%s\n' "$source_json" | sed -n 's/^[[:space:]]*"Dir": "\([^"]*\)",*$/\1/p')
test -f "$module_dir/reader.go"

patched=/tmp/dd-grype-ar
mkdir -p "$patched"
cp "$module_dir"/common.go "$module_dir"/reader.go "$module_dir"/writer.go "$patched/"
chmod u+w "$patched/reader.go"
patch -d "$patched" -p1 < /grype-patches/ar-negative-size.patch
cp /grype-patches/ar-negative-size_test.go "$patched/"
printf 'module %s\n\ngo 1.27.4\n' "$module" > "$patched/go.mod"
(cd "$patched" && go test -run '^TestNegativeMemberSize$' .)
cp go.mod "$1"
cp go.sum "${1%.mod}.sum"
go mod edit -modfile="$1" -replace="$module=$patched"
cp "$module_dir/COPYING" /out/grype-ar.LICENSE
sha256sum /grype-patches/ar-negative-size.patch > /out/grype-ar-patch.sha256
