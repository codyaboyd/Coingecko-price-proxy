# Chrono Cache solo-maintainer runbook

This runbook is for one person operating this repository on a small server. It assumes the app is managed by the included `screen` scripts, stores SQLite data at the configured `databasePath` in `config/server.json`, reads assets from `config/assets.json`, writes logs under `logs/`, and stores database backups under `data/backups/`.

## Golden rules

- Run commands from the repository root.
- Prefer the admin UI for routine actions: `/admin`, `/admin/doctor`, `/admin/assets`, `/admin/backups`, `/admin/rate-budget`, `/admin/logs`, and `/admin/runbook`.
- Before risky work, make a database backup and copy config files.
- Turn maintenance mode on before restores, large imports, server moves, or emergency debugging.
- Do not fetch from CoinGecko blindly. Check local coverage and the rate budget first.

## Daily checks

Open the admin dashboard and health endpoints first.

```bash
cd /path/to/Coingecko-price-proxy
curl -fsS http://127.0.0.1:3000/health
curl -fsS http://127.0.0.1:3000/api/v1/health
```

Check the app process and recent errors.

```bash
screen -ls | grep chrono-cache || true
tail -n 120 logs/server.log
npm run queue-status
npm run jobs:list
```

In the UI, review:

- `/admin` for queued, running, or failed jobs.
- `/admin/doctor` for one-page operational checks and safe fixes.
- `/admin/assets` for stale, empty, or failed asset intervals.
- `/admin/rate-budget` for remaining CoinGecko budget.
- `/admin/logs` for exceptions, 429 responses, and repeated failed requests.

If anything is stale or failed, use the sections below instead of repeatedly pressing fetch buttons.

## Weekly checks

Create and verify a fresh backup, run integrity checks, and prune old backup generations.

```bash
cd /path/to/Coingecko-price-proxy
npm run backup-db
npm run backups:list
npm run db:check
npm test
npm run backups:prune
```

Review admin pages:

- `/admin/db-integrity` for database health and suggested repair commands.
- `/admin/system-health` for stale assets and disk/log/database size warnings.
- `/admin/activity` for recent configuration edits, restores, imports, and job operations.
- `/admin/config-history` for unexpected changes to `config/assets.json` or `config/server.json`.

## Monthly checks

Do a restore drill on a spare directory or new host, verify you know the admin credentials, and export a sample of important history.

```bash
cd /path/to/Coingecko-price-proxy
npm run check-runtime
npm run self-check
npm run validate-assets
npm run export-history -- --asset btc --from 2024-01-01 --to 2024-01-07 --interval 1d --output data/exports/btc-restore-drill.csv
```

Confirm that:

- `data/backups/` contains recent `.sqlite`, `.assets.json`, `.server.json`, and `.manifest.json` files.
- A copy of `.env` or the production secrets exists in your password manager, not only on the server.
- `config/assets.json` contains only assets you actually want refreshed.
- `config/server.json` keeps `coingecko.safeMode` enabled unless you have a paid plan and a tested budget.

## How to add an asset

Best path: use the UI.

- Open `/admin/assets/new`.
- Enter the local asset ID, symbol, name, CoinGecko ID, quote currency, priority, and refresh policy.
- Let the form validate the CoinGecko ID.
- Enable optional initial backfill only for a small range.
- After save, open the asset detail page and confirm staleness and recent fetch runs.

CLI/config path when you cannot use the UI:

```bash
cd /path/to/Coingecko-price-proxy
npm run backup-db
cp config/assets.json "config/assets.json.before-add-$(date -u +%Y%m%dT%H%M%SZ)"
node -e "const fs=require('fs'); const p='config/assets.json'; const cfg=JSON.parse(fs.readFileSync(p,'utf8')); cfg.assets.push({ id:'eth', symbol:'ETH', name:'Ethereum', coingeckoId:'ethereum', vsCurrency:'usd', enabled:true, priority:20, fetchPolicy:{ intervals:['1h','1d'], maxBackfillDaysPerRun:3 } }); fs.writeFileSync(p, JSON.stringify(cfg,null,2)+'\n');"
npm run validate-assets
./restart.sh
```

Then test and backfill carefully.

```bash
npm run cg:test -- ethereum usd
npm run repair-gaps -- --asset eth --from 2024-01-01 --to 2024-02-01 --interval 1d --vs usd
npm run jobs:list
```

Use the real CoinGecko ID from CoinGecko. The local `id` should be short and stable because it is used in URLs and candle rows.

## How to import old history

Old history should be converted to the normalized JSON format, inspected, then imported with a conservative conflict policy.

Put source files under `data/imports/`.

```bash
cd /path/to/Coingecko-price-proxy
mkdir -p data/imports data/imports/converted
cp /path/to/old-btc-history.csv data/imports/btc-old.csv
npm run convert -- ./data/imports/btc-old.csv --asset btc --vs usd --interval 1d > data/imports/converted/btc-old.normalized.json
head -n 40 data/imports/converted/btc-old.normalized.json
npm run backup-db
npm run import -- ./data/imports/converted/btc-old.normalized.json --policy fill_only_missing
npm run db:check
```

Use these policies intentionally:

- `fill_only_missing` for normal historical imports.
- `skip_existing` when you only want new rows and do not want replacements.
- `overwrite_existing` only after a backup and only when the old data is known to be better.

After import, confirm local history.

```bash
npm run export-history -- --asset btc --from 2024-01-01 --to 2024-01-07 --interval 1d
curl -fsS 'http://127.0.0.1:3000/api/v1/history/btc?from=2024-01-01&to=2024-01-07&interval=1d&vs=usd'
```

The UI path is `/admin/imports`; it can detect files in the import inbox, convert supported dumps, preview normalized history, and import it.

## How to run a backfill

Use backfill to fill missing local windows, not to refetch everything.

UI path:

- Open `/admin/assets/<asset-id>`.
- Choose `from`, `to`, `interval`, quote currency, and `fill_only_missing`.
- Click `Check local data` or `Run gap report`.
- Click `Queue backfill` only after reviewing projected CoinGecko calls and the rate-budget warning.
- Monitor `/admin`, `/admin/rate-budget`, and the asset's recent fetch runs.

CLI path:

```bash
cd /path/to/Coingecko-price-proxy
npm run queue-status
npm run repair-gaps -- --asset btc --from 2024-01-01 --to 2024-02-01 --interval 1d --vs usd
npm run jobs:list
```

For large ranges, backfill in small slices. Start with daily candles, then hourly only for recent periods, and avoid 5-minute backfills unless you truly need them.

## How to check stale data

Fast UI checks:

- `/admin/assets` shows overall staleness for each configured asset.
- `/admin/assets/<asset-id>` shows staleness by interval and recent fetch errors.
- `/admin/system-health` reports assets whose fetched data is stale.
- `/admin/doctor` includes a stale asset check and a safe repair action.

CLI/API checks:

```bash
cd /path/to/Coingecko-price-proxy
npm run db:check
curl -fsS http://127.0.0.1:3000/api/v1/assets
curl -fsS 'http://127.0.0.1:3000/api/v1/history/btc?interval=1d&vs=usd' | head -c 1000; echo
```

If the UI says an interval is stale, check whether a job is already queued or running before creating more work.

```bash
npm run queue-status
npm run jobs:list
```

To repair stale data safely:

```bash
npm run repair-gaps -- --asset btc --from 2024-01-01 --to 2024-02-01 --interval 1d --vs usd
```

Or use `/admin/scheduler/repair-stale` from the dashboard or asset page for the scheduler's configured stale repair.

## How to fix failed jobs

First identify whether failures are app/config issues, CoinGecko issues, or transient network/rate-limit issues.

```bash
cd /path/to/Coingecko-price-proxy
npm run jobs:list
tail -n 200 logs/server.log
npm run db:check
```

Common fixes:

- CoinGecko `429`: wait, reduce queued work, keep safe mode on, then retry failed jobs later.
- Unknown asset or missing CoinGecko ID: fix `config/assets.json` in `/admin/assets` or `/admin/config-history`, validate assets, and restart.
- Stuck running job after a crash: restart the app; the scheduler recovers stale running jobs older than its lock timeout.
- Repeated validation/import errors: move the bad import file to `data/imports/failed/` and re-convert it.

Retry only after the cause is fixed.

```bash
npm run jobs:retry-failed
npm run jobs:list
```

Clean completed jobs after review.

```bash
npm run jobs:clear-completed
```

Use `/admin/doctor` for safe automatic fixes such as retrying failed jobs or repairing stale assets.

## How to handle CoinGecko rate limits

This project is configured for conservative operation. Keep `coingecko.safeMode` enabled in `config/server.json`; it lowers effective throughput after `429` responses and keeps retries low.

Before any manual fetch or backfill:

```bash
cd /path/to/Coingecko-price-proxy
npm run queue-status
npm run jobs:list
```

Then open `/admin/rate-budget` and check safe remaining calls, queued estimated calls, and drain time.

If you hit rate limits:

```bash
# Stop creating new fetch work and let the budget recover.
npm run jobs:list
tail -n 200 logs/server.log | grep -i '429\|rate' || true
```

Operational response:

- Wait at least the configured `coingecko.rateLimitPauseMs` window before retrying.
- Do not click manual fetch repeatedly; failed requests can count against the CoinGecko limit.
- Prefer `1d` backfills over `1h`, and avoid `5m` backfills during recovery.
- Split backfills into smaller date ranges.
- Disable or lower-priority nonessential assets before large repairs.
- If needed, edit `/admin/settings` or `config/server.json` to reduce `coingecko.maxCallsPerMinute`, then restart.

```bash
npm run backup-db
node -e "const fs=require('fs'); const p='config/server.json'; const cfg=JSON.parse(fs.readFileSync(p,'utf8')); cfg.coingecko=cfg.coingecko||{}; cfg.coingecko.maxCallsPerMinute=4; cfg.coingecko.safeMode=true; fs.writeFileSync(p, JSON.stringify(cfg,null,2)+'\n');"
./restart.sh
```

After cooldown, retry failed jobs once.

```bash
npm run jobs:retry-failed
npm run queue-status
```

## How to backup

Use the built-in backup service for normal backups. It writes the SQLite database and companion config/manifest files to `data/backups/`.

```bash
cd /path/to/Coingecko-price-proxy
npm run backup-db
npm run backups:list
```

For a full small-server copy, include database backups, runtime config, environment, and logs.

```bash
cd /path/to/Coingecko-price-proxy
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "data/operator-backups/$STAMP"
npm run backup-db
cp -a config "data/operator-backups/$STAMP/config"
cp -a data/backups "data/operator-backups/$STAMP/backups"
[ -f .env ] && cp .env "data/operator-backups/$STAMP/.env"
cp -a logs "data/operator-backups/$STAMP/logs" 2>/dev/null || true
tar -czf "data/operator-backups/chrono-cache-$STAMP.tar.gz" -C "data/operator-backups" "$STAMP"
```

Copy that tarball off the server.

```bash
scp data/operator-backups/chrono-cache-$STAMP.tar.gz user@backup-host:/safe/place/
```

## How to restore

Restore from a built-in backup when the current database is damaged or you need to roll back data.

```bash
cd /path/to/Coingecko-price-proxy
npm run maintenance:on
./stop.sh
npm run backups:list
npm run restore -- ./data/backups/history-YYYY-MM-DD-HH-mm-ss.sqlite
npm run migrate
npm run db:check
./start.sh
npm run maintenance:off
```

If the app does not start after restore:

```bash
tail -n 200 logs/server.log
npm run check-runtime
npm run validate-assets
```

The restore command creates an emergency copy of the replaced database when possible. Keep that file until you confirm the restored app is healthy.

## How to move to a new server

On the old server:

```bash
cd /path/to/Coingecko-price-proxy
npm run maintenance:on
npm run backup-db
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
tar -czf "chrono-cache-move-$STAMP.tar.gz" package.json package-lock.json server.js src scripts views public config data/backups .env README.md start.sh stop.sh restart.sh update.sh rollback.sh
```

Copy the archive to the new server.

```bash
scp "chrono-cache-move-$STAMP.tar.gz" user@new-server:/opt/
```

On the new server:

```bash
cd /opt
mkdir -p Coingecko-price-proxy
cd Coingecko-price-proxy
tar -xzf ../chrono-cache-move-YYYYMMDDTHHMMSSZ.tar.gz
npm install
npm run check-runtime
npm run migrate
npm run validate-assets
npm run db:check
./start.sh
curl -fsS http://127.0.0.1:3000/health
```

If you only copied `data/backups/` instead of the live database, restore the desired backup on the new server before starting public traffic.

```bash
npm run restore -- ./data/backups/history-YYYY-MM-DD-HH-mm-ss.sqlite
./restart.sh
```

After DNS/reverse proxy cutover, turn maintenance off on the new server and stop the old app.

```bash
npm run maintenance:off
./restart.sh
# on old server
./stop.sh
```

## How to update safely

Use the supplied update script. It creates an emergency backup, installs dependencies, runs self-checks, migrations, tests, and restarts the managed screen session.

```bash
cd /path/to/Coingecko-price-proxy
npm run backup-db
git status --short
git pull --ff-only
./update.sh
curl -fsS http://127.0.0.1:3000/health
```

If you edit config as part of the update, validate it before restart.

```bash
npm run validate-assets
npm run check-runtime
npm test
./restart.sh
```

Do not update while a very large backfill is in progress unless you are prepared to retry failed or recovered jobs afterward.

## How to rollback

If `./update.sh` fails or the new release is unhealthy, use the included rollback script. It restores the newest emergency update backup from `data/update-backups/emergency-*`, runs migrations, and starts the app.

```bash
cd /path/to/Coingecko-price-proxy
./rollback.sh
curl -fsS http://127.0.0.1:3000/health
npm run db:check
npm run jobs:list
```

Manual fallback if the script cannot run:

```bash
cd /path/to/Coingecko-price-proxy
./stop.sh
BACKUP_DIR="$(find data/update-backups -maxdepth 1 -type d -name 'emergency-*' | sort | tail -n 1)"
DB_PATH="$(node -e "const fs=require('fs'),path=require('path'); const cfg=JSON.parse(fs.readFileSync('config/server.json','utf8')); console.log(path.resolve(process.env.DB_PATH||process.env.DATABASE_PATH||cfg.databasePath||'./data/history.sqlite'))")"
cp "$DB_PATH" "$DB_PATH.before-manual-rollback-$(date -u +%Y%m%dT%H%M%SZ)" 2>/dev/null || true
rm -f "$DB_PATH-wal" "$DB_PATH-shm"
cp "$BACKUP_DIR/history.sqlite" "$DB_PATH"
cp -a "$BACKUP_DIR/config/." config/ 2>/dev/null || true
[ -f "$BACKUP_DIR/.env" ] && cp "$BACKUP_DIR/.env" .env
npm run migrate
./start.sh
```

## What not to touch

Do not edit these directly during normal operation:

- `data/history.sqlite`, `data/history.sqlite-wal`, or `data/history.sqlite-shm` while the app is running.
- Rows in SQLite by hand unless you have a backup and a written query plan.
- `node_modules/`; use `npm install` from `package-lock.json` instead.
- `package-lock.json` on the server during operations unless you are intentionally updating dependencies.
- `data/backups/*.manifest.json`; manifests explain what a backup contains.
- `data/imports/archive/` and `data/imports/failed/` except to copy files out for investigation.
- `config/assets.json` without running `npm run validate-assets` afterward.
- `config/server.json` rate-limit, database, or maintenance settings without taking a backup and restarting or hot-reloading through the admin UI.
- `.env` secrets in chat, tickets, screenshots, or commits.

If you are unsure, create a backup, enable maintenance mode, and use `/admin/doctor` or `npm run db:check` before changing anything.
