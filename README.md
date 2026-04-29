mkdir coingecko-history-proxy
cd coingecko-history-proxy

npm init -y
npm install express cors better-sqlite3 dotenv p-limit

PORT=8080

# Use demo/public API by default:
COINGECKO_PLAN=demo

# Optional demo key:
COINGECKO_DEMO_API_KEY=

# Optional paid/pro key:
COINGECKO_PRO_API_KEY=

# Use a safe delay for the public API.
# 2500ms = about 24 calls/minute.
COINGECKO_REQUEST_DELAY_MS=2500

# How often the server checks for missing recent data.
UPDATE_INTERVAL_MS=300000

# Initial backfill if an asset has no local data.
BACKFILL_DAYS=365

# CoinGecko supports hourly market chart range chunks up to 100 days.
BACKFILL_CHUNK_DAYS=90

DEFAULT_VS_CURRENCY=usd
DB_PATH=./price-history.sqlite
