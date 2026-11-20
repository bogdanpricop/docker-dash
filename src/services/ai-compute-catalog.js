'use strict';

const GiB = 1024 ** 3;
const runtime = 'nvcr.io/nvidia/vllm:26.10.pre1-py3';
const ollamaRuntime = 'ollama/ollama@sha256:910d0d8107b538fb0894e63163eb195de0cc7aefcbc666dc62d3b18f71124592';
const standard = [
  ['qwen3-4b', 'Qwen/Qwen3-4B', '1cfa9a7208912126459214e8b04321603b3df60c', 20, 16],
  ['qwen3-8b', 'Qwen/Qwen3-8B', 'b968826d9c46dd6066d109eabc6255188de91218', 32, 26],
  ['qwen3-14b', 'Qwen/Qwen3-14B', '40c069824f4251a91eefaf281ebe4c544efd3e18', 48, 40],
].map(([id, model, revision, ram, disk]) => ({ id, model, revision, name: model.split('/')[1], engine: 'vllm',
  tier: 'standard', license: 'Apache-2.0', memoryBytes: ram * GiB, diskBytes: disk * GiB,
  runtime, contextLengths: [4096, 8192, 16384], source: 'https://huggingface.co/' + model, deployable: true }));
const experimental = [
  { id: 'strata-qwen38', name: 'Strata · Qwen3.8 Flash Next IQ3_XXS', engine: 'strata', model: 'Qwen3.8-Flash-Next',
    source: 'https://github.com/shi3z/Strata-DGX-Spark', memoryBytes: 56 * GiB, diskBytes: 85 * GiB,
    reason: 'The GB10 ARM64 fork needs a local CUDA build and reviewed weights. Register its container after qualification.' },
  { id: 'ncm-tinystories', name: 'NCM · TinyStories', engine: 'ncm', model: 'hazyresearch/ncm-checkpoints',
    source: 'https://github.com/HazyResearch/ncm', memoryBytes: null, diskBytes: null,
    reason: 'Research evaluation workload. Qualify the CUDA image, checkpoints and batch size before registering its container.' },
  { id: 'basalt', name: 'Basalt', engine: 'basalt', source: 'https://github.com/jesdga95/basalt',
    reason: 'The upstream x86-64 / SM120 build is not qualified for ARM64 / GB10.' },
].map(entry => ({ ...entry, tier: 'experimental', deployable: false }));

const photon = { id: 'photon-moondream31', name: 'Moondream 3.1 · 9B A2B', model: 'moondream/moondream3.1-9B-A2B',
  revision: '1da27e6c2d2f9118de14560df456881dc62d91f3', engine: 'photon', tier: 'experimental', capability: 'vision',
  runtime: 'nvcr.io/nvidia/vllm@sha256:cb38bbefdbc3e9fe045f931dd72cbd58cd48985c7e09916bcc6c15c10f39b929', runtimeVersion: 'Photon 2.6.1 / Kestrel 0.9.1 qualification', architectures: ['arm64'],
  source: 'https://huggingface.co/moondream/moondream3.1-9B-A2B', license: 'moondream-model-license-1.0', verifiedAt: '2026-11-20',
  memoryBytes: 24 * GiB, diskBytes: 12 * GiB, downloadBytes: 10508963782, contextLengths: [4096,8192], downloadable: true, deployable: false, supersedes: 'ollama-moondream',
  reason: 'Latest official Moondream weights can be downloaded. Deployment is unavailable: the official Photon FP8 MoE kernels failed qualification on DGX GB10 / SM121. The Ollama Moondream 2 recipe remains separate.',
  artifacts: [
    { repo: 'moondream/moondream3.1-9B-A2B', revision: '1da27e6c2d2f9118de14560df456881dc62d91f3', name: 'model.safetensors', sha256: '26dde16af961d3a486c7b86b9a34fc8487be7917f7e62324b751400ef4d391b4', bytes: 10505269576 },
    {"repo": "moondream/starmie-v1", "revision": "35192e10a54e36eabe0a7cc57a2c1aab371cafc5", "name": "tokenizer.json", "sha256": "0512fdcac4a5f9e7746cbefce4a468dc93bf0f93f11e701b84f8b31bff199e9c", "bytes": 3694206}
  ] };

const ollama = require('./ai-compute-ollama-catalog.json').map(entry => ({ ...entry, runtime: ollamaRuntime, runtimeVersion: '0.40.16', architectures: ['arm64', 'amd64'] }));

module.exports = { entries: [...standard, ...ollama, photon, ...experimental], runtime, ollamaRuntime, GiB };
