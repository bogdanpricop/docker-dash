#!/bin/sh
set -eu

export GOTOOLCHAIN=local GOMAXPROCS=2 GOMEMLIMIT=4GiB CGO_ENABLED=1
test "$(go env GOVERSION)" = 'go1.27.1'
test "$(sed -n 's/.*\"version\": *\"\([^\"]*\)\".*/\1/p' package.json | head -1)" = '13.2.3'

mkdir -p /out/provenance
go mod verify
go test -mod=readonly -p 2 ./pkg/infra/tracing/...
go list -mod=readonly -deps ./pkg/cmd/grafana > /out/provenance/grafana.packages.txt
if grep -q '^golang.org/x/crypto/openpgp\(/\|$\)' /out/provenance/grafana.packages.txt; then
  echo 'The Grafana binary unexpectedly imports the deprecated OpenPGP implementation' >&2
  exit 1
fi

flags='-s -w -X main.version=13.2.3+dd.4 -X main.commit=6193dc03311b631b9727b560d24369e683dc396e -X main.buildBranch=v13.2.3-dependency-and-busybox-security-rebuild -X main.buildstamp=1790672464'
go build -mod=readonly -p 2 -trimpath -buildvcs=false -ldflags "$flags" \
  -o /out/grafana ./pkg/cmd/grafana
go version -m /out/grafana > /out/provenance/grafana.build-info.txt
(cd /out && sha256sum grafana > /out/provenance/grafana.sha256)
cp go.mod go.sum LICENSE NOTICE.md /out/provenance/
printf '%s\n' '6193dc03311b631b9727b560d24369e683dc396e' > /out/provenance/source-commit.txt
printf '%s  %s\n' \
  '8e31ab62f206cc2d4964373bf0c3502793210aba50a11cc3ff2f0db790cedab0' \
  'grafana-v13.2.3.tar.gz' > /out/provenance/source.sha256
