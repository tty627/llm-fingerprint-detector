# llm-fingerprint-detector

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node >= 18.17](https://img.shields.io/badge/node-%E2%89%A5%2018.17-brightgreen.svg)](package.json)
[![Runtime dependencies: 0](https://img.shields.io/badge/runtime%20deps-0-success.svg)](package.json)
[![Paper: arXiv:2607.10252](https://img.shields.io/badge/paper-arXiv%3A2607.10252-b31b1b.svg)](https://arxiv.org/abs/2607.10252)

Compare behavioral output distributions from OpenAI-compatible LLM endpoints — no logits, weights, or privileged access required. The current `one-token/v1` path produces exploratory distances; it does **not** by itself establish model identity, substitution, fraud, or provider provenance.

Inspired by:

> Tomáš Bruckner, **"One Token Is Enough: Fingerprinting and Verifying Large Language Models from Single-Token Output Distributions"**, [arXiv:2607.10252](https://arxiv.org/abs/2607.10252).
> Dataset: [DOI 10.5281/zenodo.21278557](https://doi.org/10.5281/zenodo.21278557) (CC-BY-4.0) · Paper code: [DOI 10.5281/zenodo.21278793](https://doi.org/10.5281/zenodo.21278793) (MIT)

This package is **not affiliated with the paper's author**. It is inspired by the published method, but its legacy `one-token/v1` battery, prompts, normalizer, sampling counts, and fixed `0.25/0.35` bands are not a faithful reproduction of the paper's full evaluation pipeline. If you use the paper's method in research, cite the paper; do not attribute this package's legacy thresholds or results to the paper.

- **Zero runtime dependencies** — Node ≥ 18 built-in `fetch`, nothing else
- **Library + CLI** — embed it, or run `llm-fingerprint verify` in CI
- **Reasoning-model aware** — auto-detects how to disable hidden "thinking" (OpenRouter / Zhipu / OpenAI-style), with a graceful fallback
- **Legacy paraphrased probes** — `one-token/v1` draws from a paraphrase pool; this is a project-specific protocol choice, not the paper's fixed-prompt protocol
- **Bundled sample references** for 11 popular models, derived from the paper's public dataset

> Prefer a no-install related interface? See **[tosea.ai/free-tools/llm-api-fingerprint-checker](https://tosea.ai/free-tools/llm-api-fingerprint-checker)**. Its results require the same calibration and provenance caveats described here.

---

## How it works

LLMs can show repeatable biases when answering prompts such as "*Name a random number between 1 and 100*". The paper evaluates empirical single-token output distributions as behavioral fingerprints. This package's legacy protocol applies the general distance idea to a different battery and therefore needs its own calibration before its labels can support operational decisions.

```
 probe battery (task × language cells)      collect at temperature 1.0
 ┌──────────────────────────────┐           ┌─────────────────────────┐
 │ random number 1-100 (en/zh)  │           │ "42" ×19  "73" ×4  ...  │
 │ random color / letter / city │  ──25×──▶ │ per-cell answer         │
 │ coin flip / animal / fav-num │           │ distributions           │
 └──────────────────────────────┘           └───────────┬─────────────┘
                                                        ▼
                reference fingerprint  ──── mean per-cell Jensen-Shannon
                (reference endpoint)        divergence (base 2) ──▶ legacy distance band
```

1. **Probe** — ask one-word questions (random numbers, colors, letters, coin flips…) in English and Chinese, `temperature=1.0`, `max_tokens=16`, a fixed minimal system prompt, hidden reasoning disabled. Requests are shuffled and paraphrased per call.
2. **Normalize** — NFC, punctuation/emoji stripping, case folding, first word, digit unification (`seven`/`七`/`٧`/`７` → `7`), color and coin-word canonicalization; answers are classified valid / invalid / refusal / empty.
3. **Compare** — per-cell Jensen-Shannon divergence (base 2, range 0–1 bit), averaged over cells where both sides have ≥10 valid samples.
4. **Legacy band** — the historical labels `match` / `uncertain` / `mismatch` are retained for compatibility, but are explicitly marked `verdictSemantics: "legacy-exploratory"` and `decisionEligible: false`.

## Install

```bash
npm install llm-fingerprint-detector    # library + `llm-fingerprint` CLI
# or run the CLI ad hoc:
npx llm-fingerprint-detector --help
```

Requires Node ≥ 18.17 (built-in `fetch`). The core library is runtime-agnostic and also works in browsers/edge runtimes; the CLI, bundled-reference loader, and explicit paper-profile subpath are Node-only.

## Quick start — CLI

```bash
# 1. Fingerprint the endpoint you trust (key read from OPENAI_API_KEY)
export OPENAI_API_KEY=sk-...
llm-fingerprint fingerprint \
  --base-url https://api.openai.com/v1 \
  --model gpt-4o-mini \
  --out reference.gpt-4o-mini.json

# 2. Verify the endpoint you don't
export LLM_FINGERPRINT_API_KEY=sk-...   # key for the endpoint under test
llm-fingerprint verify \
  --base-url https://cheap-llm-reseller.example.com/v1 \
  --model gpt-4o-mini \
  --reference reference.gpt-4o-mini.json
```

```
Legacy exploratory band: HIGH-DISTANCE (legacy label: mismatch)
Semantics: legacy-exploratory · decision eligible: no
Mean JSD: 0.481 over 8 comparable cell(s)

Published paper medians (context only; not calibration for this implementation):
  same model ≈ 0.14 · same model, other provider ≈ 0.227 · different model ≈ 0.463
  local legacy bands: low ≤ 0.25 < mid ≤ 0.35 < high

Per-cell JSD (most divergent first):
  random-number-1-100:en     0.712  (24 vs 25 valid)
  ...
```

For backward compatibility, legacy labels still map to exit codes `0` match · `2` mismatch · `3` uncertain · `4` insufficient · `1` error. Do not use those codes as an identity policy: inspect `decisionEligible`, which is currently always `false`. Prefer `--api-key-env NAME` (defaulting to `LLM_FINGERPRINT_API_KEY` then `OPENAI_API_KEY`). The legacy commands still accept `--api-key` for compatibility, but a literal can be exposed through shell history or the process list; `paper-fingerprint` rejects it.

More: `llm-fingerprint --help`, [`examples/cli-examples.sh`](examples/cli-examples.sh).

## Explicit opt-in: pinned T=1 Study-A profile

The separate `paper-fingerprint` command runs the pinned **T=1, 10-task × 4-language (40-cell)** Study-A prompt profile. Its default `openai-chat-onetoken-v1` transport uses the archived fixed system/user prompts, `temperature=1`, `max_tokens=16`, `reasoning: { enabled: false }`, and `usage: { include: true }`. The strict `anthropic-messages-opus5-onetoken-v1` transport maps the same prompts to `/v1/messages` with `thinking: { type: "disabled" }` and `output_config: { effort: "high" }`. Neither transport adds `stream`, `top_p`, `top_k`, `seed`, tools, adapter probes, or a post-reasoning fallback.

This path is deliberately not the default. It is a collection implementation, **not a full reproduction of the paper's EER experiment**: it does not run the separate T=0 arm, assemble the paper's model/provider cohort, or estimate thresholds and error rates. There is currently no validated decision policy, so its V2 artifact and raw samples are evidence for later calibration—not a model-identity, substitution, fraud, or provider-provenance conclusion.

```bash
export PAPER_ENDPOINT_KEY=sk-...
llm-fingerprint paper-fingerprint \
  --base-url https://api.example.com/v1 \
  --model model-id \
  --api-key-env PAPER_ENDPOINT_KEY \
  --role enrollment \
  --scheduler-seed enrollment-2026-08 \
  --out enrollment.v2.json \
  --samples-out enrollment.raw.jsonl
```

`--role`, `--scheduler-seed`, `--out`, and `--samples-out` are mandatory. The command also requires an environment-sourced key when authentication is needed; a literal `--api-key` is rejected. Select the wire protocol with `--transport-profile`; Anthropic additionally accepts `--anthropic-workspace-id`. The default is 30 samples per cell (1,200 requests); override it with `--samples`. HTTP defaults are a 90-second timeout, at most two retries per logical job, a batch-wide retry budget of 240 (override with `--retry-budget`), and a 1 MiB successful-response limit. Non-success response bodies are cancelled rather than retained.

The CLI stops scheduling new jobs after a thrown transport/authentication failure or an HTTP-200 provider-error payload, waits for at most the already in-flight concurrency window, and does not write final artifacts for that failed run. Thus 401/403 and provider-error failures are not retried; network, timeout, 429, 500, 502, 503, and 504 failures can make at most three physical attempts per logical job and cannot exceed the shared retry budget.

Both Node transports reject redirects, query/fragment URLs, non-HTTPS public endpoints, and DNS results in private, loopback, link-local, metadata, documentation, multicast, or reserved ranges. DNS is revalidated before every physical attempt. The implementation does not pin the validated address into Node's built-in `fetch`, so a resolver change between validation and the subsequent connection remains a narrow TOCTOU boundary; deployment-level egress filtering is still required.

Both output paths are preflighted before network access. The CLI writes random, same-directory, mode-`0600` temporary files; each final rename is atomic, and ordinary two-file commit failures are rolled back to the previous pair. The V2 fingerprint binds the canonical JSONL sidecar by SHA-256. The transport applies an exact credential redactor to every response string retained in raw evidence (`raw`, provider, reported model, generation id, and finish reason). If an endpoint echoes the credential, the value is replaced with a marker and the entire sample is excluded as an error; transformed or encoded echoes cannot be recognized automatically. Caller-supplied `Authorization` and `Content-Type` compatibility headers are ignored and overwritten by the transport.

`quality.directness` is `verified` only when every structurally successful response has `message.role: "assistant"`, exposes no recognized reasoning/thinking/analysis trace, and explicitly reports `reasoning_tokens: 0`. Missing role is a malformed response; missing reasoning usage makes directness `unknown`; positive tokens or a visible trace make it `violated` and exclude the contaminated sample. The paper collector never enables the legacy post-reasoning fallback, so its `postReasoning` field remains `false`; contamination is represented by the quality fields instead.

Node library users must opt in through the Node-only subpath:

```ts
import {
  collectBruckner2026PaperFingerprint,
  createOpenAICompatiblePaperTransport,
} from 'llm-fingerprint-detector/paper'

const request = createOpenAICompatiblePaperTransport({
  baseUrl: 'https://api.example.com/v1',
  apiKey: process.env.PAPER_ENDPOINT_KEY,
})
const collected = await collectBruckner2026PaperFingerprint({
  model: 'model-id',
  role: 'audit',
  schedulerSeed: 'audit-2026-08',
  samplesPerCell: 30,
  request,
})
```

Retain `collected.rawEvidenceJsonl` separately and verify that its SHA-256 equals `collected.fingerprint.quality.rawEvidenceSha256`. Do not import this Node-only collector from browser bundles or treat its output as an operational verdict.

## Quick start — library

```ts
import { fingerprint, compare, verify } from 'llm-fingerprint-detector'

// Collect a fingerprint
const run = await fingerprint(
  { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', apiKey: process.env.OPENAI_API_KEY },
  { cells: 8, samplesPerCell: 25, onProgress: (e) => console.log(e.done, '/', e.total) },
)
console.log(run.fingerprint)          // JSON-serializable artifact
console.log(run.splitHalfJsd)         // self-consistency (≈0.14 is normal)

// Verify another endpoint against it
const result = await verify(
  { baseUrl: 'https://suspect.example.com/v1', model: 'gpt-4o-mini', apiKey: process.env.SUSPECT_KEY },
  run.fingerprint,
)
console.log(result.verdict, result.meanJsd)   // legacy compatibility label + raw distance
console.log(result.verdictSemantics)          // 'legacy-exploratory'
console.log(result.decisionEligible)          // false

// Or compare two saved fingerprints offline
const distance = compare(fingerprintA, fingerprintB)
```

Bundled sample references (Node only):

```ts
import { listBundledReferences, loadBundledReference } from 'llm-fingerprint-detector/references'

const reference = loadBundledReference('openai/gpt-4o-mini')
const result = await verify(suspectEndpoint, reference)
```

Runnable examples: [`examples/01-fingerprint-endpoint.mjs`](examples/01-fingerprint-endpoint.mjs), [`examples/02-verify-endpoint.mjs`](examples/02-verify-endpoint.mjs).

## Tutorial: explore how far two endpoint distributions differ

The legacy workflow can help you measure behavioral divergence between a reference endpoint and another endpoint. It cannot answer model identity on its own:

1. **Collect a trusted reference.** Fingerprint the *official* API (or any endpoint you fully trust) for the model in question:

   ```bash
   llm-fingerprint fingerprint --base-url https://api.openai.com/v1 \
     --model gpt-4o-mini --api-key-env OFFICIAL_KEY --out ref.json
   ```

   No official access? A bundled sample (`llm-fingerprint references`) can demonstrate the mechanics, but it uses a different protocol and is not decision-eligible evidence.

2. **Verify the suspect endpoint** with the *same* model id:

   ```bash
   llm-fingerprint verify --base-url https://reseller.example.com/v1 \
     --model gpt-4o-mini --api-key-env RESELLER_KEY --reference ref.json
   ```

3. **Read the distance and legacy band.**
   - `match` means only that the raw distance fell in the historical low-distance band (`≤ 0.25`).
   - `mismatch` means only that the raw distance fell in the historical high-distance band (`> 0.35`). Many factors besides model identity can change a distribution.
   - `uncertain` is the historical middle band. More samples can reduce sampling noise, but cannot turn an uncalibrated band into a calibrated identity decision.
   - A high **split-half JSD** indicates instability within the run. It may merit investigation, but it does not identify the cause.

4. **Investigate rather than conclude from this label.** Check protocol equality, reference provenance and freshness, reasoning behavior, request errors, prompt injection, and independent evidence.

## Interpreting results

Distances are mean Jensen-Shannon divergence (base 2), so 0 = identical observed distributions and 1 = disjoint observed answer sets. The table deliberately separates published paper medians from this project's uncalibrated legacy bands:

| meanJsd | status |
|---|---|
| ≈ 0.14 | paper-reported median for its same-model split-half setup; context only |
| ≈ 0.227 | paper-reported same-model cross-provider median; context only |
| **≤ 0.25** | local legacy low-distance band; JSON label `match` |
| 0.25 – 0.35 | local legacy middle-distance band; JSON label `uncertain` |
| **> 0.35** | local legacy high-distance band; JSON label `mismatch` |
| ≈ 0.463 | paper-reported different-model median; context only |

The paper's reported error rates belong to its own exact dataset, cell matrix, prompts, normalizer, split design and evaluation procedure. They cannot be inherited by `one-token/v1`, its 8/16-cell presets, the bundled converted samples, or the `0.25/0.35` bands. Calibrate an explicit policy on representative same-model and known-different controls before enabling any operational decision.

### Limitations you must know

- **Fingerprints drift.** Providers silently update models; a 3-month-old reference can legitimately mismatch today's deployment. Always check `collectedAt`, refresh references regularly.
- **A reference needs verified provenance.** A label or model id does not make a reference official ground truth.
- **Protocol equality is mandatory for interpretation.** When `protocolMismatch` is true, only the raw distance is reported; the legacy band must not be read as an identity finding.
- **The system prompt must be identical on both sides.** Swapping only the system prompt shifts fingerprints by JSD ≈ 0.44–0.46 — the magnitude of a model swap. This tool pins the same minimal system prompt on both sides automatically; if an endpoint *injects* its own server-side prompt, that will (correctly) surface as divergence.
- **Reasoning fallback lowers confidence.** When hidden reasoning can't be disabled, the run is flagged `postReasoning` — distributions shift measurably in that channel.
- **Quantization/serving stack changes** the same weights can move distances into the uncertain band.
- **Legacy labels are not decisions.** `verdictSemantics` is `legacy-exploratory` and `decisionEligible` is `false`, including for same-protocol comparisons. A `match` or `mismatch` string is retained only for compatibility.

## Bundled sample references

`data/reference-fingerprints.sample.json` ships fingerprints of 11 popular models (GPT-4o, GPT-4o-mini, GPT-4.1-mini, Claude Sonnet 4.5, Gemini 2.5 Flash, DeepSeek-chat, Llama-3.1-8B, Qwen3-30B-A3B, Mistral Small 3.2, GLM-4.5, Kimi K2), derived from the paper's public dataset:

> Bruckner, T. (2026). *Single-token output distributions as behavioral fingerprints of large language models* [Data set]. Zenodo. [https://doi.org/10.5281/zenodo.21278557](https://doi.org/10.5281/zenodo.21278557) — CC-BY-4.0. Counts reconstructed from the published per-cell distributions and re-normalized with this package's normalizer (see [`scripts/build-sample-references.mjs`](scripts/build-sample-references.mjs)).

Those source samples were collected by the paper's harness (via OpenRouter), then converted into this package's `bruckner-zenodo-2026` legacy artifact format. They are not official-provider ground truth and do not share the local `one-token/v1` protocol. `compare()` flags cross-protocol pairs with `protocolMismatch: true`; use the resulting JSD only as an exploratory distance and do not interpret the compatibility `verdict` as an identity conclusion. For a local same-protocol comparison, collect your own reference:

```bash
llm-fingerprint fingerprint --base-url <trusted-url> --model <id> --out my-reference.json
```

To rebuild or extend the bundled samples from the Zenodo dataset, download the dataset, then:

```bash
npm run build
node scripts/build-sample-references.mjs path/to/distributions.json --models openai/gpt-4o,another/model
```

## API surface (TypeScript, fully typed)

| export | what it does |
|---|---|
| `fingerprint(endpoint, options?)` | probe an endpoint → `FingerprintRun` (fingerprint, adapter, split-half, warnings) |
| `compare(a, b)` | two fingerprints → distance plus a legacy compatibility label (`decisionEligible: false`) |
| `verify(endpoint, reference, options?)` | fingerprint + compare in one call; still exploratory until a policy is calibrated |
| `normalizeAnswer(raw, domain)` | the full normalization pipeline (pure, unit-tested) |
| `jensenShannonDivergence(p, q)` | base-2 JSD over count maps |
| `splitHalfJsd(samplesByCell)` | endpoint self-consistency check |
| `detectReasoningAdapter(endpoint)` | which reasoning-disable field the endpoint accepts |
| `PROBE_TASKS`, `CELL_PRIORITY_ORDER`, `SYSTEM_PROMPTS` | the battery itself |
| `llm-fingerprint-detector/references` | bundled sample loader (Node only) |
| `llm-fingerprint-detector/paper` | explicit Node-only pinned T=1 Study-A 40-cell collector and strict HTTP adapter |

All options (`cells`, `samplesPerCell`, `concurrency`, `timeoutMs`, `maxRetries`, `signal`, `onProgress`, …) are documented in [`src/types.ts`](src/types.ts).

## Development

```bash
git clone https://github.com/ToseaAI/llm-fingerprint-detector.git
cd llm-fingerprint-detector
npm install
npm run build     # tsc → dist/
npm test          # builds, then runs node --test against the built output
```

No test framework, no bundler — TypeScript and the Node built-in test runner only.

## Contributing

Issues and PRs are welcome. Especially valuable:

- **More languages** in the probe battery (the paper also used Arabic and Russian) — requires matching normalizer support, see `src/normalizer.ts`
- **Reference fingerprints** for more models/providers, collected with this tool's protocol (`one-token/v1`) and a documented date/channel
- **Protocol-specific calibration data**: representative same-model and known-different controls for a separately versioned decision policy

Please keep changes dependency-free and covered by `node --test` tests.

## Citation & license

Method: cite the paper —

```bibtex
@article{bruckner2026onetoken,
  title   = {One Token Is Enough: Fingerprinting and Verifying Large Language Models
             from Single-Token Output Distributions},
  author  = {Bruckner, Tom{\'a}{\v s}},
  journal = {arXiv preprint arXiv:2607.10252},
  year    = {2026}
}
```

This package: [MIT](LICENSE). Bundled sample data: CC-BY-4.0, © Tomáš Bruckner (see above).

---

*Built and maintained by [Tosea.ai](https://tosea.ai). Want the zero-setup version? → [LLM API Fingerprint Checker](https://tosea.ai/free-tools/llm-api-fingerprint-checker) (runs in your browser, your key never leaves it).*
