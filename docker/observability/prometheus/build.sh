#!/bin/sh
set -eu
export CGO_ENABLED=0 GOTOOLCHAIN=local GOMAXPROCS=2 GOMEMLIMIT=3GiB
test "$(go env GOVERSION)" = 'go1.27.1'
module=github.com/prometheus/prometheus
version=v0.315.0
mkdir -p /out/provenance
go mod download -json "$module@$version" > /out/provenance/source.json
actual=$(sed -n 's/^[[:space:]]*"Sum": "\([^"]*\)",*$/\1/p' /out/provenance/source.json)
test "$actual" = 'h1:sFGZWmC2Hk9N1NBJGCnXYZb5hyLCq8yuAMoEjLAg6ac='
test ! -e source
cp -R "$(go env GOPATH)/pkg/mod/$module@$version" source
# Keep the upstream UI, verified against both its release asset digest and
# sha256sums.txt. The source module does not include generated embedded assets.
wget -q -O /tmp/web-ui.tar.gz https://github.com/prometheus/prometheus/releases/download/v3.15.0/prometheus-web-ui-3.15.0.tar.gz
echo 'fa8c918ed05e3f89e232e9b69eccd6ed074602cd9e8a2cab7a92bec9651974ae  /tmp/web-ui.tar.gz' | sha256sum -c -
tar -xzf /tmp/web-ui.tar.gz -C source/web/ui
(cd source && bash scripts/compress_assets.sh)
go mod edit -replace "$module=./source"
go test -mod=readonly -p 1 google.golang.org/grpc/test -run 'Test/MissingAuthorityAndHostHeader' -count=1
# Serial package compilation bounds peak compiler memory for cloud SDKs.
flags='-s -w -X github.com/prometheus/common/version.Version=3.15.0+dd.4 -X github.com/prometheus/common/version.Revision=5241a27fe3c6983549fccc32f6e65917408c63cd -X github.com/prometheus/common/version.Branch=v3.15.0-dependency-and-busybox-security-patch -X github.com/prometheus/common/version.BuildUser=docker-dash-security-build -X github.com/prometheus/common/version.BuildDate=20260925-07:25:38'
for binary in prometheus promtool; do
  go build -mod=readonly -p 1 -tags netgo,builtinassets -trimpath -buildvcs=false -ldflags "$flags" -o "/out/$binary" "$module/cmd/$binary"
  go version -m "/out/$binary" > "/out/provenance/$binary.build-info.txt"
  (cd /out && sha256sum "$binary" > "/out/provenance/$binary.sha256")
done
cp go.mod go.sum /out/provenance/
cp source/LICENSE source/NOTICE /out/provenance/
echo 'fa8c918ed05e3f89e232e9b69eccd6ed074602cd9e8a2cab7a92bec9651974ae  prometheus-web-ui-3.15.0.tar.gz' > /out/provenance/ui.sha256
