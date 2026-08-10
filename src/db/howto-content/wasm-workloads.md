---
slug: wasm-workloads
title: Wasm workloads on Docker (alpha)
title_ro: Workload-uri Wasm pe Docker (alpha)
category: docker-dash
difficulty: advanced
icon: fas fa-microchip
summary: Detect WebAssembly runtimes registered in Docker and run Wasm containers alongside standard containers.
summary_ro: Detecteaza runtime-uri WebAssembly configurate in Docker si ruleaza containere Wasm alaturi de containere standard.
---

## What this is

Docker (via containerd) can run **WebAssembly modules as containers** by using an alternative OCI runtime — WasmEdge, wasmtime, wamr, spin, wasmer. The container image contains a `.wasm` module instead of a Linux binary; Docker hands it off to the wasm runtime at run time.

Docker Dash treats Wasm as a **first-class isolation class** as of v8.95.0. The System page groups the host's runtimes into Standard / Sandboxed / Wasm, a container backed by a Wasm runtime is labelled `WASM` on its detail page, and a Wasm image whose host has no Wasm runtime is flagged before you run it.

## Why this matters

- Wasm containers boot in **milliseconds** vs seconds for regular containers
- Sandboxing is stronger by default than runc (Wasm is a formal capability-based sandbox)
- Deployable at the edge with tiny images (< 10 MB for a full app)
- Language-portable: same `.wasm` module runs on x86, ARM, RISC-V

## Detection

`/api/system/info?hostId=<id>` returns:

```json
{
  "defaultRuntime": "runc",
  "runtimes": ["runc", "crun", "io.containerd.wasmedge.v1"],
  "alternativeRuntimes": ["crun", "io.containerd.wasmedge.v1"],
  "runtimeCategories": {
    "standard":  ["crun", "runc"],
    "sandboxed": [],
    "wasm":      ["io.containerd.wasmedge.v1"]
  }
}
```

The `runtimeCategories` field is new in v8.9.5-alpha.1. It's derived from a pattern match on the runtime name; the categories are:

| Category | Match | Example runtimes |
|---|---|---|
| **standard** | fallback | `runc`, `crun` |
| **sandboxed** | `kata`, `runsc`, `firecracker`, `nabla`, `youki` | Kata Containers, gVisor |
| **wasm** | `wasmedge`, `wasmtime`, `wamr`, `spin`, `wasmer`, `crun-wasm`, `wws` | WasmEdge, Fermyon Spin |

## Install a Wasm runtime on your Docker host

### WasmEdge (most common — CNCF sandbox project)

```bash
curl -sSf https://raw.githubusercontent.com/WasmEdge/WasmEdge/master/utils/install.sh | bash

# Install the containerd shim
wget https://github.com/containerd/runwasi/releases/latest/download/containerd-shim-wasmedge-v1-linux-amd64.tar.gz
tar -C /usr/local/bin -xzf containerd-shim-wasmedge-v1-linux-amd64.tar.gz

# Register in Docker daemon.json
sudo tee -a /etc/docker/daemon.json <<EOF
{
  "runtimes": {
    "io.containerd.wasmedge.v1": {
      "path": "/usr/local/bin/containerd-shim-wasmedge-v1"
    }
  }
}
EOF
sudo systemctl restart docker
```

### Fermyon Spin (HTTP-focused Wasm)

```bash
curl -fsSL https://developer.fermyon.com/downloads/install.sh | bash
sudo install -m 755 ./spin /usr/local/bin/spin
# containerd-shim-spin-v1 follows the same daemon.json registration pattern.
```

## Run a Wasm container

Pull a Wasm image from Docker Hub (Wasm-labelled):

```bash
docker run --rm --runtime=io.containerd.wasmedge.v1 \
  --platform=wasi/wasm \
  michaelirwin244/wasm-example
```

Docker Dash will list this container in the normal Containers view. The runtime field on the container detail page (v8.7.x+) shows the runtime used.

## Verify in Docker Dash

1. System page → Host card → **Runtimes** panel (built in v8.95.0; documented here since v8.9.5) shows three groups:
   - **Standard:** `runc`, `crun`
   - **Sandboxed:** whatever else Kata/gVisor/Firecracker you have
   - **Wasm:** `io.containerd.wasmedge.v1`, `spin`, etc.
2. If the Wasm group is empty, either the runtime isn't installed on that host or the pattern didn't match (please file a bug with the runtime name — the regex list is easy to extend)

## Security notes

- Wasm sandboxes have a **smaller trusted computing base** than a Linux kernel — the runtime + wasm-spec is ~thousands of lines vs the kernel's millions
- Capability-based: a Wasm module must be explicitly granted access to files, network, env vars (via WASI preopens). Default is nothing
- No syscalls at all — a Wasm module can't `fork()`, `ptrace()`, or open a raw socket without WASI granting permission

## What Docker Dash does and does not claim

- **No Deploy-Wasm-app wizard.** Launching stays a `docker run --runtime=...`, but the CLI-equivalent preview renders `--runtime` and `--platform` for you, which is where the usual `exec format error` comes from
- Categorization is pattern-based on the runtime NAME, anchored to the shim convention (`io.containerd.<name>.v1`) and word boundaries. It proves a runtime was *registered* under that name — not that the shim is installed or functional. Non-canonical names: file a bug and we'll extend the list
- **We report the runtime, never the grants.** A module's WASI preopens are not visible to Docker, so Docker Dash cannot tell you what a Wasm container was actually allowed to touch. A Wasm runtime with broad preopens is not automatically safe
- No Wasm-specific metrics (linear memory, module load time) — Docker does not expose them, and inventing them would be worse than omitting them
- Kubernetes selects Wasm through `RuntimeClass`, not `--runtime`. The isolation view is Docker/Podman only

## References

- [WasmEdge + Docker Desktop](https://wasmedge.org/docs/develop/deploy/docker/)
- [containerd Wasm shims (runwasi)](https://github.com/containerd/runwasi)
- [Fermyon Spin containerd shim](https://developer.fermyon.com/spin/v2/deploying-to-fermyon-cloud)
- [OCI runtime for Wasm — Bytecode Alliance guide](https://bytecodealliance.org/articles/announcing-webassembly-registry)
