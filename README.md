# Bagel Shop Webapp (Flask + SQLite + Square Checkout + Google Login)

This is a minimal split architecture:

- `frontend/` is static (good for GitHub Pages).
- `backend/` is Flask + SQLite + Square Python SDK.
- Google OAuth2 + OpenID Connect login is handled directly with Flask, `requests`, and built-in modules.

## Project Structure

```
bagelshop/
  backend/
    .env.example
    app.py
    schema.sql
    requirements.txt
    bagelshop.db           # auto-created on first backend run
  frontend/
    index.html
    styles.css
    app.js
  README.md
```

## What Was Added For Square

- Square official SDK dependency in `backend/requirements.txt`
- Checkout creation route:
  - `POST /checkout` (redirects browser to Square hosted checkout)
  - `POST /api/checkout` (returns checkout URL JSON)
- Square webhook endpoint:
  - `POST /webhooks/square`
  - verifies signature and updates SQLite order payment status
- Square Catalog routes:
  - `GET /api/square/catalog/items`
  - `POST /api/square/catalog/sync`

## Google Login

The backend implements the Google OAuth2 authorization code flow directly:

- `GET /auth/google/start`
  - redirects the browser to Google with `scope=openid email profile`
- `GET /auth/google/callback`
  - exchanges the authorization code for tokens
  - requests profile data from Google userinfo
  - creates or updates the local user and stores the login in the Flask session
- `GET /login`
  - redirects to the frontend sign-in page
- `GET /logout`
  - clears the Flask session and redirects to the frontend home page

No additional Google auth library is required.

## SQLite Schema

Main payment-related tables/fields:

- `orders`
  - `payment_status` (`pending`, `paid`, `failed`)
  - `square_payment_id`
- `order_items`

Schema file: `backend/schema.sql`

`app.py` also includes a tiny migration safety check on startup to add payment fields if an older `orders` table already exists.

## Environment Variables (Square Config)

Set these before running backend:

- `SQUARE_ENVIRONMENT` (`sandbox` or `production`)
- `SQUARE_ACCESS_TOKEN`
- `SQUARE_LOCATION_ID`
- `SQUARE_WEBHOOK_SIGNATURE_KEY`
- `SQUARE_WEBHOOK_NOTIFICATION_URL` (must match URL configured in Square dashboard)
- `SQUARE_ENABLE_CASH_APP_PAY` (`1`/`0`)
- `SQUARE_ENABLE_ACH_REQUEST` (`1`/`0`, request flag only)
- `APP_BASE_URL` (ex: `http://127.0.0.1:5000`)
- `BACKEND_BASE_URL` (ex: `http://127.0.0.1:5000`)
- `FRONTEND_BASE_URL` (ex: `http://127.0.0.1:5501/frontend`)
- `FLASK_SECRET_KEY` (required for signed session cookies)
- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `GOOGLE_REDIRECT_URI` (ex: `http://127.0.0.1:5000/auth/google/callback`)

Use `backend/.env.example` as reference.

## Local Development

### 1) Backend

From project root:

```powershell
cd backend
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt

# Set variables in current PowerShell session (example)
$env:SQUARE_ENVIRONMENT = "sandbox"
$env:SQUARE_ACCESS_TOKEN = "YOUR_SANDBOX_ACCESS_TOKEN"
$env:SQUARE_LOCATION_ID = "YOUR_SANDBOX_LOCATION_ID"
$env:SQUARE_WEBHOOK_SIGNATURE_KEY = "YOUR_WEBHOOK_SIGNATURE_KEY"
$env:SQUARE_WEBHOOK_NOTIFICATION_URL = "https://YOUR-NGROK.ngrok-free.app/webhooks/square"
$env:SQUARE_ENABLE_CASH_APP_PAY = "1"
$env:SQUARE_ENABLE_ACH_REQUEST = "1"
$env:APP_BASE_URL = "http://127.0.0.1:5000"
$env:BACKEND_BASE_URL = "http://127.0.0.1:5000"
$env:FRONTEND_BASE_URL = "http://127.0.0.1:5501/frontend"
$env:FLASK_SECRET_KEY = "CHANGE_ME_TO_A_LONG_RANDOM_SECRET"
$env:GOOGLE_CLIENT_ID = "YOUR_GOOGLE_CLIENT_ID"
$env:GOOGLE_CLIENT_SECRET = "YOUR_GOOGLE_CLIENT_SECRET"
$env:GOOGLE_REDIRECT_URI = "http://127.0.0.1:5000/auth/google/callback"

python app.py
```

### 2) Frontend

```powershell
cd ..
python -m http.server 5501
```

Open `http://127.0.0.1:5501/frontend/`.

### 3) Google OAuth setup

Create a Google OAuth client in Google Cloud Console and configure:

- Authorized redirect URI:
  - `http://127.0.0.1:5000/auth/google/callback`
- JavaScript origins are not required for this backend-driven flow.

Then set these environment variables before starting Flask:

```powershell
$env:GOOGLE_CLIENT_ID = "YOUR_GOOGLE_CLIENT_ID"
$env:GOOGLE_CLIENT_SECRET = "YOUR_GOOGLE_CLIENT_SECRET"
$env:GOOGLE_REDIRECT_URI = "http://127.0.0.1:5000/auth/google/callback"
```

## Testing Checkout Flow

1. Create menu items (`POST /api/menu`) or seed demo data:

```bash
curl -X POST http://127.0.0.1:5000/api/seed
```

2. In frontend, use **Pay with Square Checkout** form.
3. Backend creates local SQLite order with `payment_status='pending'`.
4. Backend creates Square hosted checkout and redirects customer there.

Payment method note:

- Cash App Pay can be enabled in Payment Links (`cash_app_pay`).
- ACH is accepted as a request flag in this app, but Square Payment Links do not currently expose ACH as a direct `accepted_payment_methods` flag in this SDK surface.

## Testing Webhook Locally (ngrok)

Run ngrok to expose local Flask app:

```bash
ngrok http 5000
```

Then:

1. Copy ngrok HTTPS URL (example: `https://abc123.ngrok-free.app`).
2. In Square Developer Dashboard webhook settings, set endpoint to:
   - `https://abc123.ngrok-free.app/webhooks/square`
3. Set backend env var `SQUARE_WEBHOOK_NOTIFICATION_URL` to the exact same URL.
4. Use Square sandbox payment flow.
5. Confirm order status changed to `paid` in SQLite after webhook delivery.

## Key Endpoints

Base API: `http://127.0.0.1:5000/api`

- `GET /api/health`
- `GET /api/me`
- `POST /api/auth/register`
- `POST /api/auth/login`
- `POST /api/auth/logout`
- `POST /api/me`
- `POST /api/me/password`
- `GET /api/my/orders`
- `GET /api/menu`
- `POST /api/menu`
- `GET /api/customers`
- `POST /api/customers`
- `GET /api/orders`
- `POST /api/orders` (creates local order only)
- `POST /api/checkout` (creates Square checkout, returns URL)
- `GET /api/square/catalog/items` (reads Square catalog items)
- `POST /api/square/catalog/sync` (upserts Square catalog items into local `menu_items` by name)

Non-API routes:

- `GET /auth/google/start`
- `GET /auth/google/callback`
- `GET /login`
- `GET /logout`
- `POST /checkout` (creates Square checkout, redirects browser)
- `POST /webhooks/square`

## Square Catalog Example Calls

List catalog items:

```bash
curl "http://127.0.0.1:5000/api/square/catalog/items?limit=50"
```

Sync catalog to local menu:

```bash
curl -X POST http://127.0.0.1:5000/api/square/catalog/sync \
  -H "Content-Type: application/json" \
  -d "{}"
```

## SQLite Query Examples Used

Create order row:

```sql
INSERT INTO orders (customer_id, status, total_cents, notes, payment_status)
VALUES (?, 'new', ?, ?, 'pending');
```

Create order items:

```sql
INSERT INTO order_items (
  order_id,
  menu_item_id,
  quantity,
  unit_price_cents,
  line_total_cents
)
VALUES (?, ?, ?, ?, ?);
```

Mark paid from webhook:

```sql
UPDATE orders
SET payment_status = 'paid', square_payment_id = ?
WHERE id = ?;
```

## VPS Deployment Later (Simple)

For a small Linux VPS:

1. Install `python3`, `python3-venv`.
2. Copy project (`git clone` / `rsync`).
3. Backend setup:

```bash
cd /var/www/bagelshop/backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

export SQUARE_ENVIRONMENT=production
export SQUARE_ACCESS_TOKEN=YOUR_PRODUCTION_TOKEN
export SQUARE_LOCATION_ID=YOUR_PRODUCTION_LOCATION
export SQUARE_WEBHOOK_SIGNATURE_KEY=YOUR_WEBHOOK_SIGNATURE_KEY
export SQUARE_WEBHOOK_NOTIFICATION_URL=https://your-domain.com/webhooks/square
export APP_BASE_URL=https://your-domain.com

python app.py
```

4. Put Nginx in front and proxy:
   - `/api`, `/checkout`, `/webhooks/square` -> `127.0.0.1:5000`
5. Keep frontend static (GitHub Pages or Nginx static folder).

## Notes

- Keep Square in `sandbox` until full test coverage is complete.
- SQLite file stays local in `backend/bagelshop.db`.
- No external database service is required.
