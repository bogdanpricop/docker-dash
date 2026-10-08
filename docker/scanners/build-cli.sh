#!/bin/sh
set -eu
export CGO_ENABLED=0 GOTOOLCHAIN=local GOMAXPROCS=2 GOMEMLIMIT=2GiB
test "$(go env GOVERSION)" = 'go1.27.1'
module=github.com/docker/cli
version=v29.8.2+incompatible
mkdir -p /out
go mod download -json "$module@$version" > /out/docker-cli.source.json
actual=$(sed -n 's/^[[:space:]]*"Sum": "\([^"]*\)",*$/\1/p' /out/docker-cli.source.json)
test "$actual" = 'h1:2zgdFuoFst2T80oS42vhKGxkd0JRo305eIEKTsxR7pQ='
source_dir=$(sed -n 's/^[[:space:]]*"Dir": "\([^"]*\)",*$/\1/p' /out/docker-cli.source.json)
test -n "$source_dir"
rm -rf /tmp/docker-cli-source
cp -a "$source_dir" /tmp/docker-cli-source
cp go.mod go.sum /tmp/docker-cli-source/
cd /tmp/docker-cli-source
go mod verify
go build -mod=readonly -p 2 -trimpath -buildvcs=false \
  -ldflags '-s -w -X github.com/docker/cli/cli/version.Version=29.8.2+dd.2 -X github.com/docker/cli/cli/version.GitCommit=7fc2dff9bceb96b266a3b2c3117c0955a0d9e616' \
  -o /out/docker-cli ./cmd/docker
go list -mod=readonly -deps ./cmd/docker > /out/docker-cli.packages.txt
go version -m /out/docker-cli > /out/docker-cli.build-info.txt
cp LICENSE /out/docker-cli.LICENSE
cp go.mod /out/docker-cli.build.mod
(cd /out && sha256sum docker-cli > docker-cli.sha256)
