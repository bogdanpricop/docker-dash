#!/bin/sh
set -eu
export CGO_ENABLED=0 GOTOOLCHAIN=local GOMAXPROCS=2 GOMEMLIMIT=2GiB
test "$(go env GOVERSION)" = 'go1.27.1'
module=github.com/docker/cli
version=v29.7.2+incompatible
mkdir -p /out
go mod download -json "$module@$version" > /out/docker-cli.source.json
actual=$(sed -n 's/^[[:space:]]*"Sum": "\([^"]*\)",*$/\1/p' /out/docker-cli.source.json)
test "$actual" = 'h1:dlkwallR8XqfeVnA2ELEhdwvb4lsSwuB4IgsG8Q9cLY='
go build -mod=readonly -p 2 -trimpath -buildvcs=false \
  -ldflags '-s -w -X github.com/docker/cli/cli/version.Version=29.7.2+dd.1 -X github.com/docker/cli/cli/version.GitCommit=a7dcaa6fdb6ed04aacbfdc76357fdae01605609e' \
  -o /out/docker-cli "$module/cmd/docker"
go list -mod=readonly -deps "$module/cmd/docker" > /out/docker-cli.packages.txt
go version -m /out/docker-cli > /out/docker-cli.build-info.txt
cp "$(go env GOPATH)/pkg/mod/$module@$version/LICENSE" /out/docker-cli.LICENSE
(cd /out && sha256sum docker-cli > docker-cli.sha256)
