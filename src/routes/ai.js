'use strict';

// AI Settings routes — v8.0.0
//
//   GET  /api/ai/settings          — read current config (key returned masked)
//   PUT  /api/ai/settings          — update config (audited, admin)
//   POST /api/ai/test              — test connectivity + auth (admin)
//   GET  /api/ai/providers         — static list of supported providers + models
//
// All admin-only. Settings → AI tab in the frontend consumes these.

const { Router } = require('express');
const asyncHandler = require('../utils/asyncHandler');
const { requireAuth, requireRole, writeable } = require('../middleware/auth');
const { getClientIp } = require('../utils/helpers');
const aiService = require('../services/ai');
const auditService = require('../services/audit');
const AnthropicProvider = require('../services/ai/providers/anthropic');
const OpenAiProvider = require('../services/ai/providers/openai');

const router = Router();

// Static catalog. Hardcoded — provider+model availability is operator-side
// concern; we just describe the shape they must conform to.
const PROVIDERS_CATALOG = [
  {
    id: 'anthropic',
    name: 'Anthropic Claude',
    requiresApiKey: true,
    requiresEndpoint: false,
    recommendedModel: AnthropicProvider.defaultModel,
    models: [
      { id: AnthropicProvider.defaultModel, label: 'Claude Haiku 5.5 — fast and economical', recommended: true },
      { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5 — balanced' },
      { id: 'claude-opus-5-5', label: 'Claude Opus 5.5 — complex reasoning' },
      { id: 'claude-fable-5-1', label: 'Claude Fable 5.1 — demanding reasoning' },
    ],
    apiKeyHelpUrl: 'https://console.anthropic.com/settings/keys',
    privacyNote: 'API inputs are not used to train models. Default 30-day caching; enterprise terms support zero retention.',
  },
  {
    id: 'openai',
    name: 'OpenAI',
    requiresApiKey: true,
    requiresEndpoint: false,
    recommendedModel: OpenAiProvider.defaultModel,
    models: [
      { id: OpenAiProvider.defaultModel, label: 'GPT-6 Luna — fast and economical', recommended: true },
      { id: 'gpt-6.1-terra', label: 'GPT-6.1 Terra — efficient reasoning' },
      { id: 'gpt-6.1-sol', label: 'GPT-6.1 Sol — balanced' },
      { id: 'gpt-6-astra', label: 'GPT-6 Astra — complex reasoning' },
    ],
    apiKeyHelpUrl: 'https://platform.openai.com/api-keys',
    privacyNote: 'API inputs are not used for training by default (since 2023). 30-day retention.',
  },
  {
    id: 'ollama',
    name: 'Ollama (local)',
    requiresApiKey: false,
    requiresEndpoint: true,
    endpointPlaceholder: 'http://localhost:11434',
    recommendedModel: 'qwen2.5-coder:7b',
    models: [
      { id: 'qwen2.5-coder:7b', label: 'Qwen 2.5 Coder 7B — recommended for 8GB+ RAM', recommended: true },
      { id: 'llama3.3', label: 'Llama 3.3 8B — general purpose' },
      { id: 'deepseek-r1:14b', label: 'DeepSeek R1 14B — needs 16GB+ RAM' },
    ],
    apiKeyHelpUrl: 'https://github.com/ollama/ollama#quickstart',
    privacyNote: '100% local — nothing leaves your network. Recommended for sovereignty-critical deployments.',
  },
];

router.use(requireAuth, requireRole('admin'));

router.get('/providers', asyncHandler((req, res) => {
  res.json(PROVIDERS_CATALOG);
}));

router.get('/settings', asyncHandler((req, res) => {
  res.json(aiService.getSettingsForApi());
}));

router.put('/settings', writeable, asyncHandler((req, res) => {
  const updates = req.body || {};
  // Allowed update fields. apiKey is special (undefined = leave alone, null = clear).
  const allowed = ['enabled', 'provider', 'model', 'apiKey', 'endpointUrl', 'customRedactionPatterns'];
  const filtered = {};
  for (const k of allowed) {
    if (k in updates) filtered[k] = updates[k];
  }
  try {
    aiService.saveSettings(filtered, req.user.id);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  auditService.log({
    userId: req.user.id, username: req.user.username,
    action: 'settings_update', targetType: 'ai-settings', targetId: 'global',
    details: {
      enabled: 'enabled' in filtered ? filtered.enabled : undefined,
      provider: filtered.provider,
      model: filtered.model,
      apiKeyChanged: 'apiKey' in filtered,
      patternCount: Array.isArray(filtered.customRedactionPatterns) ? filtered.customRedactionPatterns.length : undefined,
    },
    ip: getClientIp(req),
  });
  res.json(aiService.getSettingsForApi());
}));

router.post('/test', asyncHandler(async (req, res) => {
  // Test the CURRENTLY-SAVED config. If the operator wants to test a draft,
  // they save first then test. Keeps the contract simple and guarantees the
  // tested credentials are the ones that'll actually be used.
  const settings = aiService._internals._readSettings();
  if (!settings.provider) {
    return res.status(400).json({ error: 'No provider configured' });
  }
  // Build adapter directly (don't go through call() — we're testing connectivity,
  // not running a real prompt against the redactor + audit pipeline)
  let adapter;
  try {
    switch (settings.provider) {
      case 'anthropic': adapter = new AnthropicProvider(settings); break;
      case 'openai':    adapter = new OpenAiProvider(settings); break;
      case 'ollama':    adapter = new (require('../services/ai/providers/ollama'))(settings); break;
      default: return res.status(400).json({ error: `Unknown provider: ${settings.provider}` });
    }
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  const result = await adapter.test();
  res.json(result);
}));

module.exports = router;
