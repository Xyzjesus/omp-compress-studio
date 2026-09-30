# omp-compress-studio

Compression studio + live traffic compression for [oh-my-pi](https://github.com/can1357/oh-my-pi) (omp).

Ported from the OmniRoute Compression Studio concepts to a native omp extension: every outgoing provider payload passes through selectable compression engines in a live session, and a full-screen TUI studio lets you dry-run engines, compare them A/B with an LLM fidelity judge, inspect live runs, and tune settings.

## Install

```bash
# from an omp session
omp -e /path/to/omp-compress-studio
```

Or link it permanently:

```bash
ln -s /path/to/omp-compress-studio ~/.omp/agent/extensions/omp-compress-studio
```

omp loads `src/index.ts` directly (TypeScript runs on Bun; `@oh-my-pi/*` imports are remapped to the host bundles — no build step).

Development (`check`/`test`) expects an oh-my-pi checkout next to this one (`../oh-my-pi`); tsconfig `paths` resolve host packages to its sources.

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
- **Compare** — `Ctrl+R` runs all lanes on the shared Play text; `Ctrl+V` verifies compressed outputs with the LLM judge (`Ctrl+M` sets the judge model).
- **Live** — recent live runs with waterfall + replay; `Ctrl+E` toggles compression.
- **Settings** — per-engine toggles, strategy preset, caveman intensity, gates, heatmap default, judge cost cap, judge model, debug logging. Every change saves to `~/.omp/agent/compress-studio/config.json`.

### Strategies are presets

The runtime truth is the per-engine switches (`dedup`, `rtk`, `truncate`, `caveman` + intensity). A strategy preset is a one-shot writer for those switches:

| Preset | Engines written |
|---|---|
| `off` | none + sets live compression to `enabled: false` |
| `lite` | caveman@lite |
| `standard` | caveman@full |
| `aggressive` | rtk, caveman@full |
| `ultra` | dedup, rtk, truncate, caveman@ultra |
| `rtk` | rtk |
| `stacked` (default) | dedup, rtk, truncate, caveman@full |

The live pipeline applies the enabled engines in stack order (dedup → rtk → truncate → caveman): tool outputs get the full stack, user prose gets caveman only, and the **newest user message and the system prompt are never touched**.

### Safety gates

- **quantumLock** — high-entropy tokens (JWT, API keys, UUIDs, request ids, long hex, unix timestamps) are stabilized to `⟦Q<i>⟧` before engines run and restored after.
- **riskGate** — stack traces / private keys / secret assignments are masked; k8s Secret manifests, migrations, and confidential documents skip compression entirely.
- **fidelityGate** — per-step invariant check: ≥95% critical-needle survival (URLs, versions, paths, identifiers), ≥90% JSON keys, all numbers and diff hunks present. Needles occurring only on log-shaped lines (timestamps, severity tokens, compiler diagnostics — see `log-shape.ts`) are exempt, so build logs survive truncation. Failure rolls the step back.
- Global accept: a compressed payload replaces the original only when both its JSON length and token count strictly shrink; otherwise the request is sent unchanged.

## Not ported from OmniRoute

Server-side engines that require OmniRoute infrastructure: ccr store, ionizer, llmlingua (ONNX), headroom row-relevance, omniglyph, bit-exact gcf-generic. Token counts differ from OmniRoute (native omp tokenizer vs js-tiktoken) by design.
