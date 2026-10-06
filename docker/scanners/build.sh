#!/bin/sh
set -eu

# Build as a dependency of the pinned build module, preserving the upstream
# module version/checksum in Go's binary metadata. Do not edit the module cache.
case "${1:-}" in
  grype)
    module=github.com/anchore/grype
    version=v0.120.1
    checksum='h1:kaO5Vudd1jmjFNYJoOro7AIg10cjrKAy71ZaOFdX0js='
    flags='-s -w -X main.version=0.120.1+dd.2 -X main.gitCommit=6f8d854af29d3a3086b11a84afa51554a2a245fe -X main.gitDescription=v0.120.1-dependency-security-patch'
    ;;
  trivy)
    module=github.com/aquasecurity/trivy
    version=v0.75.0
    checksum='h1:iOMkI0qX3Dfo+A6lznchBvtDD4ZSu+H9RBww1z5Qz58='
    flags='-s -w -X github.com/aquasecurity/trivy/pkg/version/app.ver=0.75.0+dd.2'
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
go mod verify
if [ "$1" = trivy ]; then
  # Trivy 0.75 includes the Go team's SkipFunc -> errors.ErrUnsupported
  # migration upstream, so no local source overlay is required.
  go test -mod=readonly -p 2 "$module/pkg/x/json" "$module/pkg/iac/scanners/cloudformation/parser"
  go test -mod=readonly -p 2 google.golang.org/grpc/test -run 'Test/MissingAuthorityAndHostHeader' -count=1
fi
go build -mod=readonly -p 2 -trimpath -buildvcs=false -ldflags "$flags" -o "/out/$1" "$module/cmd/$1"
go list -mod=readonly -deps "$module/cmd/$1" > "/out/$1.packages.txt"
go version -m "/out/$1" > "/out/$1.build-info.txt"
cp "$(go env GOPATH)/pkg/mod/$module@$version/LICENSE" "/out/$1.LICENSE"
(cd /out && sha256sum "$1" > "$1.sha256")
