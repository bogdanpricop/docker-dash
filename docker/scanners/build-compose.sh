#!/bin/sh
set -eu
export CGO_ENABLED=0 GOTOOLCHAIN=local GOMAXPROCS=2 GOMEMLIMIT=2GiB
test "$(go env GOVERSION)" = 'go1.27.1'
module=github.com/docker/compose/v5
version=v5.5.1
mkdir -p /out
go mod download -json "$module@$version" > /out/docker-compose.source.json
actual=$(sed -n 's/^[[:space:]]*"Sum": "\([^"]*\)",*$/\1/p' /out/docker-compose.source.json)
test "$actual" = 'h1:saWlMxB0tfQ+FVUlWGIUjLvR0jF5cfTU18KI5zKLD/M='
# Exercise the upstream lifecycle/configuration tests with this exact dependency
# selection. The e2e build tag matches the official Linux release build.
go test -mod=readonly -p 2 -count=1 "$module/pkg/compose" "$module/pkg/api" "$module/cmd/compose"
go build -mod=readonly -p 2 -trimpath -buildvcs=false -tags e2e \
  -ldflags '-s -w -X github.com/docker/compose/v5/internal.Version=v5.5.1+dd.1' \
  -o /out/docker-compose "$module/cmd"
go list -mod=readonly -tags e2e -deps "$module/cmd" > /out/docker-compose.packages.txt
go version -m /out/docker-compose > /out/docker-compose.build-info.txt
cp "$(go env GOPATH)/pkg/mod/$module@$version/LICENSE" /out/docker-compose.LICENSE
cp go.mod /out/docker-compose.build.mod
(cd /out && sha256sum docker-compose > docker-compose.sha256)
