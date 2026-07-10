# rai-cloud

Cloudflare Worker + D1 backend for rai's Cloud mode. Speaks the same
`/api/chat` and `/api/tags` request/response shape as Ollama, so the
extension's `background/worker.js` needs no changes beyond swapping the base
URL and adding an `Authorization: Bearer <api_key>` header — see
`CLOUD_URL` in that file.

No accounts system: the `api_key` minted by `POST /api/free-key` *is* the
account (prepaid balance, no email/login). Cloud mode is **free while in
beta** — the balance machinery exists as an abuse cap and so paid top-ups
can return later without an architecture change.

## Local dev

```bash
cd rai-cloud
npx wrangler d1 execute rai-cloud --local --file=./schema.sql
npx wrangler dev --local
```

Test:
```bash
# Mint a key (local D1)
curl -X POST http://localhost:8787/api/free-key

curl -X POST http://localhost:8787/api/chat \
  -H "Authorization: Bearer <key from above>" -H "Content-Type: application/json" \
  -d '{"model":"x","messages":[{"role":"system","content":"reply with OK"},{"role":"user","content":"ping"}],"stream":false,"options":{"num_predict":10}}'
```

## Production deploy

```bash
npx wrangler d1 create rai-cloud       # first time only
# paste the returned database_id into wrangler.toml

npx wrangler d1 execute rai-cloud --remote --file=./schema.sql
npx wrangler secret put GROQ_API_KEY   # first time only

npx wrangler deploy
```

`wrangler.toml` routes the Worker at the custom domain `api.snratio.xyz`
(DNS is on Cloudflare, so the deploy provisions it), matching `CLOUD_URL`
in `extension/background/worker.js`.

## Cost control

`COST_PER_CALL_CENTS = 0.01` in `src/index.js` — flat decrement per
classification, roughly 5x the real Groq cost (~$0.00002/call on
`llama-3.1-8b-instant`). `FREE_GRANT_CENTS = 500` gives each key 50,000
calls (months of normal scrolling); `FREE_KEYS_PER_IP = 3` stops a scripted
mint loop from draining the Groq account. Worst case per key is ~$1 of real
Groq spend, fully consumed.

## Endpoints

| Route | Auth | Purpose |
|---|---|---|
| `POST /api/chat` | Bearer api_key | Classification proxy → Groq, decrements balance |
| `GET /api/tags` | Bearer api_key | Model list (Ollama-shape, for the settings dropdown) |
| `GET /api/balance` | Bearer api_key | Current balance in cents |
| `POST /api/free-key` | none (IP-capped) | Mint a free key preloaded with `FREE_GRANT_CENTS` |
