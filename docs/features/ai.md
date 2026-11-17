# AI Features — Setup, Usage, Privacy

**Introduced:** v8.0.0 (audit NL search). v8.1.0 + v8.2.0 add vulnerability triage and incident triage.
**Status:** Off by default. Bring your own API key (BYOK) or run a local Ollama instance.

Docker Dash's AI features translate noisy data into ranked, explainable decisions — and **never take actions on your behalf**. Every call is audited. Every payload is redacted before it leaves the host. You can disable the entire feature category with one toggle and verify zero outbound calls in `audit_log`.

If that one-sentence-to-defend matches your operational stance, this doc walks you through enabling it.

---

## 1. The 3-minute setup

```
1. Open Settings → AI tab (admin only)
2. Pick a provider:
   - Anthropic Claude (recommended for cloud — fast, cheap, good)
   - OpenAI GPT
   - Ollama (recommended for privacy — runs on your hardware)
3. For cloud providers: paste your API key
   For Ollama: paste the endpoint URL (default: http://localhost:11434)
4. Pick a model (recommended one is pre-selected)
5. Click "Test connection" → should turn green
6. Tick "Enable AI features" → Save
7. Try it: System → Audit → type "actions by admin in the last 24 hours" in the magic-wand search box
```

That's it. No account creation on our side. No telemetry. No data sent to us. Provider sees only the post-redaction prompt; we see only token counts in our own audit log.

---

## 2. Pick a provider — tradeoffs

### Anthropic Claude (cloud)
- **Recommended model:** `claude-haiku-4-5-20251001` ($1 / $5 per Mtok)
- **Cost example:** 100 NL audit searches/day at ~250 tokens each ≈ **$1/month**
- **Latency:** 0.5–2s per call
- **Privacy:** API inputs not used for training. 30-day default retention; zero-retention with enterprise terms.
- **Get a key:** https://console.anthropic.com/settings/keys

### OpenAI (cloud)
- **Recommended model:** `gpt-4o-mini` ($0.15 / $0.60 per Mtok)
- **Cost example:** 100 NL audit searches/day ≈ **$0.30/month**
- **Latency:** 0.5–2s per call
- **Privacy:** API inputs not used for training (since 2023). 30-day retention.
- **Get a key:** https://platform.openai.com/api-keys

### Ollama (local — recommended for privacy)
- **Recommended model:** `qwen2.5-coder:7b` (≈ 4-5 GB on disk, ≈ 6 GB RAM at runtime)
- **Cost:** $0 — your hardware does the work
- **Latency:** 1–10s on a Linux box with 8 GB RAM (CPU); sub-second on GPU
- **Privacy:** **Nothing leaves your network.** Best fit for sovereignty-critical deployments.
- **Setup:** [`ollama.ai/download`](https://ollama.ai/download) → `ollama pull qwen2.5-coder:7b` → `ollama serve` → paste `http://localhost:11434` in Docker Dash Settings

**If your host doesn't have GPU and you want chat-speed responses, pick a cloud provider.** For batch use (audit search runs in 1-3s and you can tolerate that), Ollama is great.

---

## 3. Privacy + security model

### DGX Spark Security Triage

The DGX profile in **Settings → AI** is independent of the provider used for audit search. Enter the internal gateway HTTPS origin, the model ID, the private CA certificate in PEM format, and the gateway key. Save the profile, use **Test DGX connection**, and enable analysis. The test checks the selected model in `GET /v1/models`. Docker Dash stores the key encrypted and displays only whether one is saved.

Use [Caddyfile.dgx](../../examples/deployments/Caddyfile.dgx) as the gateway configuration on the inference host. Leave vLLM on `127.0.0.1:8000`. Supply a server certificate whose SAN matches the gateway address, its private key, the intended Docker Dash source IP, and a generated gateway key. Keep the TLS private key and gateway key on their respective hosts. The listener allows authenticated Docker Dash requests to the model list and chat completion routes.

In **Security → Triage**, select a verified image and choose **Analyze with DGX**. Docker Dash loads the latest verified scan from each available scanner for that image and selected host. It sends up to 12 prioritized findings as bounded advisory facts. The model chooses verification steps from those allowed for each finding. Exact package versions, image identifiers, affected containers, and scanner evidence are combined locally in the proposal. Download the proposal from the results dialog for manual review. The audit log records the scan IDs, model, outcome and hash of the facts sent.

Select a Compose project and choose **Analyze stack with DGX** to review its running images and local remediation opportunities. The application generates a diff for a literal Compose image, or a simple Dockerfile with a verified pinned base. Candidate digests must be present on the same host and in the same release line. The comparison uses verified Trivy and Grype reports of the current and candidate image. Each report must be at most seven days old. The plan lists the scans, improvements and remaining policy blockers.

For local socket hosts, expose the relevant deployment files at their original paths with read-only mounts and include their project directories in \`DD_DGX_SOURCE_ROOTS\` (defaults to \`/opt/stacks\`). The planner requires a single Compose configuration file and a verifiable source image. Git-backed changes use the source repository. **Copy recommendations** copies the plan and diff. **Copy Linux commands** copies candidate preparation or, for an eligible Compose candidate with zero policy blockers, a separate operator-reviewed deployment script. Preparation validates a temporary copy or builds a candidate image.

### What leaves the host (when AI is enabled and a feature is invoked)

- The query/data for that specific call (after redaction — see §4)
- Provider/model identifier (in our local audit log)

### What NEVER leaves the host

- Container logs / inspect content (this release — v8.0.0 only ships NL audit search; future features have explicit redaction policies per feature)
- Stored secrets / registry credentials / encryption keys
- Audit log row content (queries are NL strings; results stay local — we filter rows in Node, not via the LLM)

### Off by default

When `enabled = 0` in `ai_settings` (the initial state after migration), the route handlers refuse to call the provider. The Settings page itself is the only AI surface — no other UI surface invokes AI.

### BYOK only

Docker Dash ships **zero API keys**. You bring your own (or point at your own Ollama). Keys are encrypted at rest using the same AES-GCM helper that protects registry credentials.

### Audit log

Every AI call writes a row to `audit_log` with `action = 'ai_call'`. Details include:
- `provider` (anthropic / openai / ollama)
- `model` (e.g. `claude-haiku-4-5-20251001`)
- `inputTokens`, `outputTokens`
- `durationMs`
- `redactions` (per-pattern count of what got stripped)
- `payloadHash` (SHA-256 of the **original** prompt, truncated to 8 hex)
- `ok: true | false`
- `error` (truncated, on failure)

**The `payloadHash` is the compliance gold.** If a compliance officer ever asks "did you send X to OpenAI?", you hash X locally and compare:

```bash
echo -n "the question" | sha256sum | cut -c1-8
# Compare against payloadHash values in audit_log
```

Privacy-preserving evidence trail without storing the actual prompt.

### Querying your AI usage

```sql
SELECT
  username,
  COUNT(*) as calls,
  SUM(CAST(json_extract(details, '$.inputTokens') AS INTEGER)) as input_tokens,
  SUM(CAST(json_extract(details, '$.outputTokens') AS INTEGER)) as output_tokens
FROM audit_log
WHERE action = 'ai_call'
GROUP BY username;
```

Or in the UI: System → Audit → search box: `actions by alice with action ai_call`.

---

## 4. The redactor — what it strips and what it doesn't

Docker Dash applies a defense-in-depth redactor BEFORE any payload reaches the provider. Validated on a hand-built corpus (see [`plans/spikes-ai-features.md`](../../plans/spikes-ai-features.md) S4): **100% recall, 100% precision** on 27 realistic test cases.

### Built-in patterns

| Pattern | Catches |
|--------|---------|
| `auth-bearer` | `Authorization: Bearer <token>` |
| `connection-string-creds` | `postgres://user:pass@host`, `redis://`, etc. (13 schemes) |
| `env-assignment` | `*PASSWORD*=val`, `*SECRET*=val`, `*TOKEN*=val`, `*API_KEY*=val`, `*ACCESS_KEY*=val`, `*PRIVATE_KEY*=val`, `*AUTH*=val` (with prefix/suffix tolerance like `STRIPE_SECRET_KEY`) |
| `long-token` | High-entropy strings ≥ 32 chars (UUIDs labeled distinctly) |
| `ipv4` | Dotted-quad IPs |
| `email` | Email addresses |

### Custom patterns

Settings → AI → "Custom redaction patterns" — one regex per line. For site-specific things (internal hostnames, project codenames, etc.). Built-in patterns are always active and can't be disabled.

### What the redactor does NOT do

- It's defense-in-depth, not a guarantee. The doc explicitly says so. The "what gets sent" preview lets you verify the post-redaction payload before any submit (Settings → AI → Privacy panel).
- It doesn't redact natural-language descriptions of secrets ("the password is hunter2" — the value isn't in env-style format).
- Invalid custom regex (catastrophic backtracking) **aborts the AI call** rather than sending unredacted. Privacy beats utility.

---

## 5. The features

### v8.0.0 — Audit log NL search

**Where:** System → Audit page → magic-wand search box at the top.

**Examples:**
- "show me everyone who deleted containers in the last 7 days"
- "who restarted the redis container yesterday"
- "all actions by alice this week"
- "failed registry pushes in the past hour"
- "any sandbox container created today"

**How it works:**
1. Your query goes through the redactor.
2. We send it to the configured provider with a strict JSON schema asking for: actor, action, resource, host, since, until, limit.
3. The provider returns a structured filter (validated against the schema — invalid responses are rejected).
4. We translate that filter to the existing audit query path. **Never NL→SQL** — the LLM only emits structured filter fields, never raw query text.
5. The parsed filter renders as chips above the result table so you see what the LLM understood. Click "Clear" to reset.

**Trust signals:** the provider name + latency + match count display next to the chips. If the LLM can't translate your query (gibberish, off-topic), it returns an empty filter and you see all-recent rows — never a confidently wrong filter.

### v8.1.0 (planned) — Vulnerability triage
Will rank scan results by real exploitability using EPSS data + LLM reasoning. Roadmap, not yet shipped.

### v8.2.0 (planned) — Incident triage
Container restart-loop detection → "Investigate" button on detail page → LLM-narrated diagnosis using inspect + logs + stats. Roadmap, not yet shipped.

---

## 6. Failure modes — what the user sees

| Failure | Behavior |
|---------|----------|
| Provider not configured | Search box is grayed out with "Enable AI in Settings" tooltip |
| Invalid API key | Toast: "AI provider rejected the API key. Re-enter in Settings → AI." Audit log records the failure. |
| Rate limit (429) | Toast with retry hint. Audit log records. |
| Timeout (15s default) | Toast. Operator can retry. |
| Malformed LLM response | Toast: "AI returned an unexpected response. Try rephrasing." Schema details NOT exposed to user. |
| LLM hallucinates filter | Schema validation drops invalid fields. Empty filter → empty result table → operator sees "no matches" implicitly. Never a confidently wrong filter. |
| Ollama unreachable | Connection error toast. |
| Custom redaction regex invalid | Save rejected with clear validation error before the bad pattern can fire. |

---

## 7. Programmatic API

```bash
# All endpoints require admin auth. $TOKEN = Bearer token from POST /api/auth/login.

# Read settings (key returned masked)
curl -H "Authorization: Bearer $TOKEN" http://docker-dash:8101/api/ai/settings

# Update settings
curl -X PUT -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"enabled":true,"provider":"ollama","model":"qwen2.5-coder:7b","endpointUrl":"http://localhost:11434"}' \
  http://docker-dash:8101/api/ai/settings

# Test the configured provider's connectivity + auth
curl -X POST -H "Authorization: Bearer $TOKEN" http://docker-dash:8101/api/ai/test

# List supported providers + recommended models (static catalog)
curl -H "Authorization: Bearer $TOKEN" http://docker-dash:8101/api/ai/providers

# Run NL audit search (the v8.0.0 feature)
curl -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"query":"who deleted containers last week"}' \
  http://docker-dash:8101/api/audit/ai-search
```

---

## 8. Costs (cloud providers, ballpark)

For audit NL search specifically, each call sends ~250 tokens of input (system prompt + query + today's date + 161-entry action enum) and gets back ~50 tokens of output (the JSON filter). Per-call cost:

| Provider/model | Per call | 100 calls/day |
|---|---|---|
| Claude Haiku 4.5 | $0.0005 | $1.50/mo |
| GPT-4o-mini | $0.0001 | $0.30/mo |
| Ollama (any model) | $0.00 | $0.00 |

Heavier features (vuln triage, incident triage) will burn more — but each will document its own cost profile when shipped.

---

## 9. Anti-features (we deliberately don't build these)

- **Always-on chat sidebar.** "Ask Docker Dash anything" is the most-mocked AI pattern of 2025. Engineers want answers in context, not a chat that needs to re-learn their setup every time.
- **Auto-remediation agent.** "AI fixes restart-looping containers automatically." Replit-class risk. We stay read-only.
- **AI-generated weekly summary emails.** Padding nobody reads.
- **NL → Compose generation in dashboard.** Operators edit existing Compose; Docker Desktop's Gordon does generation for dev workflows.
- **AI insights dashboard with predictive forecasting.** Single-host data is too small for meaningful prediction; wrong forecasts erode trust in everything else.

If a future feature request feels like one of these, it'll get a polite no with the rationale on the issue.

---

## 10. Disabling AI cleanly

Settings → AI → uncheck "Enable AI features" → Save. Done.

For complete teardown (e.g. you were testing and want to remove the API key from disk):

1. Settings → AI → "Clear" the API key
2. Save

The encrypted key is removed from `ai_settings`. No outbound calls possible until reconfigured.

For paranoid environments that want to prove AI is off:
```sql
SELECT * FROM ai_settings;
-- enabled = 0 + provider = NULL + api_key_encrypted = NULL → fully off
```

Or in CI: `DD_FORCE_AI_DISABLED=1` env var (planned for v8.1.0 if there's demand — file an issue if you need it now).

---

## See also

- [`plans/deep-spec-ai-features.md`](../../plans/deep-spec-ai-features.md) — full architectural rationale (local artifact)
- [`plans/spikes-ai-features.md`](../../plans/spikes-ai-features.md) — pre-implementation validation
- [`SECURITY.md`](../../SECURITY.md) — encryption details for stored credentials
- [`CHANGELOG.md`](../../CHANGELOG.md#800---2026-04-27--ai-features) — v8.0.0 release notes

### DGX operations

Security batch runs summarize the exact saved scan IDs from that run, rank affected images and link to scanner evidence. A failed or disabled DGX connection leaves the scan summary available and exposes a retry action.

Container details offer a redacted diagnostics preview of health commands, health results, restart/exit/OOM state, logs and recent events. The operator submits the preview for inference. Diagnostic findings cite the preview evidence and preserve collection warnings.

Successful image replacements and Compose deployments queue persisted security reviews when DGX is enabled. The worker compares immutable previous/current images with Trivy and Grype, retains scanner evidence and DGX advice, and requires manual review. The report does not perform a further deployment. Failed reviews support retry, and interrupted jobs are recovered.

Docker Hosts includes an on-demand DGX status dialog. GPU activity, temperature and unified memory come from the selected SSH host. Model availability and latency describe the gateway configured in Settings → AI. Unsupported metrics and gateway failures appear independently.
