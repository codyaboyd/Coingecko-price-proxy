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

4. Validate the asset configuration:

   ```bash
   npm run validate-assets
   ```

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

## Scripts

- `./start.sh` - prepare runtime directories, install dependencies when needed, run migrations, validate assets, and start the app in the `chrono-cache` screen session with logs written to `logs/server.log`.
- `./stop.sh` - safely stop the `chrono-cache` screen session.
- `./restart.sh` - stop and then start the managed `chrono-cache` screen session.
- `npm start` - run the Express server directly.
- `npm run dev` - run the server with `nodemon`.
- `npm run migrate` - run `node scripts/cli.js migrate` to apply pending SQLite migrations.
- `npm run validate-assets` - run `node scripts/cli.js validate-assets` to validate `config/assets.json`.
- `npm run backup-db` - run `node scripts/cli.js backup-db` to create a SQLite backup under `data/backups`.
- `npm run export-history -- --asset btc --format csv` - export stored candle history.
- `npm run repair-gaps -- --asset btc --from 2025-01-01 --to 2025-01-31 --interval 1d` - enqueue and run gap repair fetch jobs in the CLI process.
- `npm run queue-status` - print the CLI limitation for inspecting the in-memory server queue.
- `npm run import` - placeholder for future import tooling.
- `npm run convert` - placeholder for future conversion tooling.
- `npm run backup` - alias for `npm run backup-db`.

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

Create a SQLite database backup at `data/backups/history-YYYYMMDD-HHMMSS.sqlite`. The backup command uses SQLite's backup API so it can safely copy the configured database even when WAL mode is enabled.

```bash
node scripts/cli.js backup-db
npm run backup-db
```

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

- `.env.example` documents supported environment variables, including `APP_NAME`, `LOG_LEVEL`, and path overrides.
- `config/server.json` contains default server settings.
- `config/assets.json` contains BTC and ETH examples. Each asset must define `id`, `symbol`, `name`, `coingeckoId`, `vsCurrency`, `enabled`, and `priority`.
- `src/utils/env.js` loads `.env` with `dotenv` and validates required runtime configuration.
- `src/utils/logger.js` provides simple leveled logging with `debug`, `info`, `warn`, and `error`.

## Notes

Bun compatibility is allowed for the future, but this scaffold avoids Bun-only APIs and uses Node.js as the default runtime.
