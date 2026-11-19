# DGX / AI Compute integration — implementation decisions

Scope imported from the conversation **“Semnificația NCM în IT”**: the first four stages (monitoring, existing workloads, profiles/switching, standard model recipes). Existing Docker host connections, pinned SSH identities, administrator authorization, operation policy, audit and background-job leadership are reused. The optional host agent and research benchmarking are later stages.

## Research and live inspection

* NVIDIA documents that GB10 has **unified CPU/GPU DRAM**, and `nvidia-smi` framebuffer-memory fields may be unsupported. RAM is measured through `/proc/meminfo`; unsupported GPU fields stay null. [Spark known issues](https://docs.nvidia.com/dgx/dgx-spark/known-issues.html).
* The configured LAN Spark is ARM64 with NVIDIA GB10 and approximately 121.7 GiB physical RAM. Its existing Qwen3-4B vLLM deployment uses `nvcr.io/nvidia/vllm:26.10.pre1-py3`, Triton attention and Docker GPU device requests with an empty driver. Requiring a named `nvidia` runtime would incorrectly reject this working host. [NVIDIA runtime GPU configuration](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/docker-specialized.html), [Spark vLLM recipe](https://build.nvidia.com/spark/vllm).
* The catalog reuses that runtime family. After pulling, the image architecture is checked and the new container uses the immutable local image ID. Qwen3 4B/8B/14B model and tokenizer revisions are pinned to the upstream model-card revisions inspected on 19 November 2026. These are standard **recipes**, not a claim that every model/context combination has been benchmarked on this host. Memory and download sizes are estimates; additional context increases the budget.
* [Qwen3-4B](https://huggingface.co/Qwen/Qwen3-4B), [Qwen3-8B](https://huggingface.co/Qwen/Qwen3-8B), [Qwen3-14B](https://huggingface.co/Qwen/Qwen3-14B) advertise Apache-2.0 licensing and safetensors weights. No arbitrary Hugging Face identifier or `trust-remote-code` is accepted by the deploy API.
* [shi3z/Strata-DGX-Spark](https://github.com/shi3z/Strata-DGX-Spark) is a GB10/ARM64 adaptation of the original Strata work. It requires a local CUDA build and separately reviewed weights; its published performance is upstream evidence, not a reproduced local benchmark. It is an attributed experimental catalog entry, not a fabricated one-click image.
* [HazyResearch/ncm](https://github.com/HazyResearch/ncm) provides research/evaluation scripts and [checkpoints](https://huggingface.co/hazyresearch/ncm-checkpoints), not an OpenAI-compatible inference server. Its existing checkout can be used for a later controlled research workload. It must not silently replace the working chat API.
* [jesdga95/basalt](https://github.com/jesdga95/basalt) targets x86-64 / SM120. It is not qualified as an ARM64 / SM121 Spark recipe.

## Operational behavior

* Viewing a host does not enable permanent polling. Explicit recording stores a sample per minute for 30 days. Charts retain missing-data gaps, show units and sample dates, and never invent historic data.
* Inventory distinguishes container state, Docker health and an explicitly checked model API. Engine names and selected model flags are extracted without exposing environment variables, credentials, bind sources or SSH configuration. Only detected AI workloads can become profiles.
* Starting, stopping, restarting, switching and deploying require a short-lived, administrator-owned preview. Per-host database locks prevent overlapping operations and interrupted jobs block new work until recovered. Container identity/configuration is rechecked before mutation.
* Switch stops only exclusive LLM conflicts listed in the preview, never speech APIs, speech engines, gateways or tunnels. Previous restart policies and full container identities are retained before changes. Their restart policy is disabled while stopped so they cannot unexpectedly reclaim RAM after a reboot. A failed launch stops the new candidate and restores previously running engines and their restart policies. No weights or prior containers are deleted.
* New standard workloads use a named model cache and loopback-only host ports, no host bind mounts, dropped capabilities, no-new-privileges and bounded Docker logs. Disk preflight measures the existing named cache volume's filesystem, or the Docker root filesystem before that volume exists, and fails closed if unavailable. GPU device access is intentionally required for inference.
* API probes use fixed Python code and container loopback only; no user-supplied URL, shell command or remote endpoint is executed. A non-empty model list is required. Engines without this API can use a configured Docker healthcheck, otherwise readiness remains unverified.
* No production engine is stopped merely to test this integration. Live validation reads real host telemetry and probes the existing model; failure/recovery paths are exercised in isolated automated tests.

## Deliberate remaining scope

An arbitrary-model importer, local Strata/NCM builds, research job queues, comparative throughput/quality benchmarks, GPU-specific alert rules and automatic switching of the global AI gateway need separate qualification. Existing Docker Dash AI triage/gateway settings remain available. A newly deployed recipe does not silently repoint global triage to a different model.
