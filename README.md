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
- `npm run migrate` - create the initial SQLite schema.
- `npm run validate-assets` - validate `config/assets.json`.
- `npm run import` - placeholder for future import tooling.
- `npm run convert` - placeholder for future conversion tooling.
- `npm run backup` - placeholder for future backup tooling.

## Configuration

- `.env.example` documents supported environment variables, including `APP_NAME`, `LOG_LEVEL`, and path overrides.
- `config/server.json` contains default server settings.
- `config/assets.json` contains BTC and ETH examples. Each asset must define `id`, `symbol`, `name`, `coingeckoId`, `vsCurrency`, `enabled`, and `priority`.
- `src/utils/env.js` loads `.env` with `dotenv` and validates required runtime configuration.
- `src/utils/logger.js` provides simple leveled logging with `debug`, `info`, `warn`, and `error`.

## Notes

Bun compatibility is allowed for the future, but this scaffold avoids Bun-only APIs and uses Node.js as the default runtime.
