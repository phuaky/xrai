-- rai-cloud D1 schema. Apply with:
--   wrangler d1 execute rai-cloud --file=./schema.sql [--remote]

CREATE TABLE IF NOT EXISTS api_keys (
  api_key TEXT PRIMARY KEY,
  -- credits stored in fractional cents (REAL) — real per-call cost is
  -- ~$0.00002, so integer cents would lose all precision.
  credit_balance_cents REAL NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  -- IP that minted the key via /api/free-key — the per-IP abuse cap.
  created_ip TEXT
);
