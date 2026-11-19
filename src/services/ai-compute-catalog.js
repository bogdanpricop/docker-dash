'use strict';

const GiB = 1024 ** 3;
const runtime = 'nvcr.io/nvidia/vllm:26.10.pre1-py3';
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

module.exports = { entries: [...standard, ...experimental], runtime, GiB };
