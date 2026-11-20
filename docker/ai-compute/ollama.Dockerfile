# Keep the official CUDA/llama-server libraries and rebuild only the Go server
# with reviewed security updates. The Docker daemon builds its own architecture.
FROM golang:1.27.4-bookworm@sha256:4fa7c968ba93f1635670522dbb01a2c78150443e1385746924566079f36570ea AS server
WORKDIR /src
ENV GOTOOLCHAIN=local GOMAXPROCS=4 CGO_ENABLED=1
RUN git clone --depth 1 --branch v0.40.16 https://github.com/ollama/ollama.git . \
    && test "$(git rev-parse HEAD)" = d63b702609c4300a2ca07be2bdb0adb9834725e5
RUN go mod edit -require=golang.org/x/net@v0.63.0 -require=golang.org/x/crypto@v0.59.0 \
    && go mod download \
    && go build -mod=mod -p 2 -trimpath -buildmode=pie \
       -ldflags="-w -s -X github.com/ollama/ollama/version.Version=0.40.16" -o /out/ollama .

FROM ollama/ollama@sha256:910d0d8107b538fb0894e63163eb195de0cc7aefcbc666dc62d3b18f71124592
USER root
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get -y upgrade \
    && apt-get install -y --no-install-recommends python3 ca-certificates \
    && dpkg --compare-versions "$(dpkg-query -W -f='${Version}' apt)" ge 2.8.4ubuntu0.1 \
    && rm -rf /var/lib/apt/lists/*
COPY --from=server /out/ollama /bin/ollama
ARG DOCKER_DASH_RECIPE_HASH
LABEL docker-dash.ai-compute.runtime="ollama-0.40.16-security1" \
      docker-dash.ai-compute.recipe="${DOCKER_DASH_RECIPE_HASH}" \
      org.opencontainers.image.source="https://github.com/bogdanpricop/docker-dash" \
      docker-dash.ai-compute.upstream-revision="d63b702609c4300a2ca07be2bdb0adb9834725e5"
