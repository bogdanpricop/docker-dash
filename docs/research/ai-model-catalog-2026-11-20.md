# Reviewed model downloads and deployment recipes

Checked against the upstream model registries on 20 November 2026. Duplicate
Qwen2.5-VL requests produce one recipe. Model names, license links, exact revisions,
download sizes and successor links are recorded in the catalog. A newer generation
is a separate choice: it does not silently replace the requested model.

| Requested family | Retained recipe | Newer generation reviewed |
| --- | --- | --- |
| Qwen3.8 Flash Next | 125B A6B Q4_K_M, 120.1 GB | The MLX variant is for Apple hardware; it is not a Linux CUDA recipe |
| Nomic Embed Text | v1.5 | Nomic Embed Text v2 MoE |
| Granite 3.2 Vision | 2B | IBM Granite Vision 4.1 4B Q4_K_M, including its projector |
| Llama 3.2 Vision | 11B | Llama 4 Scout; Maverick exceeds this host's capacity |
| LLaVA | v1.6 | Latest tag in the requested Ollama family |
| MiniCPM-V | 2.6 / 8B | MiniCPM-V 4.6 / 1B |
| Moondream | Moondream 2 / 1.8B in Ollama | Official Moondream 3.1 / 9B A2B, download-only |
| Qwen2.5-VL | 7B | Qwen3-VL 8B and Qwen3.8 27B, separate recipes |

Sources: [Ollama library](https://ollama.com/library),
[Ollama 0.40.16](https://github.com/ollama/ollama/releases/tag/v0.40.16),
[IBM Granite Vision 4.1 GGUF](https://huggingface.co/ibm-granite/granite-vision-4.1-4b-GGUF),
[Moondream 3.1](https://huggingface.co/moondream/moondream3.1-9B-A2B),
[Photon local inference](https://docs.moondream.ai/running-locally/).

## What Download and Plan deploy do

Download requires an administrator-owned, host-scoped confirmation. It starts at
most a CPU-only cache service: no GPU, published ports, privileged mode or Docker
socket mount. Interrupted files are retained. Different model downloads can queue;
duplicate requests for the same model are rejected. The separate worker leaves
existing engine Stop/Start operations available during long downloads. Progress is
polled by the existing two-second operation feedback.

Ollama's multiarchitecture runtime is pinned by digest. Linux ARM64 and AMD64 are
checked before mutation. Native CLI commands use argument arrays, bounded output
and timeouts. No shell, arbitrary model import or client-provided URL is accepted.
The registry manifest is verified before a revision-specific alias is created.
Ollama 0.40 uses canonical `manifests-v2/ollama.com` aliases. Its legacy compatibility
manifest can contain an original-manifest provenance layer: this is accepted only
when the original blob's checksum and every serving layer/configuration match.

Plan deploy retains the existing preview, permission, policy, rollback and
container-identity checks. It downloads and verifies weights before stopping any
confirmed conflict. Inference runs as UID 1000 with a read-only cache/root filesystem,
dropped capabilities, bounded logs and a loopback host port. Cloud inference and
automatic model pruning are disabled. One resident model and one inference request
are allowed per managed Ollama service. Embedding profiles are not exclusive LLMs.
Readiness checks model residency; embedding warm-up also validates a finite vector.

Download presence does not mean a model is resident or that a particular workload
has been benchmarked. Memory/context and disk estimates remain explicit.

## Limits reproduced on the configured Spark

The host has about 121.7 GiB of unified memory. The 120.1 GB Flash Next Q4 recipe
requires a conservative 124 GiB budget plus the 4 GiB host reserve. Its files can
be downloaded, but deployment fails preflight on this host. Strata's smaller IQ3
variant remains an attributed experimental recipe requiring its own CUDA build
and qualification; an Apple MLX artifact is not substituted.

Moondream 3.1 weights and the Starmie tokenizer are pinned to Hugging Face commits
and individually checked by full SHA256, without loading repository Python code.
A temporary ARM64 Photon 2.6.1 / Kestrel 0.9.1 / kernels 0.7.4 qualification image
reused the existing pinned NVIDIA CUDA/PyTorch base. Startup on GB10 / SM121 failed
with `FP8_MOE_REQUIRES_COMPACT_CONFIG`: the official FP8 MoE implementation reported
that its padded compatibility runtime lacks a tuned compact/warpgemv configuration.
Kernels 0.7.5 retain that fail-closed path. No unqualified runtime is offered as
deployable. Moondream 2 remains independently available through Ollama.

Tests cover manifest provenance/tampering, read-only cache options, embedding
readiness, duplicate queues, download/Stop concurrency, stale recipe rejection,
host-scoped private catalog reads and browser download confirmation/progress.
Live smoke tests use temporary services and preserve the original production
container identities and running/stopped states.
