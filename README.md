# chrono-cache

`chrono-cache` is an initial MVP scaffold for a Node.js and Express application that will eventually cache cryptocurrency price data. CoinGecko fetching is intentionally **not** implemented yet.

## Stack

- Plain JavaScript
- Node.js runtime by default
- Express server
- EJS server-rendered admin pages
- Bootstrap 5 UI
- SQLite persistence scaffold

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

6. Run the smoke test suite:

   ```bash
   npm test
   npm run smoke
   ```

## CoinGecko rate-budget safe mode

CoinGecko counts failed requests against the rate limit, so the fetch system includes a conservative budget planner. Configure these environment variables in `.env` or the process environment:

- `COINGECKO_MAX_CALLS_PER_MINUTE` - configured CoinGecko request budget; defaults to `20`.
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
- Health: <http://127.0.0.1:3000/health>

The admin dashboard shows app status, runtime, loaded asset count, asset config path, and database path.

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
- `npm start` - run the Express server directly.
- `npm run dev` - run the server with `nodemon`.
- `npm run migrate` - run `node scripts/cli.js migrate` to apply pending SQLite migrations.
- `npm run validate-assets` - run `node scripts/cli.js validate-assets` to validate `config/assets.json`.
- `npm test` - run Node's built-in test runner against the practical smoke suite in `tests/smoke.test.js`.
- `npm run smoke` - alias for the same practical smoke checks used by `npm test`.
- `npm run backup-db` - run `node scripts/cli.js backup-db` to create a SQLite backup under `data/backups`.
- `npm run bundle` - create a portable migration bundle under `data/exports/chrono-cache-bundle-YYYY-MM-DD-HH-mm-ss.tar.gz`.
- `npm run export-history -- --asset btc --format csv` - export stored candle history.
- `npm run repair-gaps -- --asset btc --from 2025-01-01 --to 2025-01-31 --interval 1d` - enqueue and run gap repair fetch jobs in the CLI process.
- `npm run queue-status` - print the CLI limitation for inspecting the in-memory server queue.
- `npm run import` - placeholder for future import tooling.
- `npm run convert` - placeholder for future conversion tooling.
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
- `--interval` - optional candle interval: `5m`, `1h`, or `1d`; defaults to `1d`.
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
- `--interval` - optional candle interval: `5m`, `1h`, or `1d`; defaults to `1d`.
- `--vs` / `--vsCurrency` - optional quote currency; defaults to the asset's configured `vsCurrency`.

Example:

```bash
node scripts/cli.js repair-gaps --asset btc --from 2025-01-01 --to 2025-01-31 --interval 1d --vs usd
```

### `queue-status`

Print the queue-status limitation. The queue is stored in the Express server process memory, so this standalone CLI cannot inspect live queue state without an IPC or HTTP queue-status endpoint. Use the admin dashboard/API queue views while the server is running for live status.

```bash
node scripts/cli.js queue-status
npm run queue-status
```

## Configuration

- `.env.example` documents supported environment variables, including `APP_NAME`, `LOG_LEVEL`, admin authentication credentials, and path overrides.
- `config/server.json` contains default server settings.
- `config/assets.json` contains BTC and ETH examples. Each asset must define `id`, `symbol`, `name`, `coingeckoId`, `vsCurrency`, `enabled`, and `priority`.
- `src/utils/env.js` loads `.env` with `dotenv` and validates required runtime configuration.
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

History parameters:

- `interval`: `5m`, `1h`, or `1d`.
- `from` / `to`: `YYYY-MM-DD`, millisecond timestamp, or ISO-8601 timestamp with timezone.
- `vs`: 2-20 character quote currency code; defaults to the asset config.
- `format`: `json` or `csv`.
- `fill`: `none` or `previous`.
- `limit`: defaults to `1000`, maximum `5000`.

The API applies in-memory per-client rate limiting. Limited responses return HTTP `429`, `Retry-After`, and `RateLimit-*` headers. CoinGecko `429` responses pause the shared CoinGecko queue and retry with backoff instead of crashing the app.

### Import Workflow

1. Copy CSV or JSON files into `data/imports`.
2. Open `/admin/imports`.
3. Select a file, asset, interval, and conflict policy.
4. Review the preview.
5. Run the import.

Import preview and import execution resolve real paths and reject absolute paths, `..` traversal, oversized files, non-files, and symlinks that point outside `data/imports`. Raw dumps are converted into `.normalized.json` files under `data/imports/converted`; normalized imports are written to SQLite and recorded in `import_runs`.

### Backfill Workflow

Use the admin asset page or the authenticated admin API to find gaps and enqueue backfill jobs. Backfill requests validate dates, interval, quote currency, conflict policy, maximum range, and maximum job count before queueing work. Jobs run in process memory and call CoinGecko through the shared limiter, so restarts clear queued jobs that have not started.

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
- **No live queue from CLI:** the scheduler is in-memory inside the server process; use the admin dashboard/API for live queue status.
