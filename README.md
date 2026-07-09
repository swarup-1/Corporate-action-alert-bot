# Investment API

Simple Express + MongoDB backend for the dividend alerts dashboard.

## Setup

```bash
npm install
cp .env.example .env
# Edit .env — set MONGODB_URI (MongoDB Atlas)
npm run dev
```

API: http://localhost:5000/api

## MongoDB Atlas (free)

1. Create free cluster at [mongodb.com/atlas](https://www.mongodb.com/cloud/atlas)
2. Database Access → create user
3. Network Access → allow `0.0.0.0/0` (dev)
4. Connect → Drivers → copy connection string into `.env`

If Atlas is unreachable (office firewall), the API still starts and serves **live** dividend data without saving to DB.

## Env

| Variable | Description |
|----------|-------------|
| `MONGODB_URI` | Atlas connection string |
| `LOOKBACK_DAYS` | Days of announcements to fetch (default 7) |
| `ALLOW_INSECURE_SSL` | `true` on corporate networks with SSL inspection |

## Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/health` | Health check |
| GET | `/api/dividends` | List dividends |
| GET | `/api/dividends?refresh=true` | Refresh from NSE/BSE |

## Deploy (Vercel)

See [../DEPLOY.md](../DEPLOY.md) for full steps. Quick summary:

1. Push this repo to GitHub  
2. Import on [Vercel](https://vercel.com/new)  
3. Set env: `MONGODB_URI`, `LOOKBACK_DAYS`, `CLIENT_URL`  
4. API URL: `https://<project>.vercel.app/api`


```bash
# Terminal 1
npm run dev

# Terminal 2
cd ../investment-dashboard
npm run dev
```
