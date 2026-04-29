# CoinGecko History Proxy

A lightweight Node.js service that:

- keeps a local SQLite time-series cache of CoinGecko prices,
- backfills historical hourly candles in chunks,
- continuously syncs recent data on an interval,
- and exposes simple HTTP APIs for assets, history, latest cached prices, and live prices.

This is useful when you want a fast internal price endpoint without repeatedly hammering external APIs.

---

## Features

- **SQLite-backed cache** (`better-sqlite3`) for historical and latest prices.
- **Automatic startup bootstrap** from `assets.json`.
- **Periodic sync loop** for all enabled assets.
- **Backfill support** for newly added assets (configurable number of days).
- **Rate-limited outbound requests** to CoinGecko (`p-limit` + configurable delay).
- **Manual sync endpoint** for one-off refreshes.
- **Live passthrough endpoint** (`/api/live-price`) that also writes returned prices into the local cache.

---

## How it works

1. On startup, the server opens/creates a SQLite database.
2. It creates required tables (`assets`, `price_points`, `sync_state`) if missing.
3. It loads assets from `assets.json` (if present) into `assets`.
4. It starts Express on `PORT`.
5. It immediately performs one sync for all enabled assets.
6. It repeats that sync every `UPDATE_INTERVAL_MS`.

For each asset sync:

- If history exists, it refetches with a small overlap (6 hours) to heal gaps.
- If no history exists, it backfills `BACKFILL_DAYS` into the past.
- Requests are chunked by `BACKFILL_CHUNK_DAYS` because CoinGecko market chart range is limited.

---

## Requirements

- **Node.js 18+** (uses native `fetch` and ESM modules).
- npm (or compatible package manager).

---

## Quick start

```bash
npm install
cp .env.example .env   # optional if you create one
npm run dev
```

If you are not using an `.env` file, you can export variables directly before running `npm start`.

---

## Environment variables

| Variable | Default | Description |
|---|---:|---|
| `PORT` | `8080` | HTTP port for this proxy. |
| `DB_PATH` | `./price-history.sqlite` | SQLite database file path. |
| `COINGECKO_PLAN` | `demo` | `demo` uses public base URL, `pro` uses pro base URL. |
| `COINGECKO_DEMO_API_KEY` | empty | Optional demo key sent as `x-cg-demo-api-key`. |
| `COINGECKO_PRO_API_KEY` | empty | Optional pro key sent as `x-cg-pro-api-key` when `COINGECKO_PLAN=pro`. |
| `COINGECKO_REQUEST_DELAY_MS` | `2500` | Minimum delay between outbound CoinGecko calls (global). |
| `UPDATE_INTERVAL_MS` | `300000` | Background sync interval in ms (default 5 min). |
| `BACKFILL_DAYS` | `365` | Initial backfill depth when an asset has no data. |
| `BACKFILL_CHUNK_DAYS` | `90` | Days per range chunk request. |
| `DEFAULT_VS_CURRENCY` | `usd` | Fallback quote currency for assets and endpoints. |

### Example `.env`

```env
PORT=8080
DB_PATH=./price-history.sqlite

COINGECKO_PLAN=demo
COINGECKO_DEMO_API_KEY=
COINGECKO_PRO_API_KEY=

COINGECKO_REQUEST_DELAY_MS=2500
UPDATE_INTERVAL_MS=300000
BACKFILL_DAYS=365
BACKFILL_CHUNK_DAYS=90
DEFAULT_VS_CURRENCY=usd
```

---

## Asset bootstrap (`assets.json`)

On startup, if `./assets.json` exists, the server upserts all entries.

Example:

```json
[
  { "id": "bitcoin", "symbol": "btc", "name": "Bitcoin", "vs_currency": "usd", "enabled": true },
  { "id": "ethereum", "symbol": "eth", "name": "Ethereum", "enabled": true },
  { "id": "dogecoin", "enabled": false }
]
```

Fields:

- `id` (required): CoinGecko coin ID.
- `symbol` (optional)
- `name` (optional)
- `vs_currency` (optional, defaults to `DEFAULT_VS_CURRENCY`)
- `enabled` (optional, defaults to `true`)

---

## API reference

Base URL examples assume `http://localhost:8080`.

### `GET /health`
Basic process health and configuration echo.

### `GET /api/assets`
List tracked assets from local DB.

### `POST /api/assets`
Upsert assets.

Request body:

```json
{
  "assets": [
    { "id": "bitcoin", "symbol": "btc", "name": "Bitcoin", "enabled": true }
  ]
}
```

### `POST /api/sync`
Run immediate sync.

- Without body IDs: sync all enabled assets.
- With IDs: sync only specified IDs.

Request body examples:

```json
{}
```

```json
{
  "ids": ["bitcoin", "ethereum"],
  "vs_currency": "usd"
}
```

### `GET /api/sync-state`
View recent sync metadata and last errors.

### `GET /api/history`
Read cached historical points.

Query params:

- `ids` (required): comma-separated coin IDs.
- `vs_currency` (optional): defaults to `DEFAULT_VS_CURRENCY`.
- `from` (optional): unix seconds, unix ms, or parseable date.
- `to` (optional): unix seconds, unix ms, or parseable date.

Defaults:

- `to = now`
- `from = to - 30 days`

Example:

```bash
curl "http://localhost:8080/api/history?ids=bitcoin,ethereum&from=2026-01-01&to=2026-02-01&vs_currency=usd"
```

### `GET /api/latest`
Read latest cached point per asset from local DB.

- If `ids` omitted, returns all assets with cached points.
- If `ids` provided, returns a key per requested ID (possibly `null` if no cached point).

Example:

```bash
curl "http://localhost:8080/api/latest?ids=bitcoin,ethereum&vs_currency=usd"
```

### `GET /api/live-price`
Fetch live spot prices from CoinGecko `/simple/price`, return payload, and persist returned points locally.

Query params:

- `ids` (required)
- `vs_currency` (optional)

Example:

```bash
curl "http://localhost:8080/api/live-price?ids=bitcoin,ethereum&vs_currency=usd"
```

---

## Useful dev commands

```bash
npm run dev    # watch mode
npm start      # production-style run
```

---

## Notes and caveats

- Ensure your request delay is conservative for your plan limits.
- `/api/latest` only reports data already cached locally; it does not trigger network fetches.
- `/api/live-price` is best for explicit on-demand refreshes.
- For large asset sets, startup backfills can take time due to serialized request throttling.

---

## License

No license file is currently included in this repository. Add one if this project will be distributed.
