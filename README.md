# omp-compress-studio

Compression studio + live traffic compression for [oh-my-pi](https://github.com/can1357/oh-my-pi) (omp).

Ported from the OmniRoute Compression Studio concepts to a native omp extension: every outgoing provider payload passes through selectable compression engines in a live session, and a full-screen TUI studio lets you dry-run engines, compare them A/B with an LLM fidelity judge, inspect live runs, and tune settings.

[![security](https://github.com/Xyzjesus/omp-compress-studio/actions/workflows/security.yml/badge.svg?branch=main)](https://github.com/Xyzjesus/omp-compress-studio/actions/workflows/security.yml)
[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/Xyzjesus/omp-compress-studio/badge)](https://scorecard.dev/viewer/?uri=github.com/Xyzjesus/omp-compress-studio)

Pipeline (`.github/workflows/security.yml`): zizmor (workflow-injection audit) + gitleaks (secrets across history) + Trivy (CVE/secret/misconfig, reads `bun.lock`) — green means clean. Scorecard badge appears after the first published run on `main` (`.github/workflows/scorecard.yml`, weekly + per-push).

## Install

The entry point is declared in `package.json` (`omp.extensions: ["./src/index.ts"]`). omp loads the TypeScript directly with Bun and remaps `@oh-my-pi/*` imports to host bundles — no build step. omp supports seven install mechanisms; the marketplace is the recommended one for normal use.

### Install via omp marketplace

This repo is its own marketplace: [`.omp-plugin/marketplace.json`](.omp-plugin/marketplace.json) catalogs the repo root itself (`source: "./"`).

```bash
# add the marketplace (GitHub shorthand; a local path, git URL, or direct catalog URL also work)
omp plugin marketplace add Xyzjesus/omp-compress-studio
# until the .omp-plugin/ catalog is pushed to the GitHub default branch, point at the checkout directly instead:
#   omp plugin marketplace add /path/to/omp-compress-studio

# browse what it offers
omp plugin discover omp-compress-studio

# preview (validates catalog + scope, writes nothing), then install
omp plugin install --dry-run omp-compress-studio@omp-compress-studio
omp plugin install omp-compress-studio@omp-compress-studio   # add --scope project for a project-local install
```

From a running session the same operations are slash commands: `/marketplace add Xyzjesus/omp-compress-studio`, then `/marketplace` (interactive plugin browser) or `/marketplace install omp-compress-studio@omp-compress-studio`.

Two routing rules: `name@marketplace` is treated as a marketplace reference only after its marketplace is added — before that omp classifies it as an npm spec and `install` goes to the npm registry. And `--scope`/`--force` apply to marketplace installs only; npm/git/link installs warn and ignore them. `omp install <target>` is a top-level alias for `omp plugin install` / `omp plugin link`.

- **Scopes** — `user` (default) writes `~/.omp/plugins/installed_plugins.json` and is available in every project; `project` writes `<project>/.omp/plugins/installed_plugins.json` (anchored at the nearest `.omp/` or git root), and an enabled project copy shadows the user copy of the same plugin.
- **On disk** — `~/.omp/marketplaces.json` (marketplace registry), `~/.omp/plugins/cache/plugins/<marketplace>___<plugin>___<version>/` (versioned cache; both scopes share it), a symlink from the scope's `plugins/node_modules/`, and enable/feature/settings state in `omp-plugins.lock.json`.
- **Dependencies** — marketplace install copies the plugin tree verbatim into the cache. A local-directory marketplace (`omp plugin marketplace add /path/to/omp-compress-studio`) carries this repo's `node_modules` along; a GitHub-sourced install caches a clean clone without dependencies — run `bun install` once inside the cached plugin dir, or use the git-spec install below, which materializes npm dependencies.
- **Lifecycle** — `omp plugin marketplace update omp-compress-studio` re-fetches the catalog, `omp plugin upgrade omp-compress-studio@omp-compress-studio` reinstalls the newest catalog version (reinstall preserves disable state, feature selection, and settings), `omp plugin disable/uninstall omp-compress-studio@omp-compress-studio` to turn off or remove.

Extension modules load at session start: after install/upgrade, restart the session. (`/reload-plugins` refreshes skills, slash commands, and MCP servers, but not extension modules.)

### All install mechanisms

| Mechanism | How | Scope | Notes |
|---|---|---|---|
| Marketplace | `omp plugin install omp-compress-studio@omp-compress-studio` | user / project | versioned cache, per-scope enable/disable/upgrade, install validation with `--dry-run` |
| Git/npm package | `omp plugin install github:Xyzjesus/omp-compress-studio` | user | real `bun install` into `~/.omp/plugins` (git dependencies get their npm dependencies materialized); `omp plugin upgrade omp-compress-studio` re-resolves the ref |
| Dev link | `omp plugin link /path/to/omp-compress-studio` | user | symlink into `~/.omp/plugins/node_modules/`; repo edits are picked up at the next session start, no reinstall |
| User extensions dir | `ln -s $PWD ~/.omp/agent/extensions/omp-compress-studio` | user | auto-discovered at startup |
| Project extensions dir | `ln -s $PWD .omp/extensions/omp-compress-studio` | project | `<cwd>/.omp/extensions` only — no ancestor walk |
| Settings list | `extensions: [~/Apps/omp-compress-studio]` in `~/.omp/agent/config.yml` or `<project>/.omp/settings.json` | user / project | settings layers replace the array rather than concatenate |
| One-shot | `omp -e /path/to/omp-compress-studio` | session | `--trusted-extension <file>` loads only the named module files instead |

Load order: native auto-discovery (project `.omp/extensions`, then `~/.omp/agent/extensions`) → installed plugin entries → explicit `-e`/settings paths; duplicates load once at the first position. `--no-extensions` drops ambient discovery (explicit `-e` still loads). Per-plugin management: `omp plugin list`, `omp plugin enable/disable <name>`, `omp plugin features --enable=<f>`, `omp plugin config --set key=value`, `omp plugin doctor [--fix]`.

### Development

`check`/`test` expects an oh-my-pi checkout next to this one (`../oh-my-pi`); tsconfig `paths` resolve host packages to its sources.

```bash
bun install
bun run check   # tsc --noEmit
bun test
```

## Usage

| Command | Effect |
|---|---|
| `/compress-studio` | Opens the studio overlay (Play / Compare / Live / Settings tabs) |
| `/compress-studio on` | Enables live compression, installs the stats widget |
| `/compress-studio off` | Disables live compression, removes the widget |
| `/compress-studio status` | Session totals notification |

Live compression is **off by default**.

### Studio

- **Play** — paste text, toggle lanes (`1..5`, `*` = all/none), gates (`f` fidelity, `d` fuzzy-dedup, `g` risk, `l` quantum), `m` heatmap mode, `Ctrl+R` runs per-lane + combined pipeline with waterfall, step diff, encoder comparison (JSON vs omni-tabular vs TOON), and a heatmap preview. `space`/`Backspace`/`,`.` replay the waterfall.
- **Compare** — `Ctrl+R` runs all lanes on the shared Play text; `Ctrl+V` verifies compressed outputs with the LLM judge (`Ctrl+M` sets the judge model); `E` runs the recovery eval — the judge model lists the facts it can still extract from each compressed output and the original's critical needles (URLs, versions, paths, identifiers) are scored against that answer (`recall %`, LongLLMLingua-`recover()` style downstream check, shared USD cap).
- **Live** — recent live runs with waterfall + replay; `Ctrl+E` toggles compression.
- **Settings** — per-engine toggles, strategy preset, caveman intensity, gates, heatmap default, judge cost cap, judge model, debug logging. Every change saves to `~/.omp/agent/compress-studio/config.json`.

### Strategies are presets

The runtime truth is the per-engine switches (`dedup`, `rtk`, `truncate`, `caveman`, `sessionDedup` + intensity). A strategy preset is a one-shot writer for those switches:

| Preset | Scenario | Engines written |
|---|---|---|
| `off` | — | none + sets live compression to `enabled: false` |
| `interactive` (default) | Warm live session: prefix-cache is sacred — every rewrite must amortize its invalidation | sessionDedup, truncate (lossless + deterministic stages only) |
| `lite` | Prose-only touch-up | caveman@lite |
| `standard` | Prose-only touch-up, stronger | caveman@full |
| `aggressive` | Cold payloads, one-shot tasks | rtk, caveman@full |
| `ultra` | Window pressure: context near the limit | dedup, rtk, truncate, caveman@ultra, sessionDedup, clear |
| `rtk` | Command-output heavy | rtk |
| `stacked` | Cold payloads: maximal savings, cache cost acceptable | dedup, rtk, truncate, caveman@full, sessionDedup |
| `omniroute` | OmniRoute "Standard Savings" parity | sessionDedup, truncate (lossless dedup + semantics-first truncation — only normalized repeats and trivial filler are dropped) |

The live pipeline applies the enabled engines in stack order (dedup → rtk → truncate → caveman). Before the per-block lanes, `sessionDedup` runs a payload-level pass: repeated tool/user blocks (≥80 chars, ≥3 lines) keep only their first verbatim copy, later occurrences collapse to `[dedup:ref sha=…]` markers (lossless). The truncate engine is semantics-first: a line is dropped only when it is trivial filler or a normalized repeat of an earlier line (digits collapse, so counter-driven log spam packs down); the first occurrence of every distinct line always survives and unbounded unique content is deliberately not cut. Current-turn blocks (after the last assistant message) are exempt from the per-block lanes. The **newest user message and the system prompt are never touched**.

Three research-driven additions (see `docs/research-semantic-compression.md`):

- **Block memoization** — compression decisions are cached by block hash + engine config; a repeated block is compressed once per process and reproduced byte-identically (repeat requests measured ~19× faster CPU-side, and the compressed prefix stays prompt-cache stable).
- **Clear stage** (`engines.clear`, on in the `ultra` preset) — Anthropic-style tool-result clearing: past `clearTriggerTokens` (default 100k) the oldest tool results beyond `clearKeep` (default 3, current turn always exempt) collapse to a readable `[cleared: … ~N tok removed]` placeholder.
- **Cache telemetry** — `message_end` usage (`cacheRead`/`cacheWrite`) is accumulated and shown in the widget (`cache N% hit · read … · write …`), making compression's cache-invalidation cost visible next to its savings.
Supported payload APIs: `anthropic-messages`, `openai-completions`, `openai-responses` (omp's `Model.api` strings). Anything else passes through uncompressed and is recorded as a `fallbackReason: unsupported-api` run — the widget and `runs.jsonl` always show live traffic and why it fell through, never a silent `req 0`. Other recorded reasons: `no-payload`, `no-model-api`, `no-compressible-blocks`, `no-lanes-enabled`, `no-block-changed`, `payload-not-smaller`, `gain-below-threshold` (payload-level `clear_at_least` analogue: a rewrite saving under 32 tokens goes out untouched rather than breaking the prompt cache), `below-min-cacheable` (payloads under 512 tokens — below every provider's minimum cacheable prefix — are never compressed). Logs rotate by byte budget: `debug.jsonl` ≤ 25MB (keeps newest 2MB), `runs.jsonl` ≤ 5MB (keeps newest 1MB).

### Safety gates

- **quantumLock** — high-entropy tokens (JWT, API keys, UUIDs, request ids, long hex, unix timestamps) are stabilized to `⟦Q<i>⟧` before engines run and restored after.
- **riskGate** — stack traces / private keys / secret assignments are masked; k8s Secret manifests, migrations, and confidential documents skip compression entirely.
- **fidelityGate** — per-step invariant check: ≥95% critical-needle survival (URLs, versions, paths, identifiers), ≥90% JSON keys, all numbers and diff hunks present. Needles occurring only on log-shaped lines (timestamps, severity tokens, compiler diagnostics — see `log-shape.ts`) are exempt, so build logs survive truncation. Failure rolls the step back.
- Global accept: a compressed payload replaces the original only when both its JSON length and token count strictly shrink; otherwise the request is sent unchanged.

## Not ported from OmniRoute

Server-side engines that require OmniRoute infrastructure: ccr store, ionizer, llmlingua (ONNX), headroom row-relevance, omniglyph, bit-exact gcf-generic. Token counts differ from OmniRoute (native omp tokenizer vs js-tiktoken) by design.
