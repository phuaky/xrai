# rai — public relaunch + Cloud mode revenue line

## Context

`rai` (this repo) is a from-scratch, local-only rewrite of an earlier product that's still live on the Chrome Web Store as **"Signal/Noise Ratio" v1.0.1** (Dec 2025, 2 installs, 0 ratings, outdated S/N-training UI). A second generation ("X-rAI v2") was planned with Stripe/Supabase/Azure on a Windows box, but never shipped and its API (`api.snratio.xyz`) is now dead (confirmed via health check — 530).

Kuan wants to open this as a real revenue line, not just a polish pass — "we already sent out all our important tasks, this is something I've always wanted done." Repo is already public on GitHub (verified via `gh repo view`), which is a clean fit for his G9 100-day public build goal.

The reframe that makes this work: **free tier = today's product (local Ollama, unlimited, zero cost). Paid tier = "Cloud mode" — same extension, no Ollama install required, we run the model.** This solves two problems at once: it's the "super user intuitive" fix (Ollama + a multi-GB model pull is the real barrier to non-technical users) and it's the revenue mechanism, priced on usage. Unit economics are strong: a classification is ~300 tokens in / ~50 out; on Groq's `llama-3.1-8b-instant` ($0.05/M in, $0.08/M out) that's ~$0.00002/classification — a $5 credit pack covers months of normal use.

Two phases, shipped independently so the "stop being embarrassed" win lands fast without waiting on the new backend:

- **Phase 1** — replace the live outdated Store listing with the current `rai` build + refreshed website. No new infra, ships this week.
- **Phase 2** — add Cloud mode (hosted classification, paid via credits) as an in-place update once Phase 1 is live.

---

## Phase 1: Public relaunch (no new infra)

### 1a. Extension polish for store readiness
- Add real icons — `extension/manifest.json` currently has `"icons": {}`. Need 16/48/128px PNGs. Generate via the **Art** skill (simple mark, matches the site's dark/green palette in `website/index.html` — `--accent: #4ADE80`).
- Bump `manifest.json` version (currently `2.0.0` — fine to keep, Store just needs > 1.0.1).
- Reconcile naming: keep "rai" everywhere (manifest, README, website already use it) — cheaper than reverting to "Signal/Noise Ratio". The Store listing name itself gets renamed on update, no migration needed since the old listing has 2 installs.

### 1b. Chrome Web Store listing update
- Take 5 screenshots (X feed filtering, YouTube blur-reveal, settings panel, pill indicator) — reuse the shot list structure from the old `SHIP-CHECKLIST.md` in `signal-noise-ratio-v2` as a checklist template, but content reflects the current product (no sidebar/S-N-keys UI — that's gone).
- New listing copy: local-first pitch (matches `website/index.html` hero: "your feed, without the noise. Local AI, measured."), mention both platforms, mention the eval-gated accuracy claim (`benchmarks/eval-x.js`, `eval-youtube.js`) as a differentiator — "accuracy is measured, gated, and public" is already the site's tagline.
- Privacy policy: write a fresh, short one reflecting actual current data flow — everything local, IndexedDB only, nothing sent anywhere (true today; will need a Phase-2 addendum once Cloud mode exists — write Phase 1's version to be easily extended, don't overclaim "we never see your data" in a way that breaks later).
- Package `extension/` → zip, upload via `chrome.google.com/webstore/devconsole`, submit for review (existing listing ID `hdjhnmflmgfimgnpbngojcjfpmkcjmlk` — update in place, don't create a new listing).

### 1c. Website deploy
- `website/index.html` already exists and is well-built (dark theme, hero, demo feed mock, already references install flow). Deploy it to `snratio.xyz` via Cloudflare Pages (`snratio.xyz` DNS already lives on Cloudflare — confirmed via `dig`). No `wrangler.toml` exists yet in this repo; add a minimal one (`pages_build_output_dir = "website"`) and deploy with `wrangler pages deploy website --project-name=rai-site`.
- Update the site's install CTA to point at the (pending-review) Chrome Web Store URL once live; until approved, point at the GitHub README install instructions (`INSTALL.md`).

**Phase 1 is shippable without any of Phase 2's backend work — good checkpoint to pause and confirm before continuing.**

---

## Phase 2: Cloud mode (hosted classification, paid via credits)

### 2a. Backend — Cloudflare Worker, Ollama-API-compatible
Every classification call in `extension/background/worker.js` already follows one shape: `fetch(ollamaUrl + '/api/chat', {model, messages, stream:false, options})` → reads `data.message.content` (see `classifyX`, `classifyYoutube`, `classifyImage`, `generateReply`, all in `worker.js`). This means Cloud mode needs **zero changes to the call sites** if the hosted Worker speaks the same `/api/chat` request/response shape as Ollama.

New Cloudflare Worker project (`rai-cloud/`, separate from `website/`):
- `POST /api/chat` — accepts the same body shape the extension already sends, forwards the prompt to Groq (`llama-3.1-8b-instant` for text classification; vision bait-check can stay Ollama-only for Phase 2, or route to a Groq vision model later — call this out as out-of-scope for v1 of Cloud mode to keep the first ship small), reshapes Groq's response into `{message: {content: ...}}` to match what `worker.js` already parses.
- Auth: `Authorization: Bearer <api_key>` header, checked against Cloudflare **D1** table `{api_key TEXT PRIMARY KEY, credit_balance_cents INTEGER, created_at}`. Decrement balance per call by actual Groq cost (or a flat rounded-up cost per call to keep it simple — flat is fine given the margins).
- `GET /api/balance` — returns remaining credits, for the extension settings panel to display.
- Reject with 402 when balance hits 0 — extension should surface this clearly (not fail silently, matches the repo's fail-open philosophy but this is a paid-feature boundary, not a filtering decision, so a visible "out of credits" state is correct, not fail-open).

### 2b. Payment — Stripe Checkout, no accounts system
- Stripe Checkout session for fixed credit packs ($5 / $10 / $20 — configurable, start with these three).
- Checkout success webhook (`POST /webhook/stripe` on the same Worker) creates or tops up the D1 row, generates the `api_key` (random token) on first purchase, and returns it on the Checkout success page (`website/success.html` or a Worker-rendered page) — this key **is** the account, no email/login required, consistent with the product's no-accounts positioning.
- No recurring billing in v1 — matches Kuan's earlier lean toward one-time/prepaid over subscription, and prepaid credits are simpler to reason about with per-call costs this small.

### 2c. Extension changes
- `extension/lib/config.js`: add `mode: 'local' | 'cloud'` and `cloudApiKey` to both platform config defaults (`DEFAULTS.x`, `DEFAULTS.youtube`).
- `extension/background/worker.js`: `getConfig()` resolves `ollamaUrl` to the cloud Worker URL when `mode === 'cloud'`, and all `fetch(ollamaUrl + '/api/chat', ...)` calls add `headers: {Authorization: 'Bearer ' + cloudApiKey}` when in cloud mode (local Ollama ignores the extra header, so this can be unconditional — simpler than branching per call site).
- `extension/content/core/indicator.js`: extend `renderSettings()` (pattern already there — see the existing `<select>`/`<input>` construction around line 140-171) with a Local/Cloud mode toggle, an API-key input (shown only in cloud mode), and a credit-balance display (fetched from `GET /api/balance`).
- `manifest.json`: add the Worker's domain to `host_permissions`.

### 2d. Website
- Add a pricing section to `website/index.html` (credit packs, "no account, no subscription" framing) with Stripe Checkout buttons.
- Privacy policy addendum: cloud mode sends tweet/video text to the Worker → Groq for classification (not stored beyond the request) — must be explicit since it changes the "100% local" claim that's currently true and marketed.

---

## Verification

**Phase 1:**
- Load unpacked extension with new icons, confirm `chrome://extensions` shows them correctly at all 3 sizes.
- `bun run eval:x` / `bun run eval:youtube` still pass (no classification logic touched).
- Manually load `website/index.html` locally and check responsive layout before deploying.
- After `wrangler pages deploy`, hit `snratio.xyz` and confirm it serves the new page (not stale old content — check via curl, avoid relying on browser cache).

**Phase 2:**
- Local `wrangler dev` against the new Worker, curl `/api/chat` with a test payload, confirm response shape matches what `worker.js`'s `.then(data => data.message.content)` expects.
- Stripe test-mode checkout (`4242 4242 4242 4242`) → confirm D1 row created/topped-up → confirm extension in cloud mode successfully classifies using the returned key.
- Confirm balance hits 0 → 402 → extension surfaces an "out of credits, top up" state rather than silently failing.
- Re-run `bun run eval:x` / `eval:youtube` pointed at cloud mode (may need a `--endpoint` flag on the eval scripts, or a temporary config swap) to confirm hosted-model accuracy doesn't regress below the local-model baseline before advertising it as equivalent.

---

## Open decisions to confirm before I start building

1. Phase 1 first (ship the relaunch this week), then Phase 2 as a separate follow-up — or build both before shipping either?
2. OK to spend Cloudflare/Stripe account setup time (new Worker project, D1 database, Stripe account/product) as part of this, or do you want to set those up yourself and hand me API tokens?
