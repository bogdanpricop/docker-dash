#!/bin/sh
set -eu
export CGO_ENABLED=0 GOTOOLCHAIN=local GOMAXPROCS=2 GOMEMLIMIT=3GiB
test "$(go env GOVERSION)" = 'go1.27.1'
module=github.com/prometheus/prometheus
version=v0.314.0
mkdir -p /out/provenance
go mod download -json "$module@$version" > /out/provenance/source.json
actual=$(sed -n 's/^[[:space:]]*"Sum": "\([^"]*\)",*$/\1/p' /out/provenance/source.json)
test "$actual" = 'h1:YjsimqsIi6/mOtzZcrPEYUALO6zpfaht9O5sXqDz2vg='
test ! -e source
cp -R "$(go env GOPATH)/pkg/mod/$module@$version" source
# Keep the upstream UI, verified against both its release asset digest and
# sha256sums.txt. The source module does not include generated embedded assets.
wget -q -O /tmp/web-ui.tar.gz https://github.com/prometheus/prometheus/releases/download/v3.14.0/prometheus-web-ui-3.14.0.tar.gz
echo 'be18623c5891d32572998070de0d48522c966b737d9204aa41e0e88d6318e029  /tmp/web-ui.tar.gz' | sha256sum -c -
tar -xzf /tmp/web-ui.tar.gz -C source/web/ui
(cd source && bash scripts/compress_assets.sh)
go mod edit -replace "$module=./source"
go test -mod=readonly -p 1 google.golang.org/grpc/test -run 'Test/MissingAuthorityAndHostHeader' -count=1
# Serial package compilation bounds peak compiler memory for cloud SDKs.
flags='-s -w -X github.com/prometheus/common/version.Version=3.14.0+dd.1 -X github.com/prometheus/common/version.Revision=d7598b7141418fa35be2b5ec5d0fefb634199610 -X github.com/prometheus/common/version.Branch=v3.14.0-dependency-security-patch -X github.com/prometheus/common/version.BuildUser=docker-dash-security-build -X github.com/prometheus/common/version.BuildDate=20260920-00:00:00'
for binary in prometheus promtool; do
  go build -mod=readonly -p 1 -tags netgo,builtinassets -trimpath -buildvcs=false -ldflags "$flags" -o "/out/$binary" "$module/cmd/$binary"
  go version -m "/out/$binary" > "/out/provenance/$binary.build-info.txt"
  (cd /out && sha256sum "$binary" > "/out/provenance/$binary.sha256")
done
cp go.mod go.sum /out/provenance/
cp source/LICENSE source/NOTICE /out/provenance/
echo 'be18623c5891d32572998070de0d48522c966b737d9204aa41e0e88d6318e029  prometheus-web-ui-3.14.0.tar.gz' > /out/provenance/ui.sha256
