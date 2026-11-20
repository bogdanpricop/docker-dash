# Specialist model catalog and information dialogs

Version 8.96.51 adds 14 informative specialist entries to the 21 existing catalog
entries. Every card opens an accessible information dialog with the proposed
problem/use case, integration requirements, a paraphrased source description,
limitations, licenses and attributed source links. No remote model-card HTML is
executed or fetched when a user opens the dialog.

The new entries are PaddleOCR-VL 1.6, Qwen3-Reranker 0.6B, Qwen3-Embedding 4B,
Qwen3-Coder-Next Q4, Chronos-2, EmbeddingGemma 2, TranslateGemma 12B,
GLiNER2 Large v1, OmniSQL 7B, SAM 3, FLUX.2 klein 4B, Z-Image-Turbo,
Qwen3-TTS 1.7B CustomVoice and the Romanian Piper Mihai medium voice.

These additions are catalog integrations, not claims of successful native model
serving. Each has explicit `integrationRequired`, `downloadable:false` and
`deployable:false` flags. Reviewed upstream repository commits are stored as
`sourceRevision`; they are deliberately separate from serving-artifact revisions,
runtime manifests and resource budgets. Existing qualified actions are retained.
No model files are downloaded, no remote code is executed and no inference
workload is started by this catalog extension. A forged plan request for these
entries is rejected by the backend as well as being absent from the UI.

Primary model cards and Hugging Face public API metadata were checked on
2026-11-20. Image-generation choices use the Apache-2.0 FLUX.2 klein 4B and
Z-Image-Turbo checkpoints. Source descriptions do not turn the authors' speed or
memory examples on other GPUs into DGX Spark performance guarantees.

The Qwen3-TTS CustomVoice model declares ten languages and predefined voices;
Romanian is not one of those languages. The separate Piper Romanian voice card
requires Piper 1.5+, its ONNX file and matching JSON configuration, identifies a
CC0 dataset and 22,050 Hz output. The voice repository declares MIT; the serving
runtime has a separate license. This work does not replace the existing speech
engine. SAM 3 and Gemma source access/license requirements remain visible.

All descriptions are plain text and rendered with escaping. Outbound source links
are restricted to HTTPS on the reviewed Hugging Face, Ollama and GitHub origins,
without embedded credentials or custom ports. Dialogs support keyboard activation,
Escape/Close and focus restoration after the catalog refreshes. Descriptions remain
available during an active model operation and do not submit jobs or change hosts.

Validation covers all catalog descriptions, source references, backend operation
rejection, every dialog, XSS/link schemes, keyboard focus and mobile layout.
