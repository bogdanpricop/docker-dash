# CLI Transparency — "show me the command"

**Introduced:** v8.94.0
**Always on. No configuration.**

Destructive and bulk container actions show the equivalent `docker` command
before you confirm them, and the same command is recorded on the audit entry
afterwards.

The point is not to turn Docker Dash into a CLI. It is to stop being a black box:
a web UI that hides what it does asks you to trust it, and one that shows you the
command earns that instead.

---

## 1. Where it appears

| Surface | What you see |
|---------|--------------|
| Container **remove** confirmation | A collapsed `CLI equivalent` row with the `docker rm …` command and a copy button |
| Stack **bulk action** confirmation | One command line per affected container |
| Audit log | `details.cli` on container action, remove, rename and bulk entries |

The row is **collapsed by default** — an operator who doesn't care pays no extra
click. Start/stop/restart have no confirmation dialog and are unchanged; no
confirmation was added just to hang a preview off it.

## 2. What it will and won't render

Commands are derived from a fixed action table, never from a free-form string:

`container.start` · `stop` · `restart` · `pause` · `unpause` · `kill` · `remove` ·
`rename` · `bulk` · `run` · `image.pull` · `image.remove` · `volume.remove` ·
`network.remove` · `prune.*` · `stack.up` · `down` · `restart` · `pull`

An action outside this table is reported as having **no equivalent**. It is never
guessed. A subtly wrong command that an operator pastes into a production shell
is worse than no command at all, which is also why provider CLIs (`qm`, `govc`,
`xe`, `incus`) are deliberately out of scope for now — each has its own auth
model and flag semantics.

## 3. Safety properties

- **Shell-escaped.** Every argument is single-quoted unless it consists only of
  characters with no shell meaning. A container named `$(id)` or `a'; rm -rf /`
  renders as one inert argument. Tested against command substitution, chaining,
  newlines and quote break-out.
- **Secrets masked.** Environment and label values whose key matches the shared
  secret pattern render as `KEY=<redacted>`. The key stays visible — you need to
  know `DB_PASSWORD` is being set. The value is replaced outright, never hashed
  or truncated; a truncated secret is still a secret.
  The pattern is imported from `src/services/secret-reference-admission.js` rather
  than redefined, because two independently-maintained secret regexes drift, and
  the one that drifts is the one that leaks.
- **Redaction lives in the service**, not at the call sites, so every caller —
  UI preview and audit entry alike — inherits it.
- **No host flag.** The command is labelled *"as run on `<host>`"* instead of
  carrying `--host`. Pasting a command that silently targets the wrong machine
  because of your local Docker context is a failure mode worth designing out.

## 4. API

```
POST /api/cli-preview          { action, params } → { available, command, hostLabel, redacted, reason }
GET  /api/cli-preview/actions  → { actions: [...] }
```

`requireAuth` only — deriving a string changes no state, and gating it behind
`operator` would hide the explanation from exactly the viewers who most need it.
No `writeable`, no audit entry: nothing happened.

`POST` despite being read-only because the parameters are structured (bulk
subject arrays, full container definitions) and do not survive a query string
intact — the same reason GraphQL queries use POST. An unknown action key returns
`400`; a known action with unusable parameters returns `200` with
`available: false`.

## 5. Limitations

- Provider CLIs are not covered (see §2).
- There is no global "CLI mode" that annotates every page — v1 covers the two
  confirmations where the trust question actually gets asked.
- The reverse direction (paste a command, run it) is not part of this feature.
  `src/services/docker-run-parser.js` converts `docker run` into a Compose
  service for the Stacks converter; executing pasted commands is a different
  feature with a different threat model.
