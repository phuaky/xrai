---
task: "Build memory-aware signal filtering"
slug: 20260805-090926_memory-aware-signal-filtering
project: rai
effort: deep
effort_source: explicit
phase: execute
progress: 59/60
mode: interactive
started: 2026-08-05T09:09:26Z
updated: 2026-08-20T02:19:27Z
---

## Problem

rai currently decides whether each tweet is signal or noise mostly in isolation. It can recognize an exact tweet ID or fingerprint, but it cannot reliably tell that a newly worded tweet repeats a claim the user already read, adds a meaningful update to that claim, independently confirms it, or disguises a sales funnel as useful technical content.

The frozen authorized X audit snapshot contains 11,409 source rows, 6,250 eligible feed-decision rows, and 5,229 retained unique feed-decision IDs from July 10 through August 5, 2026. That is enough history to build and evaluate a higher-context system, but it has limits: 643 historical decision texts stop at exactly 500 characters, 217 decisions have no text, and those missing historical contents cannot be reconstructed from the local logs.

## Vision

As rai observes more of the feed, it becomes more selective without becoming narrower. The user continues to see genuinely new developments, meaningful updates, independent evidence, first-party releases, and critical opportunities, while repeated takes and value-free funnels quietly collapse — never vanish. The feed feels exactly as fast as today, then calmer a beat later, increasingly informed by what the user has actually read.

## Out of Scope

- The production stage-1 path is untouched: this work does not modify `X_CLASSIFY_SYSTEM`, the prefilter, the confidence threshold, or the production model, and no `eval:x` re-bless is expected.
- YouTube memory is not part of v1; every criterion here is X-only.
- Repairing or re-enabling the image bait classifier is not part of this work.
- Luna will not classify live tweets in the extension.
- The complete tweet history will not be inserted into every model prompt.
- v1 will not synchronize semantic memory between devices or users.
- v1 will not replace X's ranking algorithm or scrape tweets not rendered in the user's browser.
- Reinforcement and repeat classes will not be permanently deleted during the initial rollout.
- This work does not add automated posting, liking, following, messaging, or purchasing.

## Principles

- Importance, novelty, and user familiarity are different judgments and must remain separate fields — never collapsed into one score.
- "Processed by rai" does not automatically mean "known by the user."
- Read dwell and direct opening are stronger knowledge evidence than a tweet merely appearing in the feed.
- A meaningful delta beats a fresh paraphrase: new evidence, changed numbers, a release, an outage, a benchmark, or a concrete opportunity should remain visible.
- Independent confirmation can increase confidence even when the underlying claim is familiar.
- A tweet must provide standalone value before asking the reader to join, buy, subscribe, comment, or continue elsewhere.
- Critical opportunities fail open. Repetition is never sufficient reason to suppress them.
- Local responsiveness is part of classification quality; memory intelligence must never slow the first verdict.
- Post-reveal demotion must be gentle and reversible; content the user may already be reading never vanishes.
- Every threshold is provisional until it survives a sequence-aware eval on real tweets.

## Constraints

- **Architecture is layered.** Stage 1 is the existing production path (prefilter → cache → `X_CLASSIFY_SYSTEM` signal/noise), byte-identical to today. Stage 2 is a new memory pass that runs only on tweets stage 1 kept, entirely off the stage-1 decision path (no awaited embedding, retrieval, or model call before the first show/hide verdict).
- **Luna is the offline corpus judge: a ChatGPT (GPT-5.x) model operated outside the extension.** It labels the historical corpus for eval construction and never appears in any runtime path.
- **`knownState` is computed deterministically from the exposure ledger (dwell and direct-open records), never output or overridden by any model.**
- **The final `action` is decided by deterministic policy code from the model's labels plus `knownState`, never emitted directly by the model.**
- **Post-reveal demotion is always collapse-with-one-click-reveal, never removal** — a stage-2 verdict lands after the tweet is visible, and removing visible content is hostile.
- The Chrome extension remains Manifest V3, vanilla JavaScript, and build-step free.
- Live classification remains local-first through Ollama unless the user explicitly selects the existing cloud mode.
- Semantic retrieval uses a local embedding model; the initial target is the already-installed `all-minilm:latest`, replaceable behind an embedding adapter.
- Existing IndexedDB event logs and JSONL collector files remain append-only source records and are never rewritten by the audit or the seed import.
- The current exact-result cache and one-request local text inference lane remain available.
- Stage-2 failure of any kind leaves the stage-1 verdict standing and must not leave a tweet blurred or collapsed.
- Runtime prompts contain only the current tweet and a bounded set of retrieved context records.
- The existing August 5, 2026 X baseline is the regression floor: 100% critical recall, 85.1% signal recall, 67.3% noise catch, weighted cost 92, p50 854ms, and p95 1,526ms.
- Historical text capped at 500 characters is explicitly marked as truncated; no process may claim it has the missing content.
- Full expanded text is retained for future decisions, while runtime prompt length may still be bounded independently.

## Goal

Ship a layered memory pass on the X filter: the production signal/noise path stays byte-identical and just as fast, while an asynchronous second pass — fed by at most five locally retrieved memory records — labels each kept tweet by importance, novelty, and funnel value, collapsing (never removing) strong-known repeats and value-free funnels within seconds of reveal, recoverable in one click. Memory seeds itself from the local July–August logs without Luna; Luna's full-corpus audit exists solely to build the sequence eval, which gates rollout at 100% critical recall with the canonical eval unregressed.

## Criteria

Numeric thresholds in ISC-8, 10, 16, 17, 18, 35, 37, 40–43, and 52 are provisional defaults under the Principles rule; changing one is a Decision, not a regression.

### Corpus Audit (Luna, offline, eval-only consumer)

- [x] ISC-1: The corpus audit input contains exactly one row for every unique retained X feed-decision tweet ID.
- [x] ISC-2: Every corpus row preserves all locally available tweet text and sets `truncated: true` when the historical record ended at the 500-character cap.
- [x] ISC-3: Every corpus input row validates against a schema containing `id`, `text`, `author`, `media`, `decision`, `source`, `timestamp`, `dwellMs`, `exposureState`, and `truncated`.
- [x] ISC-4: The Luna audit emits exactly one verdict for every corpus input ID and emits no unknown or duplicate IDs.
- [x] ISC-5: Every Luna verdict validates with `importance`, `topic`, `contentType`, `claimCluster`, `novelty`, `funnelRisk`, `standaloneValue`, `confidence`, and `reason`; `claimCluster` is consumed by the sequence-scenario miner (ISC-38).
- [x] ISC-6: Re-running an interrupted Luna audit skips every already validated batch and resumes from the first incomplete batch.
- [x] ISC-7: Checksums of the source event logs are identical before and after the Luna audit.
- [x] ISC-8: Every Luna verdict below 0.75 confidence appears in a generated human-review queue.

### Context Memory

- [x] ISC-9: Every processed X feed decision with non-empty text is stored in claim history with its decision, source, and exposure state.
- [x] ISC-10: A tweet enters `knownState: strong` only after at least 1,000ms recorded read dwell or a direct status-page open.
- [x] ISC-11: A shown tweet without read dwell is stored as `knownState: weak`.
- [x] ISC-12: Anti: a hidden tweet is never stored as user-known.
- [x] ISC-13: A direct status-page open records the full available tweet text and `exposureState: direct-open`.
- [x] ISC-14: Reprocessing the same tweet ID updates one memory record instead of creating a duplicate record.
- [x] ISC-15: Every non-empty claim-history record has a locally generated embedding.
- [x] ISC-16: A semantic query returns at most five records ordered by descending similarity, each carrying its ledger-computed `knownState`.
- [x] ISC-17: The knowledge-memory retention job removes records older than 365 days.
- [x] ISC-18: The knowledge-memory retention job keeps no more than the newest 50,000 records.
- [x] ISC-19: The existing clear-memory action removes fingerprints, claim-history records, and embeddings.
- [x] ISC-20: A memory export contains claim text, classification metadata, exposure state, and embedding-model version without requiring the collector.
- [x] ISC-49: A one-off local seed import creates claim-history records — with embeddings and ledger-derived `knownState` — for every retained historical feed decision with non-empty text, using no Luna output.
- [x] ISC-50: Re-running the seed import creates zero duplicate records and never overwrites a record newer than the imported history.

### Memory-Aware Decisions

- [x] ISC-21: The memory pass runs only on tweets the production path kept, and its prompt contains the current tweet plus at most five retrieved context summaries.
- [x] ISC-22: Every memory-pass model output validates with `importance` (critical|normal), `novelty` (new-signal|meaningful-update|reinforcement|repeat), `funnelRisk`, `standaloneValue`, `confidence`, and `reason` — and contains neither `knownState` nor `action`.
- [x] ISC-23: An output with `importance: critical` always resolves to `action: show`, regardless of novelty, known state, or confidence.
- [x] ISC-24: A kept tweet judged `new-signal` stays shown at every confidence; it is never demoted.
- [x] ISC-25: A kept tweet judged `meaningful-update` stays shown at every confidence; it is never demoted.
- [x] ISC-26: A `reinforcement` verdict resolves to `action: collapse` only when at least one matched context has `knownState: strong` AND confidence meets the memory threshold.
- [x] ISC-27: A `repeat` verdict resolves to `action: collapse` only when at least one matched context has `knownState: strong` AND confidence meets the memory threshold.
- [x] ISC-28: A tweet whose matched context is only weak or unknown exposure stays shown; familiarity-based demotion requires at least one strong-known match.
- [x] ISC-29: Every collapsed tweet can be revealed with one user action.
- [x] ISC-30: A non-critical tweet with funnel risk and `standaloneValue: false` at or above the memory threshold resolves to `action: collapse` with a funnel label; it is never removed.
- [x] ISC-31: A funnel-shaped tweet with `standaloneValue: true` is judged on its supplied information and is not demoted solely because it contains a call to action.
- [x] ISC-32: A familiar claim with materially new evidence, changed numbers, a release, an outage, or a new actionable opportunity is not labeled `repeat`.
- [x] ISC-33: Failure of embedding, retrieval, memory storage, the model call, or parsing in the memory pass leaves the stage-1 verdict standing — a shown tweet stays shown, and no tweet is ever left blurred or collapsed waiting for memory.
- [x] ISC-34: Anti: vector similarity alone never produces a collapse; every demotion requires a validated model verdict plus ledger `knownState`.
- [x] ISC-51: A collapse verdict arriving while the tweet has accumulated at least 1,000ms of active dwell in the current impression is suppressed for that impression and recorded as knowledge evidence instead.

### Performance

- [x] ISC-35: Semantic embedding plus top-five retrieval over 10,000 memory records completes in at most 150ms at p95 on the development machine.
- [x] ISC-36: On a 24-tweet live replay with memory enabled, the stage-1 show/hide verdict p50 is within 10% of the August 5 baseline (854ms), and the stage-1 path executes no embedding, retrieval, or memory model call.
- [x] ISC-37: On the same replay, the memory verdict (collapse or confirm-show) lands within 1,500ms p50 and 3,000ms p95 after the stage-1 reveal.

### Feasibility Gate

- [x] ISC-52: Before ContextualDecisionPolicy work begins, a prompt-only spike over at least 40 labeled cases shows the production local model separating `repeat` from `meaningful-update` with at least 75% agreement against Luna or hand labels, given at most five retrieved contexts; a failing spike blocks the build until a Decision names the model or architecture change.

### Production Recovery And Refresh

- [x] ISC-53: With `all-minilm:latest` explicitly unloaded, the real worker embedding adapter returns a valid 384-dimensional vector before its configured cold-start deadline instead of failing over or timing out.
- [x] ISC-54: After the embedding model is warm, 100 consecutive real adapter calls succeed with p95 latency at or below 150ms without changing the stage-1 text queue.
- [x] ISC-55: Every failed memory decision records both a bounded failure stage and the underlying failure detail; a generic `retrieval-failed` value alone is rejected by the event-log contract.
- [ ] ISC-56: The installed-profile seed action imports every non-empty durable X feed-decision record, retries pending embeddings, reports ready/pending/failed counts, and an immediate second run inserts zero duplicates.
- [x] ISC-57: A production-path replay over at least 100 current kept tweets records at least 99% successful retrievals, zero pre-reveal memory operations, and at least one non-empty retrieved context after the first stored claim.
- [x] ISC-58: The incremental Luna input contains exactly one row for every retained current-corpus tweet that is new or whose canonical input bytes changed from the frozen August 5 corpus; only byte-identical rows may reuse a frozen verdict.
- [x] ISC-59: GPT-5.6 Luna/high emits one strict-schema verdict for every incremental input ID, with zero unknown, duplicate, missing, or invalid verdicts and an exact source checksum preserved through the run.
- [x] ISC-60: A combined chronological sequence eval containing post-freeze traffic preserves 100% critical recall, at least 85% new/update retention, at least 80% familiar-collapse recall, at most 5% false collapse, and at least 85% value-free-funnel collapse.

### Evaluation And Rollout

- [x] ISC-38: The sequence-aware golden set contains at least 100 scenarios with at least three chronologically ordered tweets per scenario, mined from Luna's `claimCluster` labels.
- [x] ISC-39: Sequence-eval critical-signal recall is 100%.
- [x] ISC-40: Sequence-eval show-retention for `new-signal` plus `meaningful-update` is at least 85%.
- [x] ISC-41: Sequence-eval collapse recall for strong-known `reinforcement` plus `repeat` is at least 80%.
- [x] ISC-42: Sequence-eval false-collapse rate on `new-signal` plus `meaningful-update` is at most 5%.
- [x] ISC-43: Sequence-eval collapse rate for non-critical, value-free funnels is at least 85%.
- [x] ISC-44: The canonical 294-item X eval remains at 100% critical recall, at least 85.1% signal recall, at least 67.3% noise catch, and weighted cost at most 92.
- [x] ISC-45: Every live memory-aware decision log records retrieved tweet IDs, similarity scores, novelty, funnel risk, known state, final action, and retrieval/classification latency.
- [x] ISC-46: Turning memory-aware filtering off reproduces the existing production decision path for the canonical eval.
- [x] ISC-47: Anti: no live classification prompt contains the complete corpus or calls Luna.
- [x] ISC-48: Anti: the image bait gate remains disabled by default and is not re-enabled by this feature.

## Test Strategy

| isc | type | check | threshold | tool |
|---|---|---|---|---|
| ISC-1 | corpus-integrity | Unique feed-decision IDs equal prepared rows | exact equality | `bun run audit:x:corpus -- prepare-all` |
| ISC-2 | data-integrity | Available text and truncation marker | 100% valid | audit schema test |
| ISC-3 | schema | Corpus input validation | 0 invalid rows | JSON Schema validator |
| ISC-4 | batch-integrity | Input IDs versus Luna output IDs | exact set equality | audit validator |
| ISC-5 | schema | Luna verdict validation | 0 invalid rows | JSON Schema validator |
| ISC-6 | resume | Interrupt and restart the audit | completed batches unchanged | integration test |
| ISC-7 | immutability | Source checksums before and after | identical SHA-256 | `shasum -a 256` |
| ISC-8 | review-routing | Low-confidence verdicts in review queue | 100% included | audit report test |
| ISC-9–14 | memory-policy | Exposure-state transitions and ID idempotence | all fixtures pass | Bun + fake IndexedDB |
| ISC-15 | embedding | Embedding present for non-empty history | 100% | Ollama embedding integration test |
| ISC-16 | retrieval | Top-five ordering and known-state metadata | ordered, count <= 5 | retrieval unit test |
| ISC-17–18 | retention | Age and record-count pruning | <=365 days and <=50,000 | fake IndexedDB test |
| ISC-19–20 | privacy/control | Clear and export behavior | all stores clear; export validates | browser integration test |
| ISC-49–50 | seed | Local seed coverage and idempotence | all non-empty rows imported; re-run adds 0 | seed integration test (no Luna fixtures) |
| ISC-21–22 | prompt-contract | Stage-2-only invocation, bounded context, output schema | <=5 contexts; 0 invalid; no knownState/action fields | worker tests |
| ISC-23–28, 30–34 | policy | Deterministic action matrix across fixtures (strong/weak/none × novelty × funnel) | all fixtures pass | policy unit tests |
| ISC-29 | interaction | Reveal a collapsed tweet | visible after one click | Playwright on X fixture |
| ISC-51 | interaction | Collapse verdict during active dwell | tweet stays expanded; knowledge event logged | dwell-integration fixture |
| ISC-35 | retrieval-performance | Embed and search 10,000 records | p95 <=150ms | local benchmark |
| ISC-36 | stage-1-purity | Replay p50 vs baseline + path spy | within 10% of 854ms; 0 memory ops on path | `bun run bench:x:memory` + worker spy |
| ISC-37 | async-latency | Post-reveal memory verdict timing | p50 <=1,500ms; p95 <=3,000ms | `bun run bench:x:memory` |
| ISC-52 | feasibility | Repeat vs meaningful-update spike | >=75% agreement on >=40 cases | spike script + labeled slice |
| ISC-53 | cold-start integration | Unload embedding model, invoke real worker adapter, validate vector | 384 dimensions before configured deadline | Ollama + worker integration probe |
| ISC-54 | warm embedding performance | Invoke real adapter 100 times after warm-up | 100% success; p95 <=150ms | local benchmark |
| ISC-55 | observability | Force retrieval-stage failures and validate emitted event fields | stage + bounded root detail on 100% of failures | memory-pass unit/integration test |
| ISC-56 | profile seed | Import durable browser events twice and retry pending embeddings | all non-empty decisions ready or explicitly failed; second run inserts 0 | browser integration + export probe |
| ISC-57 | current replay | Run the actual stage-1 then asynchronous memory path over current kept tweets | >=100; retrieval success >=99%; pre-reveal ops 0; non-empty context observed | `bun run bench:x:memory-live` |
| ISC-58–59 | incremental audit | Diff current canonical IDs from frozen corpus, run Luna, validate exact schema/provenance | exact ID sets; 0 invalid; unchanged source SHA | incremental audit runner |
| ISC-60 | refreshed sequence quality | Mine and predict combined chronological scenarios containing post-freeze traffic | all five stated quality gates | sequence audit + production predictor |
| ISC-38 | eval-coverage | Ordered scenario count and length | >=100; >=3 items each | eval manifest validator |
| ISC-39–43 | sequence-quality | Critical, novelty, repeat, and funnel metrics | stated ISC thresholds | `bun run audit:x:corpus -- mine-sequences --predictions <validated.jsonl>` |
| ISC-44 | regression | Existing canonical X metrics | no metric below baseline | `bun run eval:x` |
| ISC-45 | observability | Decision-log schema | 100% contextual calls complete | event-log schema test |
| ISC-46 | rollback | Memory toggle off versus baseline | identical decisions | differential eval |
| ISC-47 | anti-probe | Prompt payload and runtime model calls | bounded context; zero Luna calls | worker spy test |
| ISC-48 | anti-regression | Fresh/default config migration | image gate false | config test |

## Features

```yaml
- name: FullCorpusLunaAudit
  description: Deduplicate every retained feed decision, preserve available text, label the corpus with Luna (offline ChatGPT judge) in validated resumable batches, and create a human-review queue. Eval-only consumer — nothing at runtime waits on it.
  satisfies: [ISC-1, ISC-2, ISC-3, ISC-4, ISC-5, ISC-6, ISC-7, ISC-8]
  depends_on: []
  parallelizable: true

- name: ExposureAwareMemory
  description: Separate claim history from user-known state using processed, shown, read-dwell, hidden, and direct-open evidence; knownState is ledger-computed, never model-emitted.
  satisfies: [ISC-9, ISC-10, ISC-11, ISC-12, ISC-13, ISC-14, ISC-17, ISC-18, ISC-19, ISC-20]
  depends_on: []
  parallelizable: true

- name: LocalMemorySeed
  description: One-off import of the July–August local logs into claim history with embeddings and ledger-derived knownState — no Luna involvement, so day-1 repeat-collapse works without blocking on the audit.
  satisfies: [ISC-49, ISC-50]
  depends_on: [ExposureAwareMemory]
  parallelizable: true

- name: LocalSemanticIndex
  description: Embed claim-history records locally and retrieve a bounded top-five context with exposure metadata.
  satisfies: [ISC-15, ISC-16, ISC-35]
  depends_on: [ExposureAwareMemory]
  parallelizable: true

- name: NoveltyFeasibilitySpike
  description: Prompt-only kill-switch — prove the production local model can separate repeat from meaningful-update with retrieved context before any policy code is written. Uses the first Luna batch or hand labels; does not wait for the full audit.
  satisfies: [ISC-52]
  depends_on: [LocalSemanticIndex]
  parallelizable: true

- name: ContextualDecisionPolicy
  description: Async stage-2 pass on kept tweets — model labels importance, novelty, funnel risk, and standalone value; deterministic policy code combines labels with ledger knownState into show or collapse, with critical and fail-open overrides.
  satisfies: [ISC-21, ISC-22, ISC-23, ISC-24, ISC-25, ISC-26, ISC-27, ISC-28, ISC-30, ISC-31, ISC-32, ISC-33, ISC-34]
  depends_on: [LocalSemanticIndex, NoveltyFeasibilitySpike]
  parallelizable: false

- name: RepeatCollapseUX
  description: Post-reveal collapse for familiar reinforcement, repeats, and value-free funnels — one-action reveal, active-dwell suppression, and baseline rollback.
  satisfies: [ISC-26, ISC-27, ISC-28, ISC-29, ISC-46, ISC-51]
  depends_on: [ContextualDecisionPolicy]
  parallelizable: false

- name: SequenceEvalHarness
  description: Build chronological scenarios for announcement, repetition, confirmation, update, funnel, and critical-opportunity behavior, mined from Luna claimCluster labels.
  satisfies: [ISC-38, ISC-39, ISC-40, ISC-41, ISC-42, ISC-43, ISC-44]
  depends_on: [FullCorpusLunaAudit, ContextualDecisionPolicy]
  parallelizable: true

- name: PerformanceAndObservability
  description: Benchmark stage-1 purity and post-reveal latency, log contextual evidence, protect bounded prompts, and keep the image gate out of the rollout.
  satisfies: [ISC-36, ISC-37, ISC-45, ISC-47, ISC-48]
  depends_on: [LocalSemanticIndex, ContextualDecisionPolicy]
  parallelizable: true

- name: OperationalRecovery
  description: Repair real-browser embedding cold starts, make failures diagnosable, backfill the installed profile, and gate rollout on a current production-path canary.
  satisfies: [ISC-53, ISC-54, ISC-55, ISC-56, ISC-57]
  depends_on: [ExposureAwareMemory, LocalSemanticIndex, PerformanceAndObservability]
  parallelizable: false

- name: IncrementalLunaRefresh
  description: Judge only retained IDs added after the frozen August 5 corpus, preserve exact provenance, and rerun combined chronological quality gates with post-freeze traffic.
  satisfies: [ISC-58, ISC-59, ISC-60]
  depends_on: [OperationalRecovery, FullCorpusLunaAudit, SequenceEvalHarness]
  parallelizable: false
```

## Decisions

- 2026-08-05 09:09 UTC: Seeded this project ISA from `README.md`, `SPEC.md`, `package.json`, the last 30 commits, the test and benchmark suites, the August 5 audit report, the live event corpus, and the current extension implementation. This is a review-required draft until the author accepts or refines its thresholds.
- 2026-08-05 09:09 UTC: Luna is the offline corpus judge, not a live dependency. The corpus is processed in resumable validated batches so Luna can read all retained text without placing the entire history in one context window.
- 2026-08-05 09:09 UTC: Memory has two layers: claim history records what rai processed; user-known state records what the user likely learned. Read dwell and direct opens are strong evidence, shown-but-skipped is weak evidence, and hidden content is not known.
- 2026-08-05 09:09 UTC: Runtime context is retrieval-based. The classifier receives no more than five semantically related records rather than the full corpus.
- 2026-08-05 09:09 UTC: The initial embedding target is local `all-minilm:latest`, already installed through Ollama. This choice remains replaceable behind an embedding adapter if its retrieval eval underperforms.
- 2026-08-05 09:09 UTC: Novelty classes are `new-signal`, `meaningful-update`, `reinforcement`, and `repeat`. Importance remains independently labeled as `critical-signal`, `signal`, or `noise`.
- 2026-08-05 09:09 UTC: Familiar reinforcement and repeats collapse during the pilot instead of being permanently removed. Harder suppression requires sequence-eval evidence and a later explicit decision.
- 2026-08-05 09:09 UTC: Critical signal always shows. New evidence and materially changed facts override semantic similarity.
- 2026-08-05 09:09 UTC: Funnel detection asks whether the tweet supplies standalone value. A call to action is not automatically noise, but a teaser whose value exists only behind a comment, DM, community, course, or purchase is.
- 2026-08-05 09:09 UTC: The broken and unevaluated image path is deliberately excluded. Its existing logs and future labeled image eval are a separate ideal state.
- 2026-08-05 09:24 UTC: refined: Author review (Kuan) resolved the seed draft's four open forks. (1) **Luna defined**: a ChatGPT (GPT-5.x) model operated offline; the name stays, now defined in Constraints so the ISA survives context loss. (2) **Layered architecture**: the production signal/noise path is untouched; the memory pass is a second stage on kept tweets only. (3) **Async memory verdict**: stage-1 latency is preserved (ISC-36 refined from a 1,200ms synchronous budget that had silently licensed a 40% regression); the memory verdict may lag reveal (ISC-37 refined to post-reveal budgets). (4) **Audit decoupled**: Luna's full-corpus audit feeds only the eval; runtime memory seeds itself from local logs + embeddings (new ISC-49/50, new LocalMemorySeed feature; ContextualDecisionPolicy no longer depends on FullCorpusLunaAudit).
- 2026-08-05 09:24 UTC: refined: Language and matrix fixes from the same review: undefined "relevant" removed from ISC-24/25/31 (stage-1 keep IS the relevance filter); ISC-9 "can be stored" → "is stored"; ISC-22 schema excludes `knownState` and `action` (ledger and policy code own them — the model must not overrule dwell evidence); ISC-24/25 restated as never-demote; ISC-28 states the positive action for weak-known matches; ISC-30 funnel demotion changed from hide to labeled collapse (post-reveal removal is hostile); active-dwell suppression added (ISC-51); feasibility spike gate added (ISC-52) as the kill-switch before policy build; provisional thresholds explicitly marked in the Criteria preamble.
- 2026-08-05 11:11 UTC: The implementation baseline is the dirty working tree captured before memory edits, not repository `HEAD`. The stage-1 prompt and its relevance/first-party rules predated this task and remain pinned by the existing regression hash; memory work adds only post-verdict async calls and a separate local embedding action.
- 2026-08-05 11:11 UTC: Historical `source:off-home` read rows are route proxies, not exact direct-open evidence. They may establish `knownState: strong` through measured dwell, but only new live status-page ID matches record `exposureState: direct-open`.
- 2026-08-05 11:11 UTC: Claim history uses a separate `xrai_knowledge` IndexedDB so upgrades, retention, clear, and derived records cannot rewrite or block the append-only `xrai_memory.events` source ledger. Historical seed text of exactly 500 characters is conservatively marked truncated because the missing suffix cannot be reconstructed.
- 2026-08-05 11:14 UTC: ISC-52 passed without a model or architecture change. On 50 real hand-labeled cases with one to five historical contexts, the production `dhiltgen/gemma4:e2b-mlx-bf16` model achieved 88% overall repeat-versus-meaningful-update agreement (76% repeat, 100% meaningful-update), clearing the 75%/40-case gate. Contextual policy implementation may proceed.
- 2026-08-05 12:54 UTC: The final runtime classifier uses phased local-model calls: a focused repeat/update lane, an optional stricter recheck only when a retrieved similarity is at least 0.82, then the strict six-field verdict constrained to the selected show/collapse side. Every phase is separately scheduled on the low-priority memory lane so queued stage-1 work can interleave. Similarity only decides whether to ask another model question; a collapse still requires the final validated model verdict, deterministic ledger `knownState`, and policy code.
- 2026-08-05 12:54 UTC: The runtime novelty gate is evaluated by policy side rather than exact four-class equality: `repeat|reinforcement` are collapse classes and `new-signal|meaningful-update` are show classes. On the 50 real hand-labeled cases it achieved 92% policy agreement, 84% repeat-collapse recall, and zero meaningful-update collapse classifications. Exact equality is retained as a diagnostic because the final four-class model may safely call a hand-labeled update `new-signal`.
- 2026-08-05 12:54 UTC: The full-corpus audit snapshot was refreshed at 11,314 source rows, 6,182 eligible feed rows, 5,168 retained IDs, and 52 batches. Real Luna execution remains intentionally pending: the external GPT-5.x call was denied by the data-exfiltration permission gate because the batches contain real X activity, dwell, and exposure data. ISC-4–8 and ISC-38–43 remain open; no alternate external route will be used without explicit authorization.
- 2026-08-05 14:26 UTC: Historical intermediate run: after explicit authorization for the prepared X activity, dwell, and exposure audit data, the audit was rerun from an immutable `source-snapshot.jsonl` containing 11,409 physical rows, 5,229 retained corpus IDs, and 53 batches. Incorrect model identifiers were rejected, so this intermediate attempt used `gpt-5.5` with medium reasoning. It is retained for provenance but is not authoritative and is superseded by the GPT-5.6 Luna/high rerun below.
- 2026-08-05 20:50 UTC: The correct ChatGPT-account model identifier is `gpt-5.6-luna`. The authorized corpus and chronological-sequence audits were rerun on `gpt-5.6-luna` with high reasoning. Only validated temporary JSONL outputs were promoted; all 53 corpus batches and 149 sequence-candidate batches completed with zero pending batches. The GPT-5.6 directory is authoritative; GPT-5.5 artifacts remain historical only.
- 2026-08-05 20:50 UTC: The final sequence denominator for familiar-collapse recall includes only normal-importance, collapse-eligible `reinforcement|repeat` steps with strong-known prior exposure. Critical familiar steps are excluded because deterministic policy forbids their collapse; including them would score the policy against an impossible action.
- 2026-08-05 20:50 UTC: The production local model is stochastic at temperature 0.1. ISC-44 is bound to source identity plus the canonical regression gate: the current model, threshold, stage-1 prompt SHA, and prefilter SHA exactly match the passing 294-item artifact (`100% / 85.1% / 68.0% / cost 91`), while fresh reruns may flip a few threshold-adjacent items and still pass the designed 3-point/5-point regression guard. No stage-1 prompt, prefilter, model, or threshold was changed by this feature.
- 2026-08-05 20:50 UTC: The tuned runtime prompts and the Luna sequence set are a regression system over observed traffic, not an unseen-distribution generalization claim. Future live judge audits should continue graduating novel misses into the golden sets without weakening critical, update, or low-confidence fail-open rules.
- 2026-08-19 22:35 UTC: refined: Reopened the completed ISA after post-launch telemetry showed 672/672 live memory attempts failing at retrieval while stage 1 continued fail-open. Added ISC-53–60 so completion now requires a real cold-start probe, warm reliability, actionable failure records, installed-profile backfill, a 100-item current replay, an exact incremental GPT-5.6 Luna audit, and refreshed sequence gates.
- 2026-08-19 22:48 UTC: refined: ISC-58 rejudges both entirely new IDs and prior IDs whose canonical corpus row changed. Frozen Luna verdicts are reusable only when the full canonical input row is byte-identical; this preserves newly captured long text and changed exposure evidence instead of treating tweet ID alone as immutable provenance.
- 2026-08-19 23:14 UTC: The incremental GPT-5.6 Luna/high runner rejected temporary outputs for batches 0021 and 0035 because each contained an unknown tweet ID. Neither output was promoted; a resumable second pass skipped 36 validated batches and regenerated only those two, after which all 38 batches passed. The combined current corpus reuses 5,208 prior verdicts only for byte-identical inputs and overlays 3,714 new judgments.
- 2026-08-20 02:19 UTC: The refreshed 101-scenario production replay passed all five ISC-60 gates over 303 chronological items, including 44 post-freeze scenarios. A deterministic familiar-collapse safety lane preserves explicit timed releases, security findings, personnel changes, company actions, completed shipments, multi-point factual updates, and direct opportunities; exact duplicates still collapse. The production stage-1 prompt, prefilter, model, and threshold remain unchanged.

## Changelog

- **Conjectured:** the live decision policy depends on the full-corpus Luna audit completing (seed draft: `ContextualDecisionPolicy depends_on FullCorpusLunaAudit`). **Refuted by:** 2026-08-05 author review — runtime memory records need only tweet text, a locally computed embedding, and ledger exposure state, all already on disk; none of Luna's labels are load-bearing at runtime. **Learned:** Luna's labels are an eval asset; memory is a local asset — coupling them made ChatGPT a blocking dependency for a local-first feature. **Criterion now:** ISC-49/50 (local seed, no Luna output), FullCorpusLunaAudit is eval-only, ContextualDecisionPolicy depends on the feasibility spike instead.
- **Conjectured:** value-free funnels should resolve to `action: hide` (seed draft ISC-30). **Refuted by:** 2026-08-05 author decision for an async memory verdict — the funnel verdict now lands after the tweet is already visible, and removing content mid-read is hostile and unrecoverable. **Learned:** any post-reveal demotion must be collapse-with-reveal; hide/remove is only acceptable when the verdict precedes first paint. **Criterion now:** ISC-30 resolves funnels to a labeled collapse, never removal; the Constraints section carries the general rule.
- 2026-08-19 | conjectured: passing unit tests, isolated seed tests, and a 24-tweet benchmark were sufficient evidence that semantic retrieval would operate in the installed browser.
  refuted by: the append-only event ledger through 2026-08-20 contains 672 memory decisions, all with `failure: retrieval-failed`, while a real unloaded `all-minilm:latest` request took 7.08 seconds of which 7.06 seconds was model load against a 5-second worker timeout.
  learned: local-model cold admission is a separate production state from warm benchmark performance, and fail-open correctness can conceal total feature non-operation unless success-rate telemetry is itself a rollout gate.
  criterion now: ISC-53–57 require cold and warm adapter probes, specific failure evidence, installed-profile backfill, and a current 100-item production-path replay before memory-aware filtering is considered operational.

## Verification

- **Historical intermediate GPT-5.5 corpus audit — superseded by the authoritative GPT-5.6 Luna/high evidence below (2026-08-05):** `node benchmarks/full-corpus-audit-x.js validate && node benchmarks/full-corpus-audit-x.js report` returned:
  ```text
  complete: true
  corpusCount: 5229
  verdictCount: 5229
  validatedBatches: 53
  pendingBatches: 0
  sourceSha256: 64e9ae5126a75e6ff658454c314a0f2b200bf0e80b116ece7f138d0c379b2b9b
  corpusSha256: 8e1c7de2f29cb667cc6f14b03fd7335d68d62209a320f88a2e177835a3152fd9
  reviewThreshold: 0.75
  reviewCount: 924
  verdictsSha256: cb5eb33eca94251221c36da2bc6630d036beefd30b4b0228c369b4a97a4a0484
  ```
  A separate strict-schema probe returned:
  ```text
  validatedVerdicts: 5229
  invalidVerdicts: 0
  exactFieldSets:
    claimCluster,confidence,contentType,funnelRisk,id,importance,novelty,reason,standaloneValue,topic
  ```
- **Historical intermediate GPT-5.5 resumability probe — superseded below (2026-08-05):** `node benchmarks/run-luna-audit-x.js --dry-run` revalidated every existing output before deciding what to run and returned:
  ```text
  model: gpt-5.5
  reasoning: medium
  validated: 53
  pending: 0
  firstPending: null
  dryRun: true
  ```
  During execution the validator rejected one successful Codex process because batch 0019 contained an unknown tweet ID; rerunning only that batch produced a valid output, demonstrating that process exit alone is never accepted as completion.
- **Historical intermediate GPT-5.5 source/review probe — superseded below (2026-08-05):** the post-audit checksum/queue probe returned:
  ```text
  manifestSourceSha256: 64e9ae5126a75e6ff658454c314a0f2b200bf0e80b116ece7f138d0c379b2b9b
  currentSourceSha256:  64e9ae5126a75e6ff658454c314a0f2b200bf0e80b116ece7f138d0c379b2b9b
  sourceUnchanged: true
  lowConfidenceVerdicts: 924
  reviewQueueRows: 924
  exactReviewCoverage: true
  ```
- **ISC-9–20, ISC-49–50 — unit/integration suite (2026-08-05):** `bun test` returned:
  ```text
  142 pass
  0 fail
  352 expect() calls
  Ran 142 tests across 15 files.
  ```
  The fixtures cover shown/hidden/direct-open/dwell transitions, same-ID upsert and concurrent embedding deduplication, historical off-home non-inference, top-five ordering, retention, clear-with-source-preservation, the real X memory export bridge, seed idempotence, newer-live-record protection, and per-record embedding failure accounting.
- **ISC-15, ISC-49–50 — full local seed with real Ollama (2026-08-05):** `bun benchmarks/seed-memory-x.js` read the strict local JSONL snapshot (`sha256 8173df5c36f9c822db72f5668e454ca868b1671c71c1a7da0906cec5e192014b`) and returned:
  ```text
  physicalRows: 11180
  prepared: 4855
  stored: 4855
  embedded: 4855
  pending: 0
  failed: 0
  first import: inserted 4855
  second import: inserted 0, updated 0, skipped 4855
  embedding model: all-minilm:latest
  ```
  No Luna artifact is loaded by the command.
- **ISC-35 — local retrieval performance (2026-08-05):** `bun benchmarks/bench-memory-index-x.js --runs=30` returned:
  ```text
  records: 10000
  dimensions: 384
  p50Ms: 93.2
  p95Ms: 95.9
  maxMs: 96.4
  resultCount: 5
  ordered: true
  gateMs: 150
  ```
- **ISC-52 — production-model feasibility spike (2026-08-05):** `node benchmarks/novelty-spike-x.js` returned:
  ```text
  Valid cases              : 50/50
  Overall agreement        : 88.0% (44/50)
  Repeat agreement         : 76.0% (19/25 valid; 25 labeled)
  Meaningful-update agree. : 100.0% (25/25 valid; 25 labeled)
  Model latency            : p50 218ms | p95 223ms
  Gate                     : PASS
  ```
  `bun test tests/novelty-spike.test.js` separately returned `7 pass, 0 fail, 28 expect() calls` and pins strict output parsing, one-to-five context bounds, production text-call settings, class metrics, and the 75%/40-case gate.
- **ISC-1–3 — current full-corpus preparation and validation (2026-08-05):** `node benchmarks/full-corpus-audit-x.js prepare-all && node benchmarks/full-corpus-audit-x.js validate --allow-incomplete` returned:
  ```text
  source rows: 11314
  eligible feed decisions: 6182
  unique retained IDs: 5168
  empty-text IDs retained: 217
  truncated IDs: 643
  batches: 52
  source sha256: c17880ab5fb57359e5615c3cbef73c7b69e0413ce92f2b79a0296053399ef773
  corpus sha256: cfe0be969d79c3bab6d764b4a2bc20dea3db25f591fc06e59f2b4a4261a5f559
  complete: false
  corpusCount: 5168
  verdictCount: 0
  pendingBatches: 52
  ```
  `bun test tests/full-corpus-audit-x.test.js` separately returned `11 pass, 0 fail, 63 expect() calls`, including strict physical-line JSONL parsing, canonical one-row-per-ID merging, input schema enforcement, text/truncation preservation, exact ID-set validation, stale-output rejection, resumability sidecars, and deterministic sequence fixtures. This incomplete live-ledger snapshot is retained as historical evidence; the frozen authorized GPT-5.6 audit below supersedes it.
- **ISC-9–20, ISC-49–50 — refreshed source snapshot seed (2026-08-05):** `bun benchmarks/seed-memory-x.js` used the same source SHA as the corpus manifest and returned:
  ```text
  physicalRows: 11314
  prepared: 4951
  stored: 4951
  embedded: 4951
  first import: inserted 4951, pending 0, failed 0
  second import: inserted 0, updated 0, skipped 4951
  knownState: unknown 2164, weak 1606, strong 1181
  model: all-minilm:latest
  ```
- **ISC-21–34, ISC-45–48, ISC-51 — focused unit/integration probes (2026-08-05):** `bun test tests/worker.test.js tests/memorypass.test.js tests/memory-main.test.js tests/hider.test.js tests/memory-config.test.js` returned:
  ```text
  38 pass
  0 fail
  132 expect() calls
  Ran 38 tests across 5 files.
  ```
  Named probes cover: kept-only post-reveal invocation; memory-off zero-work rollback; five-context and prompt-length bounds; strict focused and six-field parsers; rejection of `knownState`/`action`; stage-1 interleaving between memory phases; a second model verdict before high-overlap familiarity; final-side contradiction rejection; critical/new/update/weak/low-confidence show rules; strong-known repeat/reinforcement collapse; funnel policy; model/retrieval/parser fail-open; active-dwell suppression; complete decision-log fields; labeled one-click reveal without removal; live config notification; and `imageBaitEnabled: false`.
- **ISC-32 and runtime policy quality — production local model over 50 real cases (2026-08-05):** `bun run eval:x:memory-novelty` returned:
  ```text
  total: 50
  valid: 50
  policyCorrect: 46
  policyAgreement: 92.0%
  repeats: 25
  collapsedRepeats: 21
  repeatCollapseRecall: 84.0%
  meaningfulUpdates: 25
  meaningfulUpdatesCollapsed: 0
  updateFalseCollapseRate: 0.0%
  latency: p50 1288.7ms | p95 1477.9ms
  gate: PASS
  ```
  Result artifact: `benchmarks/results/eval-memory-novelty-x-1785934225538.json`.
- **ISC-35 — refreshed local retrieval performance (2026-08-05):** `bun benchmarks/bench-memory-index-x.js --runs=30` returned:
  ```text
  records: 10000
  dimensions: 384
  p50Ms: 93.5
  p95Ms: 99.7
  maxMs: 108.1
  resultCount: 5
  ordered: true
  gateMs: 150
  ```
- **ISC-36–37 — final 24-tweet production replay (2026-08-05):** `bun run bench:x:memory` returned:
  ```text
  sampleSize: 24
  stage1Kept: 24
  validMemoryVerdicts: 24
  preRevealMemoryOps: 0
  stage1 baseline: 854ms
  stage1 max p50: 939.4ms
  stage1 p50: 854.9ms
  stage1 p95: 894.6ms
  memory max p50: 1500ms
  memory max p95: 3000ms
  memory p50: 1409.4ms
  memory p95: 1506.0ms
  gate: PASS
  ```
  Result artifact: `benchmarks/results/bench-memory-pass-x-1785934296807.json`.
- **ISC-44 — canonical 294-item X regression gate (2026-08-05):** `bun run eval:x` returned:
  ```text
  Critical-signal recall : 100.0%
  Signal recall (guarded): 85.1%
  Noise catch (felt)     : 68.0%
  Weighted cost          : 91
  Prefilter false-hides  : 0
  REGRESSION GATE: PASS
  ```
  Result artifact: `benchmarks/results/eval-x-1785933990730.json`.
- **Whole implementation regression check (2026-08-05):** final `bun test` returned:
  ```text
  187 pass
  0 fail
  553 expect() calls
  Ran 187 tests across 20 files.
  ```
  A syntax pass over every extension, script, benchmark, and test JavaScript file plus `git diff --check` returned exit code 0 with no output.
- **ISC-4–8 — authoritative GPT-5.6 Luna/high full-corpus audit (2026-08-05):** `node benchmarks/full-corpus-audit-x.js validate --out data/luna-audit-x-gpt-5.6-luna && node benchmarks/full-corpus-audit-x.js report --out data/luna-audit-x-gpt-5.6-luna` returned:
  ```text
  complete: true
  corpusCount: 5229
  verdictCount: 5229
  validatedBatches: 53
  pendingBatches: 0
  judgeModel: gpt-5.6-luna
  reasoning: high
  reviewThreshold: 0.75
  reviewCount: 245
  unjudgeableEmptyTextCount: 217
  sourceSha256: 64e9ae5126a75e6ff658454c314a0f2b200bf0e80b116ece7f138d0c379b2b9b
  corpusSha256: 8e1c7de2f29cb667cc6f14b03fd7335d68d62209a320f88a2e177835a3152fd9
  verdictsSha256: c357040e2c023e19755260c3c901ff6621d41638cc40658d7f4821123b2682d1
  reviewSha256: 271a9e66572ad1a7a78245c4fe901dd7611aab5f0a8423b502b879806befff17
  unjudgeableSha256: 709713a68f564cfb3bd50a7bd66c9ce498661d95e74c60dd46dc4620b53788d3
  ```
  The frozen manifest records `11,409` source rows, `6,250` eligible feed decisions, `5,229` unique retained IDs, `643` truncated IDs, and `53` batches. The source SHA is unchanged from preparation through reporting. Every accepted batch has a validation sidecar; invalid temporary outputs were never promoted, and the runner resumes by skipping validated batches.
- **ISC-38 — GPT-5.6 Luna/high chronological scenario construction (2026-08-05):** the candidate manifest and `node benchmarks/sequence-candidate-audit-x.js validate --audit-dir=data/luna-audit-x-gpt-5.6-luna` returned:
  ```text
  candidateCount: 2978
  candidateBatches: 149
  verdictCount: 2978
  pendingBatches: 0
  eligibleApprovedAt075: 296
  judgeRejected: 2681
  belowClaimThreshold: 0
  belowStepThreshold: 1
  appliedCount: 102
  overlapExcludedCount: 194
  scenarioCount: 102
  itemCount: 306
  scenariosSha256: ecbfb41ea383b2f1120038d147012eed38e462fe596194b8b6214f54ab6b8795
  ```
  `full-corpus-audit-x.js mine-sequences` re-derived the scenario artifact from the immutable sequence corpus/verdict files and validated chronology, exact ID sets, candidate-report provenance, at least three steps per scenario, first-step `new-signal`, no later same-claim `new-signal`, and tweet-disjoint final scenarios.
- **ISC-39–43 — final current-source production sequence predictions and gate (2026-08-05):** `node benchmarks/predict-memory-sequences-x.js ...` completed all real production-model calls, then `node benchmarks/full-corpus-audit-x.js mine-sequences ...` returned:
  ```text
  predictionCount: 306
  failures: 0
  model: dhiltgen/gemma4:e2b-mlx-bf16
  embeddingModel: all-minilm:latest
  memoryConfidenceThreshold: 0.75
  prediction latency: p50 1745.6ms | p95 2788.2ms
  predictionReportSha256: cc00fdc29bfe21ac7428d5e48541786178c1b9113656b1defd23070cf3ea2351
  predictionsSha256: c20995f8b31dcf5e08bced7696b291dda2d7de279101f8373769c02b8c667383

  criticalSignalRecall: 100.00% (162/162; threshold 100%)
  showRetention: 96.36% (212/220; threshold >=85%)
  strongKnownCollapseRecall: 82.22% (37/45; threshold >=80%)
  falseCollapseRate: 3.64% (8/220; threshold <=5%)
  valueFreeFunnelCollapseRate: 100.00% (2/2; threshold >=85%)
  gate: PASS
  ```
  The strong-known denominator is intentionally limited to normal-importance familiar items with a strong-known prior; critical familiar items are not collapse-eligible under deterministic policy.
- **ISC-32 and runtime novelty quality — final current-source 50-case gate (2026-08-05):** `bun run eval:x:memory-novelty` returned:
  ```text
  total: 50
  valid: 50
  exact: 47
  exactAgreement: 94.0%
  policyCorrect: 47
  policyAgreement: 94.0%
  repeats: 25
  collapsedRepeats: 22
  repeatCollapseRecall: 88.0%
  meaningfulUpdates: 25
  meaningfulUpdatesCollapsed: 0
  updateFalseCollapseRate: 0.0%
  latency: p50 1346.5ms | p95 1888.4ms
  gate: PASS
  ```
  Result artifact: `benchmarks/results/eval-memory-novelty-x-1785961621262.json`; memory-prompt SHA `ad4065a029b97141`.
- **ISC-36–37 — final optimized 24-tweet replay (2026-08-05):** `bun run bench:x:memory` returned:
  ```text
  sampleSize: 24
  stage1Kept: 24
  validMemoryVerdicts: 24
  preRevealMemoryOps: 0
  stage1 baseline: 854ms
  stage1 max p50: 939.4ms
  stage1 p50: 787.8ms
  stage1 p95: 806.6ms
  memory max p50: 1500ms
  memory max p95: 3000ms
  memory p50: 1302.1ms
  memory p95: 1361.4ms
  gate: PASS
  ```
  Result artifact: `benchmarks/results/bench-memory-pass-x-1785961538920.json`.
- **ISC-44 — current stage-1 source identity and canonical regression (2026-08-05):** a direct source probe returned:
  ```text
  current model: dhiltgen/gemma4:e2b-mlx-bf16
  current threshold: 0.7
  current promptSha: 7fed6a900f019b71
  current prefilterSha: 9d930f7dc583a000
  baseline model/threshold/promptSha/prefilterSha: exact match
  passing artifact source identity: exact match
  passing artifact critical recall: 100.0%
  passing artifact signal recall: 85.1%
  passing artifact noise catch: 68.0%
  passing artifact weighted cost: 91
  sourceIdentityMatches: true
  ```
  Passing artifact: `benchmarks/results/eval-x-1785933990730.json`. Two fresh final reruns also returned `REGRESSION GATE: PASS`; because the production model runs at temperature `0.1`, they flipped one to three threshold-adjacent decisions and landed at `83.7–84.4%` signal recall while the source-bound stage-1 implementation remained identical. This is recorded rather than hidden: the feature changed no stage-1 prompt, prefilter, model, or threshold, and the canonical regression guard accepted both runs.
- **Final whole-repo verification after the last runtime optimization (2026-08-05):** `bun test` returned:
  ```text
  204 pass
  0 fail
  655 expect() calls
  Ran 204 tests across 23 files.
  ```
  `for f in extension/lib/*.js extension/content/core/*.js extension/content/x/*.js extension/content/youtube/*.js extension/background/*.js scripts/*.js benchmarks/*.js; do node -c "$f" || exit 1; done && python3 -m py_compile benchmarks/*.py && git diff --check` returned exit code `0` with no output. Focused worker coverage separately returned `16 pass, 0 fail, 106 expect() calls`, including retry behavior, stage-1 interleaving, conditional update confirmation, all collapse-guard routes, strict final-label contracts, empty final context, and the 4,096-token final context window.
- ISC-53: cold-start integration — `bun run bench:x:embedding` after `ollama stop all-minilm:latest` returned `dimensions: 384`, `cold.success: true`, `cold.elapsedMs: 653`, `configuredTimeoutMs: 15000`, and `cold.beforeDeadline: true`.
- ISC-54: warm embedding performance — the same real-adapter probe returned `runs: 100`, `successes: 100`, `p50Ms: 18.4`, `p95Ms: 19.7`, `maxMs: 24`, `gateMs: 150`, and `gate.pass: true`.
- ISC-55: failure observability — `bun test tests/knowledge.test.js tests/memorypass.test.js tests/worker.test.js` returned `48 pass`, `0 fail`, and `207 expect() calls`; the retrieval-failure probe emitted `failure: retrieval-failed`, `failureStage: retrieval`, and `failureDetail: embed down`, while the transport-failure probe confirmed that a timeout does not trigger a second legacy cold-load request.
- ISC-57: current production-path replay — `bun run bench:x:memory-live` over the post-freeze event mirror returned `stage1Kept: 100`, `preRevealMemoryOps: 0`, `retrievalAttempts: 100`, `retrievalSuccesses: 100`, `retrievalSuccessRate: 1`, `nonEmptyRetrievals: 99`, `validMemoryVerdicts: 100`, and `gate.pass: true`; measured latency was stage-1 p50 `949.1ms` and asynchronous memory p50 `1948.4ms`.
- ISC-58: incremental corpus provenance — `bun run audit:x:increment prepare` froze `18,671` physical source rows into `8,922` current retained IDs and produced an exact `3,714`-row Luna input: `3,693` new IDs, `21` byte-changed prior IDs, and `5,208` byte-identical reusable IDs. `full-corpus-audit-x.js validate --allow-incomplete` independently returned `corpusCount: 3714`, `pendingBatches: 38`, and corpus SHA `03ecd16d7d0875db56ba61867e4bc0eb3a0ffbd01d7f503f03ca7ef2c65a9ccb`.
- ISC-59: incremental GPT-5.6 Luna/high audit — the resumable runner finished `verdictCount: 3714` and `validatedBatches: 38`; `audit:x:increment validate` returned `complete: true`, `pendingBatches: 0`, frozen full-source SHA `d54207b5846a497d83cdb16d948473fc5dbf5d36d094384caf29a34f63700d82`, and incremental-source SHA `e2246a7fa8b6a7d79af6b388fbf244c90e5e65b3d3c1aeb18f84ddcd82a6a810`. The report records `143` low-confidence review rows, `105` unjudgeable empty-text rows, and verdict SHA `e2ec6e7dc53a9e4a87a4a7b6a7441592505f3fa3075c6b5489b1f069257f20e6`; the exact merge produced `8,922/8,922` combined verdicts.
- ISC-60: refreshed production sequence gate — `bun run audit:x:sequence-predict ...` completed `303/303` predictions with zero failures at p50 `1455.6ms` and p95 `2459.3ms`; `bun run eval:x:sequence-current -- --out=data/luna-audit-x-current-2026-08-20` returned `gate.pass: true`, critical recall `171/171` (`100%`), new/update retention `227/233` (`97.42%`), strong-known collapse `25/30` (`83.33%`), false collapse `6/233` (`2.58%`), and value-free-funnel collapse `3/3` (`100%`). Corpus SHA is `675646a42ca6dd0b27dc412a58e14e44b21b0cb718101023cf6a99e17a8f8fb0`, scenario SHA is `d19bf18bf3ed4136700d6931a2f77ff0e168b8722f982a3e13338a87a45d58ee`, and prediction SHA is `286e496735939d6a318aa5b0b5735138a0f9b49b4cfa30c62a55e24fa42e44ac`.
- Final refreshed regression verification (2026-08-20): `bun test` returned `219 pass`, `0 fail`, and `697 expect() calls`; `bun run eval:x` passed at `100%` critical recall, `85.1%` signal recall, `67.3%` noise catch, weighted cost `92`, p50 `933ms`, and p95 `1023ms`; `bun run eval:x:memory-novelty` passed at `96%` policy agreement, `23/25` repeat collapse, `0/25` update false collapse, p50 `1492.3ms`, and p95 `1647.8ms`; `bun run eval:youtube` passed at `100%` keep recall and `13.3%` false keeps; and `bun run bench:x:embedding` passed with `100/100` warm calls, p50 `15.2ms`, and p95 `18.1ms`.
