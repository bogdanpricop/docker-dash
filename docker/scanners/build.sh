#!/bin/sh
set -eu

# Build as a dependency of the pinned build module, preserving the upstream
# module version/checksum in Go's binary metadata. Do not edit the module cache.
case "${1:-}" in
  grype)
    module=github.com/anchore/grype
    version=v0.119.0
    checksum='h1:I3HWCabq05m1fLyXPnwwD2GgG+8M/P2s9ylLX6lnA6w='
    flags='-s -w -X main.version=0.119.0+dd.1 -X main.gitCommit=b6f5194537747ee7f705f4113069ac9eb269919f -X main.gitDescription=v0.119.0-dependency-security-patch'
    ;;
  trivy)
    module=github.com/aquasecurity/trivy
    version=v0.74.0
    checksum='h1:B2/h1Aehsq/zykg0jxpWUlOX7e3UXpbxjZZs/0vNlC4='
    flags='-s -w -X github.com/aquasecurity/trivy/pkg/version/app.ver=0.74.0+dd.1'
    export GOEXPERIMENT=jsonv2
    ;;
  *) echo 'Expected scanner name: grype or trivy' >&2; exit 1 ;;
esac

export CGO_ENABLED=0 GOTOOLCHAIN=local
export GOMAXPROCS=2 GOMEMLIMIT=2GiB
test "$(go env GOVERSION)" = 'go1.27.1'
mkdir -p /out
go mod download -json "$module@$version" > "/out/$1.source.json"
actual=$(sed -n 's/^[[:space:]]*"Sum": "\([^"]*\)",*$/\1/p' "/out/$1.source.json")
test "$actual" = "$checksum"
overlay=''
if [ "$1" = trivy ]; then
  # Go forbids overlays over GOMODCACHE. Use an explicit local replacement of
  # a verified copy; the binary metadata will disclose this patched source.
  test ! -e source
  cp -R "$(go env GOPATH)/pkg/mod/$module@$version" source
  go run /trivy-json-compat.go "$PWD/source" /tmp/trivy-compat
  chmod u+w source/go.mod
  cp /tmp/trivy-compat/go.mod source/go.mod
  overlay=/tmp/trivy-compat/overlay.json
  cp /tmp/trivy-compat/json.go /out/trivy-json-compat.go.txt
  cp /tmp/trivy-compat/parameter.go /out/trivy-parameter-compat.go.txt
  cp /tmp/trivy-compat/go.mod /out/trivy-source.go.mod
  go test -overlay "$overlay" -mod=readonly -p 2 "$module/pkg/x/json" "$module/pkg/iac/scanners/cloudformation/parser"
  go test -mod=readonly -p 2 google.golang.org/grpc/test -run 'Test/MissingAuthorityAndHostHeader' -count=1
fi
go build -overlay "$overlay" -mod=readonly -p 2 -trimpath -buildvcs=false -ldflags "$flags" -o "/out/$1" "$module/cmd/$1"
go list -overlay "$overlay" -mod=readonly -deps "$module/cmd/$1" > "/out/$1.packages.txt"
go version -m "/out/$1" > "/out/$1.build-info.txt"
cp "$(go env GOPATH)/pkg/mod/$module@$version/LICENSE" "/out/$1.LICENSE"
(cd /out && sha256sum "$1" > "$1.sha256")
