# chrono-cache

`chrono-cache` is a Node.js and Express application for caching cryptocurrency OHLCV price history in SQLite and serving it through a small local API.

## Stack

- Plain JavaScript
- Node.js runtime by default
- Express server
- EJS server-rendered admin pages
- Bootstrap 5 UI
- SQLite persistence for cached OHLCV candles

## Project structure

```text
server.js
src/app.js
src/routes/
src/services/
src/db/
src/jobs/
src/utils/
scripts/
views/
public/
config/
data/
logs/
```

## Setup

1. Install dependencies:

   ```bash
   npm install
   ```

2. Create local environment configuration:

   ```bash
   cp .env.example .env
   ```

3. Run database migrations:

   ```bash
   npm run migrate
   ```

4. Set admin credentials in `.env` before opening the admin UI:

   ```dotenv
   ADMIN_USERNAME=admin
   ADMIN_PASSWORD=use-a-strong-password
   ADMIN_SESSION_SECRET=use-a-long-random-secret
   ```

5. Validate the asset configuration:

   ```bash
   npm run validate-assets
   ```

6. Check runtime compatibility:

   ```bash
   npm run check-runtime
   ```

7. Run the smoke test suite:

   ```bash
   npm test
   npm run smoke
   ```

## CoinGecko rate-budget safe mode

CoinGecko counts failed requests against the rate limit, so the fetch system includes a conservative budget planner. Configure these environment variables in `.env` or the process environment:

- `COINGECKO_MAX_CALLS_PER_MINUTE` - configured CoinGecko request budget; defaults to `8` for conservative free-tier operation.
- `COINGECKO_SAFE_MODE=true` - enables conservative behavior. After any `429` response the effective rate drops to 50% and slowly recovers over time, and internal request retries are kept deliberately low.

The admin planner is available at `/admin/rate-budget` and shows calls used this minute, safe remaining calls, projected queued work, estimated drain time, and assets that are expensive to backfill. Manual backfill controls also warn before queueing large call-consuming work.

## Running the app

Start the server directly:

```bash
npm start
```

For production-friendly single-command startup, use the included shell script:

```bash
./start.sh
```

The startup script creates `logs`, `data`, `imports`, `exports`, and `backups` when needed, installs dependencies if `node_modules` is missing, runs migrations, validates assets, and starts the app in a Linux `screen` session named `chrono-cache`. Node.js is preferred by default; set `USE_BUN=1` to prefer Bun when it is available.

After startup, attach to the running session or stream the server log with:

```bash
screen -r chrono-cache
tail -f logs/server.log
```

If the `chrono-cache` screen session already exists, `./start.sh` prints the attach and log commands without starting a duplicate app instance.

Stop or restart the managed screen session with:

```bash
./stop.sh
./restart.sh
```

For development with automatic restarts:

```bash
npm run dev
```

Open the app:

- Admin: <http://127.0.0.1:3000/admin>
- API docs: <http://127.0.0.1:3000/docs>
- Health: <http://127.0.0.1:3000/health>

The admin dashboard shows app status, runtime, loaded asset count, asset config path, and database path.


## Querying cached prices

The public price API is read-only, unauthenticated, and served from the local SQLite cache. It does **not** call CoinGecko during a request, so query results depend on the candles that have already been imported, fetched, or backfilled.

After starting the app, open the interactive docs at <http://127.0.0.1:3000/docs> or the generated OpenAPI-style document at <http://127.0.0.1:3000/api/v1/openapi.json>.

### 1. Find available assets

Use the assets endpoint to discover the IDs, symbols, quote currencies, and cached range hints that can be queried:

```bash
curl http://127.0.0.1:3000/api/v1/assets
```

Example response shape:

```json
{
  "assets": [
    {
      "id": "btc",
      "symbol": "BTC",
      "name": "Bitcoin",
      "vsCurrency": "usd",
      "earliestTs": 1704067200000,
      "latestTs": 1706745600000
    }
  ]
}
```

You can also inspect one asset directly:

```bash
curl http://127.0.0.1:3000/api/v1/assets/btc
```

### 2. Query price history

Use `GET /api/v1/history/:assetId` to read cached candles. Each candle includes millisecond `ts`, OHLC prices, optional `volume`, optional `marketCap`, and `fetchedAt`. The most commonly consumed spot price is the candle `close` value.

```bash
curl 'http://127.0.0.1:3000/api/v1/history/btc?interval=1d&vs=usd&limit=5'
```

Example response shape:

```json
{
  "asset": { "id": "btc", "symbol": "BTC", "name": "Bitcoin", "vsCurrency": "usd" },
  "vsCurrency": "usd",
  "interval": "1d",
  "from": 1704067200000,
  "to": 1704412800000,
  "source": "local",
  "count": 5,
  "candles": [
    {
      "assetId": "btc",
      "vsCurrency": "usd",
      "interval": "1d",
      "ts": 1704067200000,
      "open": 42280.12,
      "high": 43100.55,
      "low": 41875.44,
      "close": 42925.18,
      "volume": 123456789.01,
      "marketCap": 840000000000,
      "fetchedAt": "2026-01-01T00:00:00.000Z"
    }
  ]
}
```

Useful query parameters:

| Parameter | Default | Description |
| --- | --- | --- |
| `interval` | `1d` | Candle size. Supported values are `1m`, `5m`, `1h`, and `1d`. |
| `from` / `to` | cached range | ISO date (`2026-01-31`), ISO timestamp, or millisecond timestamp bounds. |
| `vs` | asset default | Quote currency such as `usd`. Must be a 2-20 character lowercase-compatible code using letters, numbers, `_`, or `-`. |
| `limit` | `1000` | Maximum candles to return. Must be `1` through `5000`. |
| `format` | `json` | Use `format=csv` to download CSV instead of JSON. |
| `fill` | `none` | Use `fill=previous` to synthesize missing candles from the previous close. |
| `cache` | response cache enabled | Use `cache=bypass` to skip the local API response cache. |

Date-range safeguards are interval-specific: `1m` and `5m` queries allow up to 31 days, `1h` queries allow up to two leap years, and `1d` queries allow up to 20 leap years.

### Common query examples

Get the latest five daily BTC candles:

```bash
curl 'http://127.0.0.1:3000/api/v1/history/btc?interval=1d&vs=usd&limit=5'
```

Get hourly ETH candles for January 2026:

```bash
curl 'http://127.0.0.1:3000/api/v1/history/eth?interval=1h&vs=usd&from=2026-01-01&to=2026-01-31&limit=744'
```

Download daily BTC candles as CSV:

```bash
curl -o btc-daily.csv 'http://127.0.0.1:3000/api/v1/history/btc?interval=1d&vs=usd&format=csv&limit=365'
```

Read the latest cached close with `jq`:

```bash
curl -s 'http://127.0.0.1:3000/api/v1/history/btc?interval=1d&vs=usd&limit=1' | jq '.candles[-1].close'
```

## Admin authentication

Admin access is protected with a simple signed-cookie session login. Configure these environment variables in `.env` or the process environment:

- `ADMIN_USERNAME` - admin login username.
- `ADMIN_PASSWORD` - admin login password.
- `ADMIN_SESSION_SECRET` - long random secret used to sign the admin session cookie.

Protected routes:

- `/admin` and all nested admin pages.
- `/api/v1/admin/*` maintenance endpoints.

Public routes remain available without admin authentication:

- `/api/v1/health`
- `/api/v1/assets`
- `/api/v1/history/:assetId`
- `/health`

Use `/admin/login` to sign in and `/admin/logout` to clear the session. The app also sends security headers with Helmet and logs each request with method, path, status code, duration, and remote address.

## Testing

The project uses plain JavaScript and Node's built-in test runner. The practical smoke suite is in `tests/smoke.test.js` and uses temporary SQLite databases so it does not modify `data/history.sqlite`. Sample import data lives under `test-fixtures/`.

Run all smoke checks with either command:

```bash
npm test
npm run smoke
```

The suite checks that configuration loads, migrations apply, assets validate, fake candle inserts work, the history API returns candles, unknown assets return `404`, the import converter handles the sample CSV fixture, and the gap detector reports missing candles.

## Scripts

- `./start.sh` - prepare runtime directories, install dependencies when needed, run migrations, validate assets, and start the app in the `chrono-cache` screen session with logs written to `logs/server.log`.
- `./stop.sh` - safely stop the `chrono-cache` screen session.
- `./restart.sh` - stop and then start the managed `chrono-cache` screen session.
- `./update.sh` - create emergency backups, install dependencies, run self-check, migrations, tests, restart the managed app, and print the health check URL.
- `./rollback.sh` - restore the latest emergency update backup, restore previous config and `.env` backups when available, run migrations, and start the app.
- `npm start` - run the Express server directly.
- `npm run dev` - run the server with `nodemon`.
- `npm run migrate` - run `node scripts/cli.js migrate` to apply pending SQLite migrations.
- `npm run validate-assets` - run `node scripts/cli.js validate-assets` to validate `config/assets.json`.
- `npm run check-runtime` - run `node scripts/check-runtime.js` to verify Node.js, optional Bun, npm, GNU screen, `better-sqlite3`, required package scripts, required directories, `package-lock.json`, and `node_modules` without upgrading dependencies.
- `npm test` - run Node's built-in test runner against the practical smoke suite in `tests/smoke.test.js`.
- `npm run smoke` - alias for the same practical smoke checks used by `npm test`.
- `npm run backup-db` - run `node scripts/cli.js backup-db` to create a SQLite backup under `data/backups`.
- `npm run bundle` - create a portable migration bundle under `data/exports/chrono-cache-bundle-YYYY-MM-DD-HH-mm-ss.tar.gz`.
- `npm run export-history -- --asset btc --format csv` - export stored candle history.
- `npm run repair-gaps -- --asset btc --from 2025-01-01 --to 2025-01-31 --interval 1d` - enqueue and run gap repair fetch jobs in the CLI process.
- `npm run queue-status` - print persisted scheduler queue counts from SQLite.
- `npm run import -- ./data/imports/converted/btc-old.normalized.json --policy fill_only_missing` - import normalized historical candles.
- `npm run convert -- ./data/imports/btc-old.csv --asset btc --vs usd --interval 1d --output data/imports/converted/btc-old.normalized.json` - convert CSV/JSON dumps to normalized import JSON. Add `--input-format unix-ohlcv-60s` for `Timestamp, Open, High, Low, Close, Volume` CSVs with Unix-second 60-second windows.
- `npm run backup` - alias for `npm run backup-db`.
- `npm run restore -- ./data/backups/history-YYYY-MM-DD-HH-mm-ss.sqlite` - safely restore a backup from `data/backups`.


### Portable server migration bundle

Create a portable tarball for moving the app to a new server:

```bash
npm run bundle
```

The bundle is written to `data/exports/chrono-cache-bundle-YYYY-MM-DD-HH-mm-ss.tar.gz` and includes:

- `config/`
- `data/history.sqlite`; if the live database is missing, the latest `data/backups/history-*.sqlite` backup is copied into the bundle as `data/history.sqlite`
- `package.json`
- `package-lock.json` when present
- server files: `server.js`, `src/`, `views/`, `public/`, and `scripts/`
- `start.sh`, `stop.sh`, and `restart.sh`
- `README.md`
- `PORTABLE-RESTORE.md` with short restore steps

The bundle excludes `node_modules`, `logs`, generated exports, and the real `.env` file by default. To intentionally include the real `.env`, run:

```bash
EXPORT_ENV=1 npm run bundle
```

Restore on the new server:

1. Extract the bundle:

   ```bash
   tar -xzf data/exports/chrono-cache-bundle-YYYY-MM-DD-HH-mm-ss.tar.gz
   cd chrono-cache-bundle-YYYY-MM-DD-HH-mm-ss
   ```

2. Copy your real `.env` into the extracted directory:

   ```bash
   cp /secure/path/to/.env .env
   ```

3. Start the app:

   ```bash
   ./start.sh
   ```

The admin dashboard also has a **Create portable bundle** button in the Migration card. It creates the same archive under `data/exports/` without exporting `.env` unless the running server process was started with `EXPORT_ENV=1`.

## Safe update process

Use the included safe update workflow when refreshing a solo-developer deployment. It keeps the app running while checks are performed, creates an emergency backup first, and only restarts the managed `screen` session after every update step passes.

```bash
./update.sh
```

`update.sh` performs these steps in order:

1. Creates an emergency update backup under `data/update-backups/emergency-YYYY-MM-DD-HH-MM-SS/`.
2. Runs `npm run backup-db` so the normal SQLite backup list also has a fresh backup.
3. Copies the current database to the emergency backup directory when it exists.
4. Copies the current `config/` directory and `.env` file, when available, to the emergency backup directory.
5. Runs `npm install`.
6. Runs `npm run self-check`.
7. Runs `npm run migrate`.
8. Runs `npm run test`.
9. Restarts the app with `./restart.sh`.
10. Prints the final health check URL, usually `http://127.0.0.1:3000/health`.

If any backup, install, self-check, migration, or test step fails, the script stops immediately and does **not** restart the app. If the final restart step fails, the script stops and prints rollback instructions so you can restore the emergency backup and start the app again.

### How to update safely

1. Commit or otherwise save your code changes before updating.
2. Run the safe workflow:

   ```bash
   ./update.sh
   ```

3. Open the health URL printed at the end of the script.
4. If the health check is not healthy, use the rollback workflow below.

### How to rollback

Use the rollback script to restore the latest emergency backup created by `update.sh`:

```bash
./rollback.sh
```

`rollback.sh` finds the newest `data/update-backups/emergency-*` directory, stops the managed app session, restores `history.sqlite` to the configured database path, removes stale SQLite WAL/SHM files, restores the previous `config/` backup if one exists, restores the previous `.env` backup if one exists, runs migrations, and starts the app again.

If the rollback script cannot continue, it prints manual rollback instructions. The manual process is to stop the app with `./stop.sh`, copy `history.sqlite` from the newest emergency backup to the configured database path, copy files from that backup's `config/` directory back into `./config/` if needed, and start the app with `./start.sh`.

## Maintenance CLI

Maintenance utilities are centralized in `scripts/cli.js` and use plain JavaScript. Commands can be run directly with `node scripts/cli.js <command>` or through the matching npm scripts. Options may be passed as `--name value` or `--name=value`.

### `migrate`

Apply any pending SQLite schema migrations to the configured database.

```bash
node scripts/cli.js migrate
npm run migrate
```

### `validate-assets`

Validate the configured asset file, usually `config/assets.json`, and print the number of valid assets.

```bash
node scripts/cli.js validate-assets
npm run validate-assets
```

### `backup-db`

Create a SQLite database backup at `data/backups/history-YYYY-MM-DD-HH-mm-ss.sqlite`. The backup command uses SQLite's backup API so it can safely copy the configured database even when WAL mode is enabled.

```bash
node scripts/cli.js backup-db
npm run backup-db
```


### `restore`

Safely restore a SQLite backup from `data/backups`. The restore command refuses files outside `data/backups`, validates the SQLite header and integrity check, checks for expected application tables, creates an emergency copy of the current database under `data/backups/emergency/`, moves the current database files into that emergency directory, copies the selected backup into the configured database path, and runs migrations. Every attempt is appended to `data/backups/restore-attempts.log`.

The CLI confirmation is the backup filename you type as the positional argument:

```bash
npm run restore -- ./data/backups/history-YYYY-MM-DD-HH-mm-ss.sqlite
```

The admin UI provides the same workflow at `/admin/backups/restore`; it requires typing the selected backup filename or `RESTORE BACKUP` before the restore starts.

### `export-history`

Export stored asset candles to CSV or JSON. If `--output` is omitted, the export is written to standard output; if `--output` is provided, parent directories are created automatically.

Options:

- `--asset` / `--assetId` - required asset ID.
- `--from` - optional start timestamp as `YYYY-MM-DD`, ISO date string, or millisecond timestamp.
- `--to` - optional end timestamp as `YYYY-MM-DD`, ISO date string, or millisecond timestamp.
- `--interval` - optional candle interval: `1m`, `5m`, `1h`, or `1d`; defaults to `1d`.
- `--vs` / `--vsCurrency` - optional quote currency; defaults to the asset's configured `vsCurrency`.
- `--format` - optional output format: `csv` or `json`; defaults to `csv`.
- `--output` - optional destination file path.

Examples:

```bash
node scripts/cli.js export-history --asset btc --from 2025-01-01 --to 2025-01-31 --interval 1d --vs usd --format csv --output exports/btc-2025-01.csv
node scripts/cli.js export-history --asset eth --format json
```

### `repair-gaps`

Find missing candle windows for an asset and enqueue `gap_repair` jobs in the current CLI process. Because the job queue is currently in-memory, these jobs are not inserted into a running server process. The CLI starts its own scheduler, lets the queued repair jobs drain, and reports recent failures before exiting.

Options:

- `--asset` / `--assetId` - required asset ID.
- `--from` - required start timestamp as `YYYY-MM-DD`, ISO date string, or millisecond timestamp.
- `--to` - required end timestamp as `YYYY-MM-DD`, ISO date string, or millisecond timestamp.
- `--interval` - optional candle interval: `1m`, `5m`, `1h`, or `1d`; defaults to `1d`.
- `--vs` / `--vsCurrency` - optional quote currency; defaults to the asset's configured `vsCurrency`.

Example:

```bash
node scripts/cli.js repair-gaps --asset btc --from 2025-01-01 --to 2025-01-31 --interval 1d --vs usd
```

### `queue-status`

Print persisted scheduler queue counts from SQLite. Use the admin dashboard/API for live in-process details while the server is running.

```bash
node scripts/cli.js queue-status
npm run queue-status
```

## Configuration

- `.env.example` documents supported environment variables, including `APP_NAME`, `LOG_LEVEL`, admin authentication credentials, and path overrides.
- `config/server.json` contains default server settings.
- `config/assets.json` contains BTC and ETH examples. Each asset must define `id`, `symbol`, `name`, `coingeckoId`, `vsCurrency`, `enabled`, and `priority`.
- `src/utils/env.js` loads `.env` with `dotenv`; when `.env` is absent it falls back to `.env.example` so a fresh checkout can run, but production should use a real `.env` with strong admin credentials.
- `src/utils/logger.js` provides simple leveled logging with `debug`, `info`, `warn`, and `error`.

## Notes

Bun compatibility is allowed for the future, but this scaffold avoids Bun-only APIs and uses Node.js as the default runtime.

## Operations Guide

### Architecture

Chrono Cache is a plain JavaScript Node.js/Express app backed by SQLite. The public API serves cached candle history from the local database, while the Bootstrap 5 admin UI manages assets, imports, backfill requests, cache state, and scheduler status. Runtime responsibilities are split across:

- `server.js` for startup, shutdown, and fatal startup reporting.
- `src/app.js` for Express middleware, Bootstrap-compatible server-rendered views, API routes, request logging, and in-memory API rate limiting.
- `src/db/` for SQLite connection setup, migrations, and query helpers.
- `src/services/` for CoinGecko access, import conversion, candle normalization, cache policy, history reads/writes, and config hot reload.
- `src/jobs/` for the in-memory fetch/backfill scheduler and recent-refresh scheduler.
- `config/` for server and asset configuration.
- `data/` for SQLite data, backups, and import files.


### Disaster recovery: restoring a backup

Use this workflow when the live SQLite database is corrupted, an import went wrong, or you need to roll back to a known backup.

1. Identify the backup under `data/backups/`. Valid restore sources use the `history-YYYY-MM-DD-HH-mm-ss.sqlite` filename format.
2. Prefer stopping the long-running server if you are using the CLI restore path:

   ```bash
   ./stop.sh
   ```

3. Run the safe restore command, typing the selected backup path as the argument:

   ```bash
   npm run restore -- ./data/backups/history-YYYY-MM-DD-HH-mm-ss.sqlite
   ```

4. Restart the app and verify health:

   ```bash
   ./start.sh
   npm run self-check
   ```

5. Review `data/backups/restore-attempts.log` and the emergency files in `data/backups/emergency/`. Keep the emergency backup until you have verified the restored history.

If the web server is running and admin access is available, you can instead open `/admin/backups/restore`. The admin workflow stops scheduler timers, creates the emergency backup, validates the selected SQLite file and expected tables, moves the current DB aside, copies the backup into place, runs migrations, and restarts in-memory asset and scheduler state.

### Setup

1. Install Node.js 20 or newer.
2. Install dependencies:

   ```bash
   npm install
   ```

3. Review `config/server.json` and `config/assets.json`.
4. Optionally create a `.env` file for secrets and overrides such as admin credentials, `COINGECKO_API_KEY`, `COINGECKO_API_KEY_TYPE`, `COINGECKO_MAX_CALLS_PER_MINUTE`, and API rate-limit settings.
5. Initialize or upgrade the database:

   ```bash
   npm run migrate
   ```

6. Validate assets:

   ```bash
   npm run validate-assets
   ```

7. Start the app:

   ```bash
   npm start
   ```

Startup failures are logged with the failing phase and file/path details where available. Invalid JSON config files and invalid asset configs fail fast at startup, but invalid hot-reload edits are rejected without replacing the last valid in-memory config.

### Running with `screen`

A simple long-running deployment can use GNU screen:

```bash
cd /path/to/chrono-cache
screen -S chrono-cache
npm start
```

Detach with `Ctrl+A`, then `D`. Reattach with:

```bash
screen -r chrono-cache
```

To stop the app, reattach and press `Ctrl+C`, or run:

```bash
screen -S chrono-cache -X quit
```

The repository also includes `start.sh`, `stop.sh`, and `restart.sh` helpers if you prefer script-based operation.

### Admin Usage

Open `/admin` in a browser and sign in with the configured admin username and password. The admin UI remains server-rendered Bootstrap 5 and provides:

- Dashboard status for assets, scheduler queue depth, recent failures, API cache stats, and hot-reload state.
- Asset list/detail pages with candle bounds and fetch-run history.
- Asset edit forms that validate fields, write a timestamped config backup, and reload safe in-memory state.
- CoinGecko test fetch, local history test, gap-report test, and recent-refresh enqueue actions.
- Import preview/import pages limited to files under `data/imports`.

### API Usage

Public endpoints are under `/api/v1`:

```bash
curl http://127.0.0.1:3000/api/v1/health
curl http://127.0.0.1:3000/api/v1/assets
curl 'http://127.0.0.1:3000/api/v1/history/btc?interval=1d&from=2026-01-01&to=2026-01-31&limit=1000'
```

CoinGecko-compatible drop-in endpoints are also exposed under `/api/v3`, so clients that already call CoinGecko can point their base URL at this service and keep the same response shapes for common price/history reads:

```bash
curl 'http://127.0.0.1:3000/api/v3/simple/price?ids=bitcoin&vs_currencies=usd&include_market_cap=true&include_24hr_vol=true&include_last_updated_at=true'
curl 'http://127.0.0.1:3000/api/v3/coins/bitcoin/market_chart?vs_currency=usd&days=max&interval=daily'
curl 'http://127.0.0.1:3000/api/v3/coins/bitcoin/market_chart/range?vs_currency=usd&from=2026-01-01&to=2026-01-31&interval=daily'
```

Supported CoinGecko-compatible endpoints:

- `GET /api/v3/ping`
- `GET /api/v3/simple/price` with comma-separated `ids` and `vs_currencies`; optional `include_market_cap`, `include_24hr_vol`, `include_last_updated_at`, and `precision`.
- `GET /api/v3/coins/:id/market_chart` with `vs_currency`, `days`, optional `interval` (`5m`, `hourly`, `daily`), and optional `precision`.
- `GET /api/v3/coins/:id/market_chart/range` with `vs_currency`, `from`, `to`, optional `interval` (`5m`, `hourly`, `daily`), and optional `precision`.

The `/api/v3` endpoints resolve CoinGecko coin IDs from the configured asset `coingeckoId` values, read only the local cache, and return CoinGecko-style `prices`, `market_caps`, and `total_volumes` arrays where applicable.

History parameters:

- `interval`: `1m`, `5m`, `1h`, or `1d`.
- `from` / `to`: `YYYY-MM-DD`, millisecond timestamp, or ISO-8601 timestamp with timezone.
- `vs`: 2-20 character quote currency code; defaults to the asset config.
- `format`: `json` or `csv`.
- `fill`: `none` or `previous`.
- `limit`: defaults to `1000`, maximum `5000`.

The API applies in-memory per-client rate limiting. Limited responses return HTTP `429`, `Retry-After`, and `RateLimit-*` headers. CoinGecko `429` responses pause the shared CoinGecko queue and retry with backoff instead of crashing the app.

### Import Workflow

1. Copy CSV or JSON files into `data/imports`.
2. Open `/admin/imports`.
3. Select a file, asset, interval, conflict policy, and input format.
4. Review the preview.
5. Run the import.

Choose `Unix OHLCV 60s` on the admin import page, or pass `--input-format unix-ohlcv-60s` to the converter CLI, for native CSV files with `Timestamp, Open, High, Low, Close, Volume` headers where `Timestamp` is the Unix-second start of each 60-second window and `Volume` is base-asset volume (for example BTC transacted). The preset imports those files as `1m` candles and stores volume unchanged.

Import preview and import execution resolve real paths and reject absolute paths, `..` traversal, oversized files, non-files, and symlinks that point outside `data/imports`. Raw dumps are converted into `.normalized.json` files under `data/imports/converted`; normalized imports are written to SQLite and recorded in `import_runs`.

### Backfill Workflow

Use the admin asset page or the authenticated admin API to find gaps and enqueue backfill jobs. Backfill requests validate dates, interval, quote currency, conflict policy, maximum range, and maximum job count before queueing work. Jobs are persisted in SQLite and call CoinGecko through the shared limiter; queued work survives restarts, and stale running jobs are recovered by the scheduler.

Example admin API request after login/session setup:

```bash
curl -X POST http://127.0.0.1:3000/api/v1/admin/assets/btc/backfill \
  -H 'Content-Type: application/json' \
  -d '{"from":"2026-01-01","to":"2026-01-31","interval":"1d","vsCurrency":"usd","conflictPolicy":"fill_only_missing"}'
```

### Troubleshooting

- **Startup fails immediately:** check the logged file path and message for invalid JSON, missing config, invalid port, failed SQLite open, or invalid assets.
- **Hot reload shows an error:** fix `config/assets.json` or `config/server.json`; the app keeps using the last valid config until a valid file is saved.
- **API returns `429`:** slow clients down or increase `API_RATE_LIMIT_MAX` / `API_RATE_LIMIT_WINDOW_MS` if the deployment needs a higher in-memory limit.
- **CoinGecko requests fail or return `429`:** verify API key type/key, reduce `COINGECKO_MAX_CALLS_PER_MINUTE`, and review scheduler recent failures in the admin dashboard.
- **Import preview fails:** ensure the file is inside `data/imports`, is not a symlink outside that directory, is below the admin import size cap, and contains supported CSV/JSON columns.
- **Backfill queues too many jobs:** narrow the date range, use a coarser interval, or increase chunk size intentionally in code/config before retrying.
- **Queue status looks different between CLI and admin:** the CLI reads persisted SQLite jobs, while the admin dashboard can also show live in-process scheduler state.
