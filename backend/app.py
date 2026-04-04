from __future__ import annotations

import os
import json
import re
import sqlite3
import base64
import hmac
import hashlib
import smtplib
from datetime import datetime, UTC
from email.message import EmailMessage
from functools import wraps
from pathlib import Path
from typing import Any
from secrets import token_urlsafe
from urllib.parse import urlencode, urlsplit
from uuid import uuid4

import requests
from flask import Flask, jsonify, redirect, request, session
from dotenv import load_dotenv
from square.client import Square
from square.core.api_error import ApiError
from square.environment import SquareEnvironment
from werkzeug.security import check_password_hash, generate_password_hash

BASE_DIR = Path(__file__).resolve().parent
DB_PATH = BASE_DIR / "bagelshop.db"
SCHEMA_PATH = BASE_DIR / "schema.sql"

load_dotenv(BASE_DIR / ".env", override=True)

app = Flask(__name__)

SQUARE_ACCESS_TOKEN = os.getenv("SQUARE_ACCESS_TOKEN", "")
SQUARE_LOCATION_ID = os.getenv("SQUARE_LOCATION_ID", "")
SQUARE_ENVIRONMENT = os.getenv("SQUARE_ENVIRONMENT", "sandbox")
SQUARE_WEBHOOK_SIGNATURE_KEY = os.getenv("SQUARE_WEBHOOK_SIGNATURE_KEY", "")
SQUARE_WEBHOOK_NOTIFICATION_URL = os.getenv("SQUARE_WEBHOOK_NOTIFICATION_URL", "")
APP_BASE_URL = os.getenv("APP_BASE_URL", "http://127.0.0.1:5000")
BACKEND_BASE_URL = os.getenv("BACKEND_BASE_URL", APP_BASE_URL)
FRONTEND_BASE_URL = os.getenv("FRONTEND_BASE_URL", "http://127.0.0.1:5501/frontend")
GOOGLE_CLIENT_ID = os.getenv("GOOGLE_CLIENT_ID", "")
GOOGLE_CLIENT_SECRET = os.getenv("GOOGLE_CLIENT_SECRET", "")
GOOGLE_REDIRECT_URI = os.getenv(
    "GOOGLE_REDIRECT_URI", f"{BACKEND_BASE_URL.rstrip('/')}/auth/google/callback"
)
FLASK_SECRET_KEY = os.getenv("FLASK_SECRET_KEY", "dev-secret-change-me")
SQUARE_ENABLE_CASH_APP_PAY = os.getenv("SQUARE_ENABLE_CASH_APP_PAY", "1")
SQUARE_ENABLE_ACH_REQUEST = os.getenv("SQUARE_ENABLE_ACH_REQUEST", "1")
SQUARE_API_VERSION = "2026-01-22"
GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token"
GOOGLE_USERINFO_URL = "https://www.googleapis.com/oauth2/v3/userinfo"
RECAPTCHA_SITE_KEY = os.getenv("RECAPTCHA_SITE_KEY", "")
RECAPTCHA_SECRET_KEY = os.getenv("RECAPTCHA_SECRET_KEY", "")
EMAIL_VERIFICATION_REQUIRED = os.getenv("EMAIL_VERIFICATION_REQUIRED", "1").strip().lower() in {"1", "true", "yes", "on"}
EMAIL_VERIFICATION_TOKEN_TTL_HOURS = max(
    1, int(os.getenv("EMAIL_VERIFICATION_TOKEN_TTL_HOURS", "24") or "24")
)
SMTP_HOST = os.getenv("SMTP_HOST", "")
SMTP_PORT = int(os.getenv("SMTP_PORT", "587") or "587")
SMTP_USERNAME = os.getenv("SMTP_USERNAME", "")
SMTP_PASSWORD = os.getenv("SMTP_PASSWORD", "")
SMTP_USE_TLS = os.getenv("SMTP_USE_TLS", "1").strip().lower() in {"1", "true", "yes", "on"}
SMTP_USE_SSL = os.getenv("SMTP_USE_SSL", "0").strip().lower() in {"1", "true", "yes", "on"}
SMTP_FROM_EMAIL = os.getenv("SMTP_FROM_EMAIL", "")
SMTP_FROM_NAME = os.getenv("SMTP_FROM_NAME", "Everything Bagelry")

FRONTEND_ORIGIN = f"{urlsplit(FRONTEND_BASE_URL).scheme}://{urlsplit(FRONTEND_BASE_URL).netloc}"

app.secret_key = FLASK_SECRET_KEY
app.config.update(
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE="Lax",
    SESSION_COOKIE_SECURE=BACKEND_BASE_URL.startswith("https://"),
)


def get_square_client() -> Square:
    environment = (
        SquareEnvironment.PRODUCTION
        if SQUARE_ENVIRONMENT.lower() == "production"
        else SquareEnvironment.SANDBOX
    )
    return Square(token=SQUARE_ACCESS_TOKEN, environment=environment)


def get_square_api_base_url() -> str:
    return (
        "https://connect.squareup.com"
        if SQUARE_ENVIRONMENT.lower() == "production"
        else "https://connect.squareupsandbox.com"
    )


def verify_square_webhook_signature(
    payload: str, signature: str, signature_key: str, notification_url: str
) -> bool:
    content = f"{notification_url}{payload}".encode("utf-8")
    digest = hmac.new(signature_key.encode("utf-8"), content, hashlib.sha256).digest()
    expected_signature = base64.b64encode(digest).decode("utf-8")
    return hmac.compare_digest(expected_signature, signature)


def to_bool(value: Any, default: bool = False) -> bool:
    if value is None:
        return default
    if isinstance(value, bool):
        return value
    return str(value).strip().lower() in {"1", "true", "yes", "on"}


def model_to_dict(value: Any) -> dict[str, Any]:
    if value is None:
        return {}
    if isinstance(value, dict):
        return value
    if hasattr(value, "model_dump"):
        return value.model_dump(exclude_none=True)
    if hasattr(value, "dict"):
        return value.dict()
    return {}


def extract_square_category_ids(item_details: dict[str, Any]) -> list[str]:
    category_ids: list[str] = []

    direct_category_id = str(item_details.get("category_id", "") or "").strip()
    if direct_category_id:
        category_ids.append(direct_category_id)

    reporting_category = model_to_dict(item_details.get("reporting_category"))
    reporting_category_id = str(
        reporting_category.get("id") or reporting_category.get("category_id") or ""
    ).strip()
    if reporting_category_id:
        category_ids.append(reporting_category_id)

    for raw_category in item_details.get("categories", []) or []:
        if isinstance(raw_category, str):
            category_id = raw_category.strip()
        else:
            category = model_to_dict(raw_category)
            category_id = str(category.get("id") or category.get("category_id") or "").strip()
        if category_id:
            category_ids.append(category_id)

    return list(dict.fromkeys(category_ids))


def fetch_square_category_names(category_ids: list[str]) -> dict[str, str]:
    if not category_ids or not SQUARE_ACCESS_TOKEN:
        return {}

    try:
        response = requests.post(
            f"{get_square_api_base_url()}/v2/catalog/batch-retrieve",
            headers={
                "Authorization": f"Bearer {SQUARE_ACCESS_TOKEN}",
                "Square-Version": SQUARE_API_VERSION,
                "Content-Type": "application/json",
            },
            json={"object_ids": category_ids},
            timeout=20,
        )
        response.raise_for_status()
        payload = response.json()
    except (requests.RequestException, ValueError):
        return {}

    category_names: dict[str, str] = {}
    for raw_object in (payload.get("objects") or []) + (payload.get("related_objects") or []):
        obj = model_to_dict(raw_object)
        object_id = str(obj.get("id") or "").strip()
        category_data = model_to_dict(obj.get("category_data"))
        category_name = str(obj.get("name") or category_data.get("name") or "").strip()
        if object_id and category_name:
            category_names[object_id] = category_name

    return category_names


def get_square_category_name(
    item_details: dict[str, Any], category_names: dict[str, str] | None = None
) -> str:
    reporting_category = model_to_dict(item_details.get("reporting_category"))
    category_name = str(reporting_category.get("name", "") or "").strip()
    if category_name:
        return category_name

    for raw_category in item_details.get("categories", []) or []:
        if isinstance(raw_category, str):
            category = {}
            category_id = raw_category.strip()
        else:
            category = model_to_dict(raw_category)
            category_id = str(category.get("id") or category.get("category_id") or "").strip()

        category_details = model_to_dict(category.get("category_data"))
        category_name = str(category.get("name") or category_details.get("name") or "").strip()
        if category_name:
            return category_name

        if category_id and category_names and category_names.get(category_id):
            return category_names[category_id]

    for category_id in extract_square_category_ids(item_details):
        if category_names and category_names.get(category_id):
            return category_names[category_id]

    return ""


def normalize_square_catalog_item(
    item: Any, *, category_names: dict[str, str] | None = None
) -> dict[str, Any]:
    item_id = getattr(item, "id", None)
    item_data = model_to_dict(item)
    item_details = model_to_dict(item_data.get("item_data"))
    name = str(item_details.get("name", "") or "").strip()
    description = str(item_details.get("description", "") or "").strip()

    category_name = get_square_category_name(item_details, category_names)

    price_cents: int | None = None
    variation_id: str | None = None
    for variation in item_details.get("variations", []) or []:
        variation_data = model_to_dict(variation)
        variation_details = model_to_dict(variation_data.get("item_variation_data"))
        price_money = model_to_dict(variation_details.get("price_money"))
        amount = price_money.get("amount")
        if amount is not None:
            try:
                price_cents = int(amount)
                variation_id = variation_data.get("id") or getattr(variation, "id", None)
                break
            except (TypeError, ValueError):
                continue

    return {
        "id": item_id,
        "name": name,
        "category": category_name,
        "description": description,
        "price_cents": price_cents,
        "variation_id": variation_id,
    }


def sync_square_catalog_into_menu(
    conn: sqlite3.Connection, *, text_filter: str | None = None, limit: int = 100
) -> dict[str, int]:
    client = get_square_client()
    response = client.catalog.search_items(text_filter=text_filter, limit=limit)
    catalog_items = response.items or []
    category_ids: list[str] = []
    for item in catalog_items:
        item_data = model_to_dict(item)
        item_details = model_to_dict(item_data.get("item_data"))
        category_ids.extend(extract_square_category_ids(item_details))

    category_names = fetch_square_category_names(list(dict.fromkeys(category_ids)))
    normalized = [
        normalize_square_catalog_item(item, category_names=category_names)
        for item in catalog_items
    ]

    inserted = 0
    updated = 0
    skipped = 0
    deleted = 0
    synced_catalog_ids: list[str] = []
    synced_variation_ids: list[str] = []

    for item in normalized:
        name = str(item.get("name", "")).strip()
        category = str(item.get("category", "") or "").strip()
        description = str(item.get("description", "")).strip()
        price_cents = item.get("price_cents")
        square_catalog_id = str(item.get("id") or "").strip()
        square_variation_id = str(item.get("variation_id") or "").strip()

        if not name or price_cents is None:
            skipped += 1
            continue

        if square_catalog_id:
            synced_catalog_ids.append(square_catalog_id)
        if square_variation_id:
            synced_variation_ids.append(square_variation_id)

        existing = None
        if square_catalog_id:
            existing = conn.execute(
                """
                SELECT id, name, category, description, price_cents,
                       square_catalog_id, square_variation_id
                FROM menu_items
                WHERE square_catalog_id = ?
                """,
                (square_catalog_id,),
            ).fetchone()
        if existing is None:
            existing = conn.execute(
                """
                SELECT id, name, category, description, price_cents,
                       square_catalog_id, square_variation_id
                FROM menu_items
                WHERE name = ?
                """,
                (name,),
            ).fetchone()

        if existing:
            has_changes = any(
                (
                    str(existing["name"] or "").strip() != name,
                    str(existing["category"] or "").strip() != category,
                    str(existing["description"] or "").strip() != description,
                    int(existing["price_cents"] or 0) != int(price_cents),
                    str(existing["square_catalog_id"] or "").strip()
                    != square_catalog_id,
                    str(existing["square_variation_id"] or "").strip()
                    != square_variation_id,
                )
            )

            if has_changes:
                conn.execute(
                    """
                    UPDATE menu_items
                    SET name = ?, category = ?, description = ?, price_cents = ?,
                        square_catalog_id = ?, square_variation_id = ?
                    WHERE id = ?
                    """,
                    (
                        name,
                        category,
                        description,
                        int(price_cents),
                        square_catalog_id,
                        square_variation_id,
                        existing["id"],
                    ),
                )
                updated += 1
        else:
            conn.execute(
                """
                INSERT INTO menu_items
                    (name, category, description, price_cents, is_available,
                     square_catalog_id, square_variation_id)
                VALUES (?, ?, ?, ?, 1, ?, ?)
                """,
                (
                    name,
                    category,
                    description,
                    int(price_cents),
                    square_catalog_id,
                    square_variation_id,
                ),
            )
            inserted += 1

    if synced_catalog_ids:
        placeholders = ", ".join("?" for _ in synced_catalog_ids)
        delete_cursor = conn.execute(
            f"""
            DELETE FROM menu_items
                        WHERE square_catalog_id IS NULL
                             OR square_catalog_id NOT IN ({placeholders})
            """,
            tuple(synced_catalog_ids),
        )
        deleted = delete_cursor.rowcount if delete_cursor.rowcount != -1 else 0
    else:
        delete_cursor = conn.execute(
            "DELETE FROM menu_items WHERE square_catalog_id IS NOT NULL"
        )
        deleted = delete_cursor.rowcount if delete_cursor.rowcount != -1 else 0

    return {
        "inserted": inserted,
        "updated": updated,
        "skipped": skipped,
        "deleted": deleted,
        "total_catalog_items": len(normalized),
        "total_variations": len(list(dict.fromkeys(synced_variation_ids))),
    }


def fetch_square_inventory_availability(
    variation_ids: list[str],
) -> dict[str, bool] | None:
    if not variation_ids or not SQUARE_ACCESS_TOKEN or not SQUARE_LOCATION_ID:
        return None

    unique_variation_ids = list(dict.fromkeys(v for v in variation_ids if v))
    if not unique_variation_ids:
        return None

    availability = {variation_id: True for variation_id in unique_variation_ids}

    try:
        response = requests.post(
            f"{get_square_api_base_url()}/v2/inventory/batch-retrieve-counts",
            headers={
                "Authorization": f"Bearer {SQUARE_ACCESS_TOKEN}",
                "Square-Version": SQUARE_API_VERSION,
                "Content-Type": "application/json",
            },
            json={
                "catalog_object_ids": unique_variation_ids,
                "location_ids": [SQUARE_LOCATION_ID],
                "states": ["IN_STOCK"],
            },
            timeout=20,
        )
        response.raise_for_status()
        payload = response.json()
    except (requests.RequestException, ValueError):
        return None

    counts_by_variation: dict[str, float] = {variation_id: 0.0 for variation_id in unique_variation_ids}
    returned_variation_ids: set[str] = set()
    for raw_count in payload.get("counts", []) or payload.get("inventory_counts", []) or []:
        count_data = model_to_dict(raw_count)
        variation_id = str(count_data.get("catalog_object_id") or "").strip()
        if variation_id not in counts_by_variation:
            continue
        returned_variation_ids.add(variation_id)
        try:
            counts_by_variation[variation_id] += float(count_data.get("quantity") or 0)
        except (TypeError, ValueError):
            continue

    for variation_id in returned_variation_ids:
        availability[variation_id] = counts_by_variation[variation_id] > 0

    return availability


def refresh_square_menu_cache(conn: sqlite3.Connection) -> dict[str, Any]:
    sync_result = sync_square_catalog_into_menu(conn)
    variation_rows = conn.execute(
        """
        SELECT square_variation_id
        FROM menu_items
        WHERE square_catalog_id IS NOT NULL AND square_variation_id IS NOT NULL
        """
    ).fetchall()
    variation_ids = [str(row["square_variation_id"] or "").strip() for row in variation_rows]
    availability_map = fetch_square_inventory_availability(variation_ids)

    if availability_map is not None:
        for variation_id, is_available in availability_map.items():
            conn.execute(
                "UPDATE menu_items SET is_available = ? WHERE square_variation_id = ?",
                (1 if is_available else 0, variation_id),
            )

    return {
        **sync_result,
        "availability_live": availability_map is not None,
    }


def get_cached_square_menu_count(conn: sqlite3.Connection) -> int:
    row = conn.execute(
        "SELECT COUNT(*) AS count FROM menu_items WHERE square_catalog_id IS NOT NULL"
    ).fetchone()
    return int(row["count"] if row else 0)


def is_safe_absolute_http_url(value: str) -> bool:
    parts = urlsplit(value)
    return parts.scheme in {"http", "https"} and bool(parts.netloc)


def get_db() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def init_db() -> None:
    conn = get_db()
    try:
        conn.executescript(SCHEMA_PATH.read_text(encoding="utf-8"))
        ensure_orders_schema_columns(conn)
        ensure_users_schema_columns(conn)
        ensure_events_schema(conn)
        promote_default_admin(conn)
        conn.commit()
    finally:
        conn.close()


def ensure_orders_schema_columns(conn: sqlite3.Connection) -> None:
    order_columns = {
        row["name"] for row in conn.execute("PRAGMA table_info(orders)").fetchall()
    }
    if "payment_status" not in order_columns:
        conn.execute(
            """
            ALTER TABLE orders
            ADD COLUMN payment_status TEXT NOT NULL DEFAULT 'pending'
            """
        )
    if "square_payment_id" not in order_columns:
        conn.execute("ALTER TABLE orders ADD COLUMN square_payment_id TEXT")
    if "paid_at" not in order_columns:
        conn.execute("ALTER TABLE orders ADD COLUMN paid_at TEXT")

    menu_columns = {
        row["name"] for row in conn.execute("PRAGMA table_info(menu_items)").fetchall()
    }
    if "category" not in menu_columns:
        conn.execute("ALTER TABLE menu_items ADD COLUMN category TEXT NOT NULL DEFAULT ''")
    if "square_catalog_id" not in menu_columns:
        conn.execute("ALTER TABLE menu_items ADD COLUMN square_catalog_id TEXT")
    if "square_variation_id" not in menu_columns:
        conn.execute("ALTER TABLE menu_items ADD COLUMN square_variation_id TEXT")


def ensure_users_schema_columns(conn: sqlite3.Connection) -> None:
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            customer_id INTEGER NOT NULL,
            name TEXT NOT NULL DEFAULT '',
            email TEXT UNIQUE,
            password_hash TEXT,
            email_verified INTEGER NOT NULL DEFAULT 1,
            email_verified_at TEXT,
            email_verification_token_hash TEXT,
            email_verification_sent_at TEXT,
            phone TEXT NOT NULL DEFAULT '',
            isadmin INTEGER NOT NULL DEFAULT 0,
            is_google_account INTEGER NOT NULL DEFAULT 0,
            auth_provider TEXT NOT NULL DEFAULT 'local',
            google_sub TEXT UNIQUE,
            shipping_address_line1 TEXT NOT NULL DEFAULT '',
            shipping_address_line2 TEXT NOT NULL DEFAULT '',
            shipping_city TEXT NOT NULL DEFAULT '',
            shipping_state TEXT NOT NULL DEFAULT '',
            shipping_postal_code TEXT NOT NULL DEFAULT '',
            shipping_country TEXT NOT NULL DEFAULT '',
            billing_address_line1 TEXT NOT NULL DEFAULT '',
            billing_address_line2 TEXT NOT NULL DEFAULT '',
            billing_city TEXT NOT NULL DEFAULT '',
            billing_state TEXT NOT NULL DEFAULT '',
            billing_postal_code TEXT NOT NULL DEFAULT '',
            billing_country TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE
        )
        """
    )

    user_columns = {
        row["name"] for row in conn.execute("PRAGMA table_info(users)").fetchall()
    }
    if (
        "username" in user_columns
        or "display_name" in user_columns
        or "profile_image_url" in user_columns
        or "is_admin" in user_columns
    ):
        conn.execute("DROP TABLE IF EXISTS users__new")

        legacy_name_expr = (
            "CASE "
            "WHEN COALESCE(name, '') <> '' THEN name "
            "WHEN COALESCE(email, '') <> '' THEN email "
            "ELSE 'Account' END"
        )
        if "display_name" in user_columns:
            legacy_name_expr = (
                "CASE "
                "WHEN COALESCE(display_name, '') <> '' THEN display_name "
                "WHEN COALESCE(username, '') <> '' THEN username "
                "WHEN COALESCE(email, '') <> '' THEN email "
                "ELSE 'Account' END"
            )
        elif "username" in user_columns:
            legacy_name_expr = (
                "CASE "
                "WHEN COALESCE(username, '') <> '' THEN username "
                "WHEN COALESCE(email, '') <> '' THEN email "
                "ELSE 'Account' END"
            )

        legacy_google_expr = "0"
        if "is_google_account" in user_columns:
            legacy_google_expr = "COALESCE(is_google_account, 0)"

        legacy_admin_expr = "0"
        if "isadmin" in user_columns:
            legacy_admin_expr = "COALESCE(isadmin, 0)"
        elif "is_admin" in user_columns:
            legacy_admin_expr = "COALESCE(is_admin, 0)"

        conn.execute(
            """
            CREATE TABLE users__new (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                customer_id INTEGER NOT NULL,
                name TEXT NOT NULL DEFAULT '',
                email TEXT UNIQUE,
                password_hash TEXT,
                email_verified INTEGER NOT NULL DEFAULT 1,
                email_verified_at TEXT,
                email_verification_token_hash TEXT,
                email_verification_sent_at TEXT,
                phone TEXT NOT NULL DEFAULT '',
                isadmin INTEGER NOT NULL DEFAULT 0,
                is_google_account INTEGER NOT NULL DEFAULT 0,
                auth_provider TEXT NOT NULL DEFAULT 'local',
                google_sub TEXT UNIQUE,
                shipping_address_line1 TEXT NOT NULL DEFAULT '',
                shipping_address_line2 TEXT NOT NULL DEFAULT '',
                shipping_city TEXT NOT NULL DEFAULT '',
                shipping_state TEXT NOT NULL DEFAULT '',
                shipping_postal_code TEXT NOT NULL DEFAULT '',
                shipping_country TEXT NOT NULL DEFAULT '',
                billing_address_line1 TEXT NOT NULL DEFAULT '',
                billing_address_line2 TEXT NOT NULL DEFAULT '',
                billing_city TEXT NOT NULL DEFAULT '',
                billing_state TEXT NOT NULL DEFAULT '',
                billing_postal_code TEXT NOT NULL DEFAULT '',
                billing_country TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE
            )
            """
        )
        conn.execute(
            """
            INSERT INTO users__new (
                id, customer_id, name, email, password_hash,
                email_verified, email_verified_at, email_verification_token_hash,
                email_verification_sent_at, phone,
                isadmin,
                is_google_account, auth_provider, google_sub,
                shipping_address_line1, shipping_address_line2, shipping_city,
                shipping_state, shipping_postal_code, shipping_country,
                billing_address_line1, billing_address_line2, billing_city,
                billing_state, billing_postal_code, billing_country,
                created_at, updated_at
            )
            SELECT
                id,
                customer_id,
                """
            + legacy_name_expr
            +
            """,
                email,
                password_hash,
                1,
                NULL,
                NULL,
                NULL,
                COALESCE(phone, ''),
                """
            + legacy_admin_expr
            +
            """,
                CASE
                    WHEN auth_provider = 'google' OR COALESCE(google_sub, '') <> '' THEN 1
                    ELSE """
            + legacy_google_expr
            +
            """
                END,
                COALESCE(auth_provider, 'local'),
                google_sub,
                '',
                '',
                '',
                '',
                '',
                '',
                '',
                '',
                '',
                '',
                '',
                '',
                COALESCE(created_at, CURRENT_TIMESTAMP),
                COALESCE(updated_at, CURRENT_TIMESTAMP)
            FROM users
            """
        )
        conn.execute("DROP TABLE users")
        conn.execute("ALTER TABLE users__new RENAME TO users")
        user_columns = {
            row["name"] for row in conn.execute("PRAGMA table_info(users)").fetchall()
        }

    for column_name, definition in (
        ("customer_id", "INTEGER NOT NULL DEFAULT 0"),
        ("name", "TEXT NOT NULL DEFAULT ''"),
        ("email", "TEXT"),
        ("password_hash", "TEXT"),
        ("email_verified", "INTEGER NOT NULL DEFAULT 1"),
        ("email_verified_at", "TEXT"),
        ("email_verification_token_hash", "TEXT"),
        ("email_verification_sent_at", "TEXT"),
        ("phone", "TEXT NOT NULL DEFAULT ''"),
        ("isadmin", "INTEGER NOT NULL DEFAULT 0"),
        ("is_google_account", "INTEGER NOT NULL DEFAULT 0"),
        ("auth_provider", "TEXT NOT NULL DEFAULT 'local'"),
        ("google_sub", "TEXT"),
        ("shipping_address_line1", "TEXT NOT NULL DEFAULT ''"),
        ("shipping_address_line2", "TEXT NOT NULL DEFAULT ''"),
        ("shipping_city", "TEXT NOT NULL DEFAULT ''"),
        ("shipping_state", "TEXT NOT NULL DEFAULT ''"),
        ("shipping_postal_code", "TEXT NOT NULL DEFAULT ''"),
        ("shipping_country", "TEXT NOT NULL DEFAULT ''"),
        ("billing_address_line1", "TEXT NOT NULL DEFAULT ''"),
        ("billing_address_line2", "TEXT NOT NULL DEFAULT ''"),
        ("billing_city", "TEXT NOT NULL DEFAULT ''"),
        ("billing_state", "TEXT NOT NULL DEFAULT ''"),
        ("billing_postal_code", "TEXT NOT NULL DEFAULT ''"),
        ("billing_country", "TEXT NOT NULL DEFAULT ''"),
        ("created_at", "TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP"),
        ("updated_at", "TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP"),
    ):
        if column_name not in user_columns:
            conn.execute(f"ALTER TABLE users ADD COLUMN {column_name} {definition}")

    conn.execute(
        """
        UPDATE users
        SET is_google_account = CASE
            WHEN auth_provider = 'google' OR COALESCE(google_sub, '') <> '' THEN 1
            ELSE 0
        END
        WHERE is_google_account NOT IN (0, 1)
           OR is_google_account IS NULL
           OR auth_provider IN ('google', 'local')
        """
    )

    conn.execute(
        """
        UPDATE users
        SET isadmin = CASE
            WHEN isadmin IN (1, '1', 'true', 'TRUE', 'yes', 'YES', 'on', 'ON') THEN 1
            ELSE 0
        END
        WHERE isadmin NOT IN (0, 1)
           OR isadmin IS NULL
        """
    )


def ensure_events_schema(conn: sqlite3.Connection) -> None:
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL DEFAULT '',
            event_date TEXT NOT NULL,
            location TEXT NOT NULL DEFAULT '',
            start_time TEXT NOT NULL DEFAULT '',
            end_time TEXT NOT NULL DEFAULT ''
        )
        """
    )

    event_columns = {
        row["name"] for row in conn.execute("PRAGMA table_info(events)").fetchall()
    }

    if "created_at" in event_columns:
        conn.execute("DROP TABLE IF EXISTS events__new")
        conn.execute(
            """
            CREATE TABLE events__new (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL DEFAULT '',
                event_date TEXT NOT NULL,
                location TEXT NOT NULL DEFAULT '',
                start_time TEXT NOT NULL DEFAULT '',
                end_time TEXT NOT NULL DEFAULT ''
            )
            """
        )
        conn.execute(
            """
            INSERT INTO events__new (id, name, event_date, location, start_time, end_time)
            SELECT id, '', event_date, location, start_time, end_time
            FROM events
            """
        )
        conn.execute("DROP TABLE events")
        conn.execute("ALTER TABLE events__new RENAME TO events")
        event_columns = {
            row["name"] for row in conn.execute("PRAGMA table_info(events)").fetchall()
        }

    for column_name, definition in (
        ("name", "TEXT NOT NULL DEFAULT ''"),
        ("event_date", "TEXT NOT NULL DEFAULT ''"),
        ("location", "TEXT NOT NULL DEFAULT ''"),
        ("start_time", "TEXT NOT NULL DEFAULT ''"),
        ("end_time", "TEXT NOT NULL DEFAULT ''"),
    ):
        if column_name not in event_columns:
            conn.execute(f"ALTER TABLE events ADD COLUMN {column_name} {definition}")


def promote_default_admin(conn: sqlite3.Connection) -> None:
    conn.execute(
        """
        UPDATE users
        SET isadmin = 1,
            name = CASE
                WHEN LOWER(COALESCE(email, '')) = LOWER(?) THEN ?
                ELSE name
            END,
            updated_at = ?
        WHERE LOWER(COALESCE(email, '')) = LOWER(?)
           OR LOWER(COALESCE(name, '')) = LOWER(?)
        """,
        ("brianheise22@gmail.com", "Brian Heise", now_iso(), "brianheise22@gmail.com", "Brian Heise"),
    )


def now_iso() -> str:
    return datetime.now(UTC).isoformat()


def is_recaptcha_enabled() -> bool:
    return bool(RECAPTCHA_SITE_KEY and RECAPTCHA_SECRET_KEY)


def is_email_verification_enabled() -> bool:
    return EMAIL_VERIFICATION_REQUIRED


def hash_verification_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def verification_link_for_token(token: str) -> str:
    return f"{BACKEND_BASE_URL.rstrip('/')}/auth/verify-email?token={token}"


def build_email_verification_message(name: str, verification_link: str) -> tuple[str, str]:
    subject = "Verify your Everything Bagelry account"
    display_name = name or "there"
    body = (
        f"Hi {display_name},\n\n"
        "Thanks for signing up for Everything Bagelry. Verify your email by opening this link:\n\n"
        f"{verification_link}\n\n"
        f"This link expires in {EMAIL_VERIFICATION_TOKEN_TTL_HOURS} hours.\n"
    )
    return subject, body


def send_email_message(*, to_email: str, subject: str, body: str) -> str:
    if SMTP_HOST and SMTP_FROM_EMAIL:
        message = EmailMessage()
        message["Subject"] = subject
        message["From"] = (
            f"{SMTP_FROM_NAME} <{SMTP_FROM_EMAIL}>" if SMTP_FROM_NAME else SMTP_FROM_EMAIL
        )
        message["To"] = to_email
        message.set_content(body)

        if SMTP_USE_SSL:
            with smtplib.SMTP_SSL(SMTP_HOST, SMTP_PORT, timeout=20) as server:
                if SMTP_USERNAME:
                    server.login(SMTP_USERNAME, SMTP_PASSWORD)
                server.send_message(message)
        else:
            with smtplib.SMTP(SMTP_HOST, SMTP_PORT, timeout=20) as server:
                if SMTP_USE_TLS:
                    server.starttls()
                if SMTP_USERNAME:
                    server.login(SMTP_USERNAME, SMTP_PASSWORD)
                server.send_message(message)
        return "smtp"

    print(f"[email verification] To: {to_email}\nSubject: {subject}\n\n{body}", flush=True)
    return "console"


def issue_email_verification(conn: sqlite3.Connection, user: sqlite3.Row) -> dict[str, str]:
    if not user["email"]:
        raise ValueError("Email is required for verification")

    raw_token = token_urlsafe(32)
    token_hash = hash_verification_token(raw_token)
    sent_at = now_iso()
    conn.execute(
        """
        UPDATE users
        SET email_verification_token_hash = ?, email_verification_sent_at = ?, updated_at = ?
        WHERE id = ?
        """,
        (token_hash, sent_at, sent_at, user["id"]),
    )
    verification_link = verification_link_for_token(raw_token)
    subject, body = build_email_verification_message(user["name"], verification_link)
    delivery = send_email_message(to_email=str(user["email"]), subject=subject, body=body)
    return {"verification_link": verification_link, "delivery": delivery}


def verify_recaptcha_token(token: str, remote_ip: str = "") -> bool:
    if not is_recaptcha_enabled():
        return True
    if not token:
        return False

    try:
        response = requests.post(
            "https://www.google.com/recaptcha/api/siteverify",
            data={
                "secret": RECAPTCHA_SECRET_KEY,
                "response": token,
                "remoteip": remote_ip,
            },
            timeout=15,
        )
        response.raise_for_status()
        payload = response.json()
    except (requests.RequestException, ValueError):
        return False

    return bool(payload.get("success"))


def get_public_user_dict(
    row: sqlite3.Row | None, session_user: dict[str, Any] | None = None
) -> dict[str, Any] | None:
    if row is None:
        return None

    profile_image_url = ""
    if bool(row["is_google_account"]) and session_user is not None:
        profile_image_url = str(session_user.get("picture", "") or "").strip()

    return {
        "id": row["id"],
        "customer_id": row["customer_id"],
        "name": row["name"],
        "email": row["email"],
        "is_admin": bool(row["isadmin"]),
        "email_verified": bool(row["email_verified"]),
        "email_verified_at": row["email_verified_at"],
        "phone": row["phone"],
        "profile_image_url": profile_image_url,
        "is_google_account": bool(row["is_google_account"]),
        "auth_provider": row["auth_provider"],
        "shipping_address": {
            "line1": row["shipping_address_line1"],
            "line2": row["shipping_address_line2"],
            "city": row["shipping_city"],
            "state": row["shipping_state"],
            "postal_code": row["shipping_postal_code"],
            "country": row["shipping_country"],
        },
        "billing_address": {
            "line1": row["billing_address_line1"],
            "line2": row["billing_address_line2"],
            "city": row["billing_city"],
            "state": row["billing_state"],
            "postal_code": row["billing_postal_code"],
            "country": row["billing_country"],
        },
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


def get_session_user_dict(
    row: sqlite3.Row | None, picture: str = ""
) -> dict[str, Any] | None:
    if row is None:
        return None

    return {
        "id": row["id"],
        "email": row["email"],
        "name": row["name"] or row["email"] or "",
        "picture": picture,
        "is_admin": bool(row["isadmin"]),
        "is_google_account": bool(row["is_google_account"]),
        "email_verified": bool(row["email_verified"]),
    }


def get_user_by_id(conn: sqlite3.Connection, user_id: int) -> sqlite3.Row | None:
    return conn.execute(
        """
                SELECT id, customer_id, name, email, password_hash,
                             email_verified, email_verified_at, email_verification_token_hash,
                             email_verification_sent_at, phone, isadmin,
               is_google_account, auth_provider, google_sub,
             shipping_address_line1, shipping_address_line2, shipping_city,
             shipping_state, shipping_postal_code, shipping_country,
             billing_address_line1, billing_address_line2, billing_city,
             billing_state, billing_postal_code, billing_country,
             created_at, updated_at
        FROM users
        WHERE id = ?
        """,
        (user_id,),
    ).fetchone()


def get_current_user(conn: sqlite3.Connection) -> sqlite3.Row | None:
    user_id = session.get("user_id")
    if not user_id:
        return None
    return get_user_by_id(conn, int(user_id))


def upsert_customer(
    conn: sqlite3.Connection, *, name: str, email: str = "", phone: str = "", customer_id: int | None = None
) -> int:
    if customer_id:
        conn.execute(
            "UPDATE customers SET name = ?, email = ?, phone = ? WHERE id = ?",
            (name, email, phone, customer_id),
        )
        return customer_id

    cursor = conn.execute(
        "INSERT INTO customers (name, email, phone) VALUES (?, ?, ?)",
        (name, email, phone),
    )
    return int(cursor.lastrowid)


def frontend_url(page: str, **params: str) -> str:
    if not is_safe_absolute_http_url(FRONTEND_BASE_URL):
        raise ValueError("FRONTEND_BASE_URL must be an absolute http(s) URL")

    page = page.lstrip("/")
    url = f"{FRONTEND_BASE_URL.rstrip('/')}/{page}"
    if params:
        filtered = {k: v for k, v in params.items() if v}
        if filtered:
            url = f"{url}?{urlencode(filtered)}"
    return url


def frontend_redirect(page: str, **params: str):
    try:
        return redirect(frontend_url(page, **params))
    except ValueError:
        return jsonify({"error": "Invalid FRONTEND_BASE_URL configuration"}), 500


def set_logged_in_user(
    user_id: int, user: sqlite3.Row | None = None, picture: str = ""
) -> None:
    session["user_id"] = int(user_id)
    session_user = get_session_user_dict(user, picture=picture)
    if session_user is not None:
        session["user"] = session_user


def clear_logged_in_user() -> None:
    session.pop("user_id", None)
    session.pop("user", None)
    session.pop("google_oauth_state", None)


def login_required(view_func):
    @wraps(view_func)
    def wrapped(*args, **kwargs):
        if session.get("user_id"):
            return view_func(*args, **kwargs)
        if request.path.startswith("/api/"):
            return jsonify({"error": "Authentication required"}), 401
        return redirect("/login")

    return wrapped


def admin_required(view_func):
    @wraps(view_func)
    def wrapped(*args, **kwargs):
        if not session.get("user_id"):
            if request.path.startswith("/api/"):
                return jsonify({"error": "Authentication required"}), 401
            return redirect("/login")

        conn = get_db()
        try:
            user = get_current_user(conn)
            if user is None:
                clear_logged_in_user()
                return jsonify({"error": "Authentication required"}), 401
            if not bool(user["isadmin"]):
                return jsonify({"error": "Admin access required"}), 403
        finally:
            conn.close()

        return view_func(*args, **kwargs)

    return wrapped


IDENTIFIER_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")


def is_valid_identifier(value: str) -> bool:
    return bool(IDENTIFIER_RE.fullmatch(value or ""))


def get_database_table_names(conn: sqlite3.Connection) -> list[str]:
    rows = conn.execute(
        """
        SELECT name
        FROM sqlite_master
        WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
        ORDER BY LOWER(name) ASC
        """
    ).fetchall()
    return [str(row["name"]) for row in rows]


def require_table_name(conn: sqlite3.Connection, table_name: str) -> str:
    normalized = str(table_name or "").strip()
    if not is_valid_identifier(normalized):
        raise ValueError("Invalid table name")
    if normalized not in get_database_table_names(conn):
        raise LookupError("Table not found")
    return normalized


def get_table_columns(conn: sqlite3.Connection, table_name: str) -> list[dict[str, Any]]:
    normalized = require_table_name(conn, table_name)
    rows = conn.execute(f"PRAGMA table_info({normalized})").fetchall()
    return [dict(row) for row in rows]


def get_table_primary_key_column(conn: sqlite3.Connection, table_name: str) -> str | None:
    for column in get_table_columns(conn, table_name):
        if int(column.get("pk") or 0) == 1:
            return str(column["name"])
    return None


def sanitize_row_payload(conn: sqlite3.Connection, table_name: str, payload: dict[str, Any]) -> dict[str, Any]:
    allowed_columns = {str(column["name"]) for column in get_table_columns(conn, table_name)}
    cleaned: dict[str, Any] = {}
    for key, value in (payload or {}).items():
        key_name = str(key or "").strip()
        if key_name and key_name in allowed_columns:
            cleaned[key_name] = value
    return cleaned


def get_allowed_origin() -> str | None:
    request_origin = request.headers.get("Origin", "").strip()
    if not request_origin:
        return None

    allowed_origins = {FRONTEND_ORIGIN}

    frontend_parts = urlsplit(FRONTEND_BASE_URL)
    frontend_host = frontend_parts.hostname or ""
    frontend_port = frontend_parts.port
    frontend_scheme = frontend_parts.scheme or "http"

    if frontend_host == "127.0.0.1":
        alt_host = "localhost"
    elif frontend_host == "localhost":
        alt_host = "127.0.0.1"
    else:
        alt_host = ""

    if alt_host:
        alt_netloc = alt_host if frontend_port is None else f"{alt_host}:{frontend_port}"
        allowed_origins.add(f"{frontend_scheme}://{alt_netloc}")

    if request_origin in allowed_origins:
        return request_origin
    return None


@app.after_request
def add_cors_headers(response):
    allowed_origin = get_allowed_origin()
    if allowed_origin:
        response.headers["Access-Control-Allow-Origin"] = allowed_origin
        response.headers["Access-Control-Allow-Credentials"] = "true"
        response.headers["Vary"] = "Origin"
    response.headers["Access-Control-Allow-Headers"] = "Content-Type"
    response.headers["Access-Control-Allow-Methods"] = "GET,POST,PATCH,DELETE,OPTIONS"
    return response


@app.route("/api/<path:_path>", methods=["OPTIONS"])
def preflight(_path: str):
    return ("", 204)


@app.get("/api/health")
def health_check():
    return jsonify({"status": "ok"})


@app.get("/api/me")
def get_current_session_user():
    conn = get_db()
    try:
        user = get_current_user(conn)
        if user is None:
            return jsonify({"authenticated": False, "user": None}), 200
        return jsonify({
            "authenticated": True,
            "user": get_public_user_dict(user, session.get("user")),
        }), 200
    finally:
        conn.close()


@app.get("/api/auth/config")
def get_auth_config():
    return jsonify(
        {
            "recaptcha_enabled": is_recaptcha_enabled(),
            "recaptcha_site_key": RECAPTCHA_SITE_KEY if is_recaptcha_enabled() else "",
            "email_verification_required": is_email_verification_enabled(),
        }
    ), 200


@app.get("/api/events")
def get_events():
    month = str(request.args.get("month", "") or "").strip()
    start_date = str(request.args.get("start", "") or "").strip()
    end_date = str(request.args.get("end", "") or "").strip()

    if month:
        try:
            year_str, month_str = month.split("-", 1)
            year = int(year_str)
            month_number = int(month_str)
            if month_number < 1 or month_number > 12:
                raise ValueError
        except ValueError:
            return jsonify({"error": "month must be in YYYY-MM format"}), 400

        start_date = f"{year:04d}-{month_number:02d}-01"
        if month_number == 12:
            end_date = f"{year + 1:04d}-01-01"
        else:
            end_date = f"{year:04d}-{month_number + 1:02d}-01"

    conn = get_db()
    try:
        if start_date and end_date:
            rows = conn.execute(
                """
                SELECT id, name, event_date, location, start_time, end_time
                FROM events
                WHERE event_date >= ? AND event_date < ?
                ORDER BY event_date ASC, start_time ASC, end_time ASC, id ASC
                """,
                (start_date, end_date),
            ).fetchall()
        else:
            rows = conn.execute(
                """
                SELECT id, name, event_date, location, start_time, end_time
                FROM events
                ORDER BY event_date ASC, start_time ASC, end_time ASC, id ASC
                """
            ).fetchall()
    finally:
        conn.close()

    return jsonify([dict(row) for row in rows]), 200


@app.get("/api/admin/db/tables")
@admin_required
def admin_list_tables():
    conn = get_db()
    try:
        tables = []
        for table_name in get_database_table_names(conn):
            columns = get_table_columns(conn, table_name)
            row_count = conn.execute(f"SELECT COUNT(*) AS count FROM {table_name}").fetchone()["count"]
            tables.append(
                {
                    "name": table_name,
                    "row_count": row_count,
                    "primary_key": get_table_primary_key_column(conn, table_name),
                    "columns": columns,
                }
            )
    finally:
        conn.close()

    return jsonify(tables), 200


@app.get("/api/admin/db/tables/<table_name>")
@admin_required
def admin_get_table_rows(table_name: str):
    conn = get_db()
    try:
        normalized_table = require_table_name(conn, table_name)
        limit = max(1, min(int(request.args.get("limit", 100) or 100), 500))
        offset = max(0, int(request.args.get("offset", 0) or 0))
        primary_key = get_table_primary_key_column(conn, normalized_table)
        order_column = primary_key or "rowid"
        rows = conn.execute(
            f"SELECT * FROM {normalized_table} ORDER BY {order_column} DESC LIMIT ? OFFSET ?",
            (limit, offset),
        ).fetchall()
        total_rows = conn.execute(
            f"SELECT COUNT(*) AS count FROM {normalized_table}"
        ).fetchone()["count"]
        columns = get_table_columns(conn, normalized_table)
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    except LookupError as exc:
        return jsonify({"error": str(exc)}), 404
    finally:
        conn.close()

    return jsonify(
        {
            "table": table_name,
            "primary_key": primary_key,
            "columns": columns,
            "limit": limit,
            "offset": offset,
            "total_rows": total_rows,
            "rows": [dict(row) for row in rows],
        }
    ), 200


@app.post("/api/admin/db/tables/<table_name>/rows")
@admin_required
def admin_insert_row(table_name: str):
    data = request.get_json(silent=True) or {}
    payload = data.get("row") if isinstance(data.get("row"), dict) else data

    conn = get_db()
    try:
        normalized_table = require_table_name(conn, table_name)
        row_data = sanitize_row_payload(conn, normalized_table, payload)
        columns = list(row_data.keys())

        if columns:
            placeholders = ", ".join("?" for _ in columns)
            quoted_columns = ", ".join(columns)
            cursor = conn.execute(
                f"INSERT INTO {normalized_table} ({quoted_columns}) VALUES ({placeholders})",
                tuple(row_data[column] for column in columns),
            )
        else:
            cursor = conn.execute(f"INSERT INTO {normalized_table} DEFAULT VALUES")

        conn.commit()

        primary_key = get_table_primary_key_column(conn, normalized_table)
        inserted_row = None
        if primary_key and cursor.lastrowid is not None:
            inserted_row = conn.execute(
                f"SELECT * FROM {normalized_table} WHERE {primary_key} = ?",
                (cursor.lastrowid,),
            ).fetchone()
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    except LookupError as exc:
        return jsonify({"error": str(exc)}), 404
    except sqlite3.Error as exc:
        conn.rollback()
        return jsonify({"error": str(exc)}), 400
    finally:
        conn.close()

    return jsonify({
        "message": "Row inserted",
        "row": dict(inserted_row) if inserted_row is not None else None,
    }), 201


@app.patch("/api/admin/db/tables/<table_name>/rows/<row_id>")
@admin_required
def admin_update_row(table_name: str, row_id: str):
    data = request.get_json(silent=True) or {}
    payload = data.get("row") if isinstance(data.get("row"), dict) else data

    conn = get_db()
    try:
        normalized_table = require_table_name(conn, table_name)
        primary_key = get_table_primary_key_column(conn, normalized_table)
        if not primary_key:
            return jsonify({"error": "This table has no primary key"}), 400

        row_data = sanitize_row_payload(conn, normalized_table, payload)
        row_data.pop(primary_key, None)
        if not row_data:
            return jsonify({"error": "No editable columns provided"}), 400

        assignments = ", ".join(f"{column} = ?" for column in row_data)
        cursor = conn.execute(
            f"UPDATE {normalized_table} SET {assignments} WHERE {primary_key} = ?",
            tuple(row_data[column] for column in row_data) + (row_id,),
        )
        if cursor.rowcount == 0:
            conn.rollback()
            return jsonify({"error": "Row not found"}), 404

        conn.commit()
        updated_row = conn.execute(
            f"SELECT * FROM {normalized_table} WHERE {primary_key} = ?",
            (row_id,),
        ).fetchone()
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    except LookupError as exc:
        return jsonify({"error": str(exc)}), 404
    except sqlite3.Error as exc:
        conn.rollback()
        return jsonify({"error": str(exc)}), 400
    finally:
        conn.close()

    return jsonify({"message": "Row updated", "row": dict(updated_row)}), 200


@app.delete("/api/admin/db/tables/<table_name>/rows/<row_id>")
@admin_required
def admin_delete_row(table_name: str, row_id: str):
    conn = get_db()
    try:
        normalized_table = require_table_name(conn, table_name)
        primary_key = get_table_primary_key_column(conn, normalized_table)
        if not primary_key:
            return jsonify({"error": "This table has no primary key"}), 400

        cursor = conn.execute(
            f"DELETE FROM {normalized_table} WHERE {primary_key} = ?",
            (row_id,),
        )
        if cursor.rowcount == 0:
            conn.rollback()
            return jsonify({"error": "Row not found"}), 404

        conn.commit()
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    except LookupError as exc:
        return jsonify({"error": str(exc)}), 404
    except sqlite3.Error as exc:
        conn.rollback()
        return jsonify({"error": str(exc)}), 400
    finally:
        conn.close()

    return jsonify({"message": "Row deleted"}), 200


@app.post("/api/admin/events/<int:event_id>/duplicate-week")
@admin_required
def admin_duplicate_event_week(event_id: int):
    conn = get_db()
    try:
        event = conn.execute(
            """
            SELECT id, name, event_date, location, start_time, end_time
            FROM events
            WHERE id = ?
            LIMIT 1
            """,
            (event_id,),
        ).fetchone()
        if event is None:
            return jsonify({"error": "Event not found"}), 404

        try:
            next_date = datetime.fromisoformat(str(event["event_date"])).date()
        except ValueError:
            return jsonify({"error": "Event date is invalid"}), 400

        duplicated_date = next_date.fromordinal(next_date.toordinal() + 7).isoformat()
        cursor = conn.execute(
            """
            INSERT INTO events (name, event_date, location, start_time, end_time)
            VALUES (?, ?, ?, ?, ?)
            """,
            (
                str(event["name"] or "").strip(),
                duplicated_date,
                str(event["location"] or "").strip(),
                str(event["start_time"] or "").strip(),
                str(event["end_time"] or "").strip(),
            ),
        )
        new_id = int(cursor.lastrowid)
        conn.commit()

        duplicated = conn.execute(
            """
            SELECT id, name, event_date, location, start_time, end_time
            FROM events
            WHERE id = ?
            LIMIT 1
            """,
            (new_id,),
        ).fetchone()
    finally:
        conn.close()

    return jsonify({"message": "Event duplicated", "row": dict(duplicated)}), 201


@app.get("/api/admin/orders/details")
@admin_required
def admin_get_order_details():
    conn = get_db()
    try:
        order_rows = conn.execute(
            """
            SELECT o.id, o.customer_id, o.status, o.total_cents, o.notes,
                   o.payment_status, o.square_payment_id, o.paid_at, o.created_at,
                   c.name AS customer_name, c.email AS customer_email
            FROM orders o
            LEFT JOIN customers c ON c.id = o.customer_id
            ORDER BY o.id DESC
            """
        ).fetchall()

        orders: list[dict[str, Any]] = []
        for order in order_rows:
            item_rows = conn.execute(
                """
                SELECT oi.id, oi.order_id, oi.menu_item_id, oi.quantity,
                       oi.unit_price_cents, oi.line_total_cents,
                       mi.name AS menu_item_name
                FROM order_items oi
                LEFT JOIN menu_items mi ON mi.id = oi.menu_item_id
                WHERE oi.order_id = ?
                ORDER BY oi.id ASC
                """,
                (order["id"],),
            ).fetchall()

            items: list[dict[str, Any]] = []
            subtotal_cents = 0
            for item in item_rows:
                item_dict = dict(item)
                item_dict["menu_item_name"] = str(item_dict.get("menu_item_name") or "Menu item")
                item_dict["quantity"] = int(item_dict.get("quantity") or 0)
                item_dict["unit_price_cents"] = int(item_dict.get("unit_price_cents") or 0)
                item_dict["line_total_cents"] = int(item_dict.get("line_total_cents") or 0)
                subtotal_cents += item_dict["line_total_cents"]
                items.append(item_dict)

            total_cents = int(order["total_cents"] or 0)
            fee_total_cents = max(0, total_cents - subtotal_cents)
            fees: list[dict[str, Any]] = []
            if fee_total_cents > 0:
                fees.append({"label": "Additional fees", "amount_cents": fee_total_cents})

            buyer_name = str(order["customer_name"] or "").strip() or "Guest customer"
            buyer_email = str(order["customer_email"] or "").strip()
            paid_at = str(order["paid_at"] or "").strip()
            if not paid_at and str(order["payment_status"] or "").strip().lower() == "paid":
                paid_at = str(order["created_at"] or "").strip()

            orders.append(
                {
                    "id": int(order["id"]),
                    "customer_id": order["customer_id"],
                    "buyer_name": buyer_name,
                    "buyer_email": buyer_email,
                    "status": order["status"],
                    "payment_status": order["payment_status"],
                    "square_payment_id": order["square_payment_id"],
                    "paid_at": paid_at,
                    "created_at": order["created_at"],
                    "notes": order["notes"],
                    "items": items,
                    "subtotal_cents": subtotal_cents,
                    "fees": fees,
                    "fee_total_cents": fee_total_cents,
                    "total_cents": total_cents,
                }
            )
    finally:
        conn.close()

    return jsonify(orders), 200


@app.post("/api/admin/db/query")
@admin_required
def admin_execute_query():
    data = request.get_json(silent=True) or {}
    sql = str(data.get("sql", "") or "").strip()
    params = data.get("params", [])

    if not sql:
        return jsonify({"error": "sql is required"}), 400
    if not isinstance(params, list):
        return jsonify({"error": "params must be a list"}), 400

    conn = get_db()
    try:
        cursor = conn.execute(sql, tuple(params))
        if cursor.description is not None:
            rows = [dict(row) for row in cursor.fetchall()]
            return jsonify({"rows": rows, "row_count": len(rows)}), 200

        conn.commit()
        return jsonify(
            {
                "row_count": cursor.rowcount if cursor.rowcount != -1 else 0,
                "lastrowid": cursor.lastrowid,
            }
        ), 200
    except sqlite3.Error as exc:
        conn.rollback()
        return jsonify({"error": str(exc)}), 400
    finally:
        conn.close()


@app.get("/login")
def login_page():
    return frontend_redirect("auth.html")


@app.get("/logout")
def logout_page():
    clear_logged_in_user()
    return frontend_redirect("index.html")


@app.post("/api/auth/register")
def register_local_user():
    data = request.get_json(silent=True) or {}
    name = str(data.get("name", "")).strip()
    email = str(data.get("email", "")).strip().lower()
    password = str(data.get("password", ""))
    recaptcha_token = str(data.get("recaptcha_token", "")).strip()

    if not name:
        return jsonify({"error": "name is required"}), 400
    if not email:
        return jsonify({"error": "email is required"}), 400
    if len(password) < 6:
        return jsonify({"error": "password must be at least 6 characters"}), 400
    if not verify_recaptcha_token(recaptcha_token, request.remote_addr or ""):
        return jsonify({"error": "reCAPTCHA verification failed"}), 400

    conn = get_db()
    try:
        existing = conn.execute(
            "SELECT id FROM users WHERE email = ?",
            (email,),
        ).fetchone()
        if existing is not None:
            return jsonify({"error": "An account with that email already exists"}), 409

        customer_id = upsert_customer(conn, name=name, email=email)
        cursor = conn.execute(
            """
            INSERT INTO users (
                customer_id, name, email, password_hash,
                email_verified, email_verified_at, email_verification_token_hash,
                email_verification_sent_at, phone,
                is_google_account, auth_provider, updated_at
            )
            VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, '', 0, 'local', ?)
            """,
            (
                customer_id,
                name,
                email or None,
                generate_password_hash(password),
                0 if is_email_verification_enabled() else 1,
                now_iso(),
            ),
        )
        user_id = int(cursor.lastrowid)
        user = get_user_by_id(conn, user_id)
        verification_delivery = ""
        if user is not None and is_email_verification_enabled():
            verification_delivery = issue_email_verification(conn, user)["delivery"]
        conn.commit()
        user = get_user_by_id(conn, user_id)
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()

    if is_email_verification_enabled():
        return jsonify(
            {
                "authenticated": False,
                "verification_required": True,
                "message": "Account created. Check your email for a verification link before signing in.",
                "email": email,
                "delivery": verification_delivery,
            }
        ), 201

    set_logged_in_user(user_id, user)
    return jsonify({"authenticated": True, "user": get_public_user_dict(user)}), 201


@app.post("/api/auth/login")
def login_local_user():
    data = request.get_json(silent=True) or {}
    email = str(data.get("email", "")).strip().lower()
    password = str(data.get("password", ""))

    if not email or not password:
        return jsonify({"error": "email and password are required"}), 400

    conn = get_db()
    try:
        user = conn.execute(
            """
            SELECT id, customer_id, name, email, password_hash,
                     email_verified, email_verified_at, email_verification_token_hash,
                     email_verification_sent_at, phone, isadmin,
                     is_google_account, auth_provider, google_sub,
                     shipping_address_line1, shipping_address_line2, shipping_city,
                     shipping_state, shipping_postal_code, shipping_country,
                     billing_address_line1, billing_address_line2, billing_city,
                     billing_state, billing_postal_code, billing_country,
                     created_at, updated_at
            FROM users
            WHERE email = ?
            LIMIT 1
            """,
            (email,),
        ).fetchone()
        if user is None or not user["password_hash"] or not check_password_hash(user["password_hash"], password):
            return jsonify({"error": "Incorrect email or password"}), 401
        if not bool(user["is_google_account"]) and is_email_verification_enabled() and not bool(user["email_verified"]):
            return jsonify(
                {
                    "error": "Please verify your email before signing in.",
                    "verification_required": True,
                    "email": email,
                }
            ), 403
        authenticated_user = user
    finally:
        conn.close()

    set_logged_in_user(int(authenticated_user["id"]), authenticated_user)
    return jsonify({
        "authenticated": True,
        "user": get_public_user_dict(user, session.get("user")),
    }), 200


@app.post("/api/auth/logout")
def logout_user():
    clear_logged_in_user()
    return jsonify({"ok": True}), 200


@app.post("/api/auth/resend-verification")
def resend_verification_email():
    data = request.get_json(silent=True) or {}
    email = str(data.get("email", "")).strip().lower()
    if not email:
        return jsonify({"error": "email is required"}), 400

    conn = get_db()
    try:
        user = conn.execute(
            """
            SELECT id, customer_id, name, email, password_hash,
                   email_verified, email_verified_at, email_verification_token_hash,
                   email_verification_sent_at, phone,
                   is_google_account, auth_provider, google_sub,
                   shipping_address_line1, shipping_address_line2, shipping_city,
                   shipping_state, shipping_postal_code, shipping_country,
                   billing_address_line1, billing_address_line2, billing_city,
                   billing_state, billing_postal_code, billing_country,
                   created_at, updated_at
            FROM users
            WHERE email = ?
            LIMIT 1
            """,
            (email,),
        ).fetchone()
        if user is None:
            return jsonify({"error": "No account found with that email"}), 404
        if bool(user["email_verified"]):
            return jsonify({"message": "That email address is already verified."}), 200

        verification_delivery = issue_email_verification(conn, user)["delivery"]
        conn.commit()
    finally:
        conn.close()

    return jsonify({"message": "Verification email sent.", "delivery": verification_delivery}), 200


@app.get("/auth/verify-email")
def verify_email_address():
    token = str(request.args.get("token", "")).strip()
    if not token:
        return frontend_redirect("auth.html", error="missing_verification_token")

    token_hash = hash_verification_token(token)
    conn = get_db()
    try:
        user = conn.execute(
            """
            SELECT id, customer_id, name, email, password_hash,
                   email_verified, email_verified_at, email_verification_token_hash,
                   email_verification_sent_at, phone,
                   is_google_account, auth_provider, google_sub,
                   shipping_address_line1, shipping_address_line2, shipping_city,
                   shipping_state, shipping_postal_code, shipping_country,
                   billing_address_line1, billing_address_line2, billing_city,
                   billing_state, billing_postal_code, billing_country,
                   created_at, updated_at
            FROM users
            WHERE email_verification_token_hash = ?
            LIMIT 1
            """,
            (token_hash,),
        ).fetchone()
        if user is None:
            return frontend_redirect("auth.html", error="invalid_verification_token")

        sent_at = str(user["email_verification_sent_at"] or "").strip()
        if sent_at:
            sent_at_dt = datetime.fromisoformat(sent_at)
            age_seconds = (datetime.now(UTC) - sent_at_dt).total_seconds()
            if age_seconds > EMAIL_VERIFICATION_TOKEN_TTL_HOURS * 3600:
                return frontend_redirect("auth.html", error="verification_link_expired")

        conn.execute(
            """
            UPDATE users
            SET email_verified = 1,
                email_verified_at = ?,
                email_verification_token_hash = NULL,
                email_verification_sent_at = NULL,
                updated_at = ?
            WHERE id = ?
            """,
            (now_iso(), now_iso(), user["id"]),
        )
        conn.commit()
    finally:
        conn.close()

    return frontend_redirect("auth.html", verified="1", email=str(user["email"] or ""))


@app.get("/auth/google/start")
def start_google_auth():
    if not GOOGLE_CLIENT_ID or not GOOGLE_CLIENT_SECRET:
        return frontend_redirect("auth.html", error="google_not_configured")
    if not is_safe_absolute_http_url(GOOGLE_REDIRECT_URI):
        return frontend_redirect("auth.html", error="google_redirect_uri_invalid")

    state = token_urlsafe(24)
    session["google_oauth_state"] = state
    google_params = {
        "client_id": GOOGLE_CLIENT_ID,
        "redirect_uri": GOOGLE_REDIRECT_URI,
        "response_type": "code",
        "scope": "openid email profile",
        "state": state,
        "access_type": "offline",
        "prompt": "consent",
    }
    return redirect(f"{GOOGLE_AUTH_URL}?{urlencode(google_params)}")


@app.get("/auth/google/callback")
def finish_google_auth():
    if request.args.get("error"):
        return frontend_redirect("auth.html", error=request.args.get("error", "google_auth_failed"))

    state = request.args.get("state", "")
    if not state or state != session.get("google_oauth_state"):
        clear_logged_in_user()
        return frontend_redirect("auth.html", error="invalid_google_state")

    code = request.args.get("code", "")
    if not code:
        return frontend_redirect("auth.html", error="missing_google_code")

    try:
        token_response = requests.post(
            GOOGLE_TOKEN_URL,
            data={
                "code": code,
                "client_id": GOOGLE_CLIENT_ID,
                "client_secret": GOOGLE_CLIENT_SECRET,
                "redirect_uri": GOOGLE_REDIRECT_URI,
                "grant_type": "authorization_code",
            },
            timeout=20,
        )
        token_response.raise_for_status()
        token_data = token_response.json()
        access_token = str(token_data.get("access_token", "")).strip()
        if not access_token:
            raise ValueError("missing access_token")

        userinfo_response = requests.get(
            GOOGLE_USERINFO_URL,
            headers={"Authorization": f"Bearer {access_token}"},
            timeout=20,
        )
        userinfo_response.raise_for_status()
        userinfo = userinfo_response.json()
    except (requests.RequestException, ValueError, TypeError):
        clear_logged_in_user()
        return frontend_redirect("auth.html", error="google_token_exchange_failed")

    google_sub = str(userinfo.get("sub", "")).strip()
    email = str(userinfo.get("email", "")).strip().lower()
    name = str(userinfo.get("name", "")).strip() or email
    picture = str(userinfo.get("picture", "")).strip()
    if not google_sub or not email:
        clear_logged_in_user()
        return frontend_redirect("auth.html", error="google_profile_incomplete")

    conn = get_db()
    try:
        user = conn.execute(
            """
            SELECT id, customer_id, name, email, password_hash,
                     email_verified, email_verified_at, email_verification_token_hash,
                     email_verification_sent_at, phone,
                     is_google_account, auth_provider, google_sub,
                     shipping_address_line1, shipping_address_line2, shipping_city,
                     shipping_state, shipping_postal_code, shipping_country,
                     billing_address_line1, billing_address_line2, billing_city,
                     billing_state, billing_postal_code, billing_country,
                     created_at, updated_at
            FROM users
            WHERE google_sub = ? OR email = ?
            ORDER BY CASE WHEN google_sub = ? THEN 0 ELSE 1 END
            LIMIT 1
            """,
            (google_sub, email, google_sub),
        ).fetchone()

        if user is None:
            customer_id = upsert_customer(conn, name=name, email=email)
            cursor = conn.execute(
                """
                INSERT INTO users (
                    customer_id, name, email, password_hash,
                    email_verified, email_verified_at, email_verification_token_hash,
                    email_verification_sent_at, phone,
                    is_google_account, auth_provider, google_sub, updated_at
                )
                VALUES (?, ?, ?, NULL, 1, ?, NULL, NULL, '', 1, 'google', ?, ?)
                """,
                (
                    customer_id,
                    name,
                    email,
                    now_iso(),
                    google_sub,
                    now_iso(),
                ),
            )
            user_id = int(cursor.lastrowid)
        else:
            customer_id = int(user["customer_id"])
            upsert_customer(conn, customer_id=customer_id, name=name, email=email, phone=user["phone"])
            conn.execute(
                """
                UPDATE users
                SET name = ?, email = ?,
                    is_google_account = 1, auth_provider = 'google', google_sub = ?,
                    email_verified = 1, email_verified_at = ?,
                    email_verification_token_hash = NULL,
                    email_verification_sent_at = NULL,
                    updated_at = ?
                WHERE id = ?
                """,
                (name, email, google_sub, now_iso(), now_iso(), user["id"]),
            )
            user_id = int(user["id"])

        conn.commit()
        authenticated_user = get_user_by_id(conn, user_id)
    finally:
        conn.close()

    set_logged_in_user(user_id, authenticated_user, picture=picture)
    session.pop("google_oauth_state", None)
    return frontend_redirect("account.html")


@app.get("/api/square/catalog/items")
def get_square_catalog_items():
    if not SQUARE_ACCESS_TOKEN:
        return jsonify({"error": "Missing Square configuration. Set SQUARE_ACCESS_TOKEN."}), 500

    text_filter = request.args.get("q", "").strip() or None
    limit = request.args.get("limit", "100").strip()

    try:
        limit_value = max(1, min(int(limit), 100))
    except ValueError:
        limit_value = 100

    client = get_square_client()
    try:
        response = client.catalog.search_items(text_filter=text_filter, limit=limit_value)
    except ApiError as exc:
        return jsonify({"error": "Square catalog request failed", "details": str(exc)}), 502

    catalog_items = response.items or []
    category_ids: list[str] = []
    for item in catalog_items:
        item_data = model_to_dict(item)
        item_details = model_to_dict(item_data.get("item_data"))
        category_ids.extend(extract_square_category_ids(item_details))

    category_names = fetch_square_category_names(list(dict.fromkeys(category_ids)))
    normalized = [
        normalize_square_catalog_item(item, category_names=category_names)
        for item in catalog_items
    ]
    return jsonify({"count": len(normalized), "items": normalized})


@app.post("/api/square/catalog/sync")
def sync_square_catalog_to_menu():
    if not SQUARE_ACCESS_TOKEN:
        return jsonify({"error": "Missing Square configuration. Set SQUARE_ACCESS_TOKEN."}), 500

    data = request.get_json(silent=True) or {}
    text_filter = str(data.get("q", "")).strip() or None

    conn = get_db()
    try:
        try:
            sync_result = refresh_square_menu_cache(conn)
        except ApiError as exc:
            return jsonify({"error": "Square catalog request failed", "details": str(exc)}), 502
        conn.commit()
    finally:
        conn.close()

    return jsonify(sync_result), 200


def parse_checkout_items(data: dict[str, Any]) -> list[dict[str, int]]:
    items = data.get("items")
    if isinstance(items, list):
        parsed = []
        for raw_item in items:
            try:
                parsed.append(
                    {
                        "menu_item_id": int(raw_item.get("menu_item_id")),
                        "quantity": int(raw_item.get("quantity", 1)),
                    }
                )
            except (TypeError, ValueError, AttributeError):
                raise ValueError("each item must include menu_item_id and quantity")
        return parsed

    items_json = data.get("items_json")
    if isinstance(items_json, str) and items_json.strip():
        try:
            parsed_json = json.loads(items_json)
        except json.JSONDecodeError as exc:
            raise ValueError("items_json is not valid JSON") from exc
        return parse_checkout_items({"items": parsed_json})

    try:
        menu_item_id = int(data.get("menu_item_id"))
        quantity = int(data.get("quantity", 1))
    except (TypeError, ValueError):
        raise ValueError("items are required")

    return [{"menu_item_id": menu_item_id, "quantity": quantity}]


def build_order_and_total(
    conn: sqlite3.Connection, items: list[dict[str, int]]
) -> tuple[list[dict[str, Any]], int]:
    if len(items) == 0:
        raise ValueError("items must be a non-empty list")

    expanded_items: list[dict[str, Any]] = []
    total_cents = 0

    for raw_item in items:
        menu_item_id = raw_item["menu_item_id"]
        quantity = raw_item["quantity"]

        if quantity <= 0:
            raise ValueError("quantity must be greater than 0")

        menu_item = conn.execute(
            """
            SELECT id, name, price_cents, is_available
            FROM menu_items
            WHERE id = ?
            """,
            (menu_item_id,),
        ).fetchone()

        if not menu_item:
            raise LookupError(f"menu_item_id {menu_item_id} not found")
        if menu_item["is_available"] != 1:
            raise ValueError(f"menu_item_id {menu_item_id} is not available")

        unit_price_cents = int(menu_item["price_cents"])
        line_total_cents = unit_price_cents * quantity
        total_cents += line_total_cents

        expanded_items.append(
            {
                "menu_item_id": menu_item_id,
                "quantity": quantity,
                "unit_price_cents": unit_price_cents,
                "line_total_cents": line_total_cents,
                "menu_item_name": menu_item["name"],
            }
        )

    return expanded_items, total_cents


def create_local_order(
    conn: sqlite3.Connection,
    customer_id: int | None,
    notes: str,
    expanded_items: list[dict[str, Any]],
    total_cents: int,
) -> int:
    cursor = conn.execute(
        """
        INSERT INTO orders (customer_id, status, total_cents, notes, payment_status)
        VALUES (?, 'new', ?, ?, 'pending')
        """,
        (customer_id, total_cents, notes),
    )
    order_id = cursor.lastrowid

    for item in expanded_items:
        conn.execute(
            """
            INSERT INTO order_items (
                order_id,
                menu_item_id,
                quantity,
                unit_price_cents,
                line_total_cents
            )
            VALUES (?, ?, ?, ?, ?)
            """,
            (
                order_id,
                item["menu_item_id"],
                item["quantity"],
                item["unit_price_cents"],
                item["line_total_cents"],
            ),
        )

    return order_id


@app.get("/api/menu")
def get_menu_items():
    conn = get_db()
    try:
        use_square_menu_only = False
        availability_live = False

        if SQUARE_ACCESS_TOKEN:
            try:
                sync_result = refresh_square_menu_cache(conn)
                conn.commit()
                availability_live = bool(sync_result.get("availability_live"))
            except (ApiError, requests.RequestException):
                conn.rollback()
            use_square_menu_only = get_cached_square_menu_count(conn) > 0

        rows = conn.execute(
            """
            SELECT id, name, category, description, price_cents, is_available,
                   square_catalog_id, square_variation_id, created_at
            FROM menu_items
            WHERE (? = 0 OR square_catalog_id IS NOT NULL)
            ORDER BY
                CASE
                    WHEN TRIM(COALESCE(category, '')) = '' THEN 1
                    ELSE 0
                END ASC,
                LOWER(COALESCE(NULLIF(TRIM(category), ''), 'Uncategorized')) ASC,
                LOWER(name) ASC,
                id ASC
            """,
            (1 if use_square_menu_only else 0,),
        ).fetchall()
    finally:
        conn.close()

    items = []
    for row in rows:
        item = dict(row)
        item.pop("square_catalog_id", None)
        item.pop("square_variation_id", None)
        if use_square_menu_only and not availability_live:
            item["is_available"] = None
        items.append(item)

    return jsonify(items)


@app.post("/api/menu")
def create_menu_item():
    data = request.get_json(silent=True) or {}
    name = str(data.get("name", "")).strip()
    description = str(data.get("description", "")).strip()

    try:
        price_cents = int(data.get("price_cents", -1))
    except (TypeError, ValueError):
        price_cents = -1

    if not name:
        return jsonify({"error": "name is required"}), 400
    if price_cents < 0:
        return jsonify({"error": "price_cents must be a non-negative integer"}), 400

    conn = get_db()
    try:
        cursor = conn.execute(
            """
            INSERT INTO menu_items (name, category, description, price_cents)
            VALUES (?, ?, ?, ?)
            """,
            (name, "", description, price_cents),
        )
        conn.commit()
        item_id = cursor.lastrowid
        row = conn.execute(
            """
            SELECT id, name, category, description, price_cents, is_available, created_at
            FROM menu_items
            WHERE id = ?
            """,
            (item_id,),
        ).fetchone()
    finally:
        conn.close()

    return jsonify(dict(row)), 201


@app.get("/api/customers")
def get_customers():
    conn = get_db()
    try:
        rows = conn.execute(
            """
            SELECT id, name, email, phone, created_at
            FROM customers
            ORDER BY id ASC
            """
        ).fetchall()
    finally:
        conn.close()

    return jsonify([dict(row) for row in rows])


@app.post("/api/customers")
def create_customer():
    data = request.get_json(silent=True) or {}
    name = str(data.get("name", "")).strip()
    email = str(data.get("email", "")).strip()
    phone = str(data.get("phone", "")).strip()

    if not name:
        return jsonify({"error": "name is required"}), 400

    conn = get_db()
    try:
        cursor = conn.execute(
            """
            INSERT INTO customers (name, email, phone)
            VALUES (?, ?, ?)
            """,
            (name, email, phone),
        )
        conn.commit()
        customer_id = cursor.lastrowid
        row = conn.execute(
            """
            SELECT id, name, email, phone, created_at
            FROM customers
            WHERE id = ?
            """,
            (customer_id,),
        ).fetchone()
    finally:
        conn.close()

    return jsonify(dict(row)), 201


@app.post("/api/me")
@login_required
def update_current_user_profile():
    data = request.get_json(silent=True) or {}

    conn = get_db()
    try:
        user = get_current_user(conn)
        if user is None:
            clear_logged_in_user()
            return jsonify({"error": "Authentication required"}), 401

        name = str(data.get("name", user["name"] or "")).strip()
        email = str(data.get("email", user["email"] or "")).strip().lower()
        phone = str(data.get("phone", user["phone"] or "")).strip()
        shipping_address_line1 = str(data.get("shipping_address_line1", user["shipping_address_line1"] or "")).strip()
        shipping_address_line2 = str(data.get("shipping_address_line2", user["shipping_address_line2"] or "")).strip()
        shipping_city = str(data.get("shipping_city", user["shipping_city"] or "")).strip()
        shipping_state = str(data.get("shipping_state", user["shipping_state"] or "")).strip()
        shipping_postal_code = str(data.get("shipping_postal_code", user["shipping_postal_code"] or "")).strip()
        shipping_country = str(data.get("shipping_country", user["shipping_country"] or "")).strip()
        billing_address_line1 = str(data.get("billing_address_line1", user["billing_address_line1"] or "")).strip()
        billing_address_line2 = str(data.get("billing_address_line2", user["billing_address_line2"] or "")).strip()
        billing_city = str(data.get("billing_city", user["billing_city"] or "")).strip()
        billing_state = str(data.get("billing_state", user["billing_state"] or "")).strip()
        billing_postal_code = str(data.get("billing_postal_code", user["billing_postal_code"] or "")).strip()
        billing_country = str(data.get("billing_country", user["billing_country"] or "")).strip()

        if not name:
            return jsonify({"error": "name is required"}), 400
        if email:
            email_owner = conn.execute(
                "SELECT id FROM users WHERE email = ? AND id <> ?",
                (email, user["id"]),
            ).fetchone()
            if email_owner is not None:
                return jsonify({"error": "That email is already in use"}), 409

        conn.execute(
            """
            UPDATE users
            SET name = ?, email = ?, phone = ?,
                shipping_address_line1 = ?,
                shipping_address_line2 = ?, shipping_city = ?, shipping_state = ?,
                shipping_postal_code = ?, shipping_country = ?,
                billing_address_line1 = ?, billing_address_line2 = ?,
                billing_city = ?, billing_state = ?, billing_postal_code = ?,
                billing_country = ?, updated_at = ?
            WHERE id = ?
            """,
            (
                name,
                email or None,
                phone,
                shipping_address_line1,
                shipping_address_line2,
                shipping_city,
                shipping_state,
                shipping_postal_code,
                shipping_country,
                billing_address_line1,
                billing_address_line2,
                billing_city,
                billing_state,
                billing_postal_code,
                billing_country,
                now_iso(),
                user["id"],
            ),
        )
        upsert_customer(
            conn,
            customer_id=int(user["customer_id"]),
            name=name,
            email=email,
            phone=phone,
        )
        conn.commit()
        updated_user = get_user_by_id(conn, int(user["id"]))
        current_picture = str((session.get("user") or {}).get("picture", "") or "")
        set_logged_in_user(int(user["id"]), updated_user, picture=current_picture)
    finally:
        conn.close()

    return jsonify({"user": get_public_user_dict(updated_user, session.get("user"))}), 200


@app.post("/api/me/password")
@login_required
def update_current_user_password():
    data = request.get_json(silent=True) or {}
    current_password = str(data.get("current_password", ""))
    new_password = str(data.get("new_password", ""))

    if len(new_password) < 6:
        return jsonify({"error": "New password must be at least 6 characters"}), 400

    conn = get_db()
    try:
        user = get_current_user(conn)
        if user is None:
            clear_logged_in_user()
            return jsonify({"error": "Authentication required"}), 401
        if user["is_google_account"]:
            return jsonify({"error": "Google accounts do not use a local password"}), 400
        if not user["password_hash"] or not check_password_hash(
            user["password_hash"], current_password
        ):
            return jsonify({"error": "Current password is incorrect"}), 401

        conn.execute(
            "UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?",
            (generate_password_hash(new_password), now_iso(), user["id"]),
        )
        conn.commit()
    finally:
        conn.close()

    return jsonify({"ok": True}), 200


@app.get("/api/my/orders")
@login_required
def get_my_orders():
    conn = get_db()
    try:
        user = get_current_user(conn)
        if user is None:
            clear_logged_in_user()
            return jsonify({"error": "Authentication required"}), 401

        order_rows = conn.execute(
            """
                 SELECT id, customer_id, status, total_cents, notes, payment_status,
                     square_payment_id, paid_at, created_at
            FROM orders
            WHERE customer_id = ?
            ORDER BY id DESC
            """,
            (user["customer_id"],),
        ).fetchall()

        orders = []
        for order in order_rows:
            item_rows = conn.execute(
                """
                SELECT oi.id, oi.order_id, oi.menu_item_id, oi.quantity,
                       oi.unit_price_cents, oi.line_total_cents, mi.name AS menu_item_name
                FROM order_items oi
                JOIN menu_items mi ON mi.id = oi.menu_item_id
                WHERE oi.order_id = ?
                ORDER BY oi.id ASC
                """,
                (order["id"],),
            ).fetchall()
            order_dict = dict(order)
            order_dict["items"] = [dict(item) for item in item_rows]
            orders.append(order_dict)
    finally:
        conn.close()

    return jsonify(orders), 200


@app.get("/api/orders")
def get_orders():
    conn = get_db()
    try:
        order_rows = conn.execute(
            """
                 SELECT id, customer_id, status, total_cents, notes, payment_status,
                     square_payment_id, paid_at, created_at
            FROM orders
            ORDER BY id DESC
            """
        ).fetchall()

        orders = []
        for order in order_rows:
            item_rows = conn.execute(
                """
                SELECT oi.id, oi.order_id, oi.menu_item_id, oi.quantity,
                       oi.unit_price_cents, oi.line_total_cents, mi.name AS menu_item_name
                FROM order_items oi
                JOIN menu_items mi ON mi.id = oi.menu_item_id
                WHERE oi.order_id = ?
                ORDER BY oi.id ASC
                """,
                (order["id"],),
            ).fetchall()
            order_dict = dict(order)
            order_dict["items"] = [dict(item) for item in item_rows]
            orders.append(order_dict)
    finally:
        conn.close()

    return jsonify(orders)


@app.post("/api/contact")
@login_required
def submit_contact_form():
    data = request.get_json(silent=True) or {}
    subject = str(data.get("subject", "") or "").strip()
    message = str(data.get("message", "") or "").strip()

    if not subject:
        return jsonify({"error": "Subject is required."}), 400
    if not message:
        return jsonify({"error": "Message is required."}), 400

    conn = get_db()
    try:
        user = get_current_user(conn)
        if user is None:
            clear_logged_in_user()
            return jsonify({"error": "Authentication required"}), 401

        if not bool(user["is_google_account"]) and not bool(user["email_verified"]):
            return jsonify(
                {
                    "error": "Verify your email before using the contact form.",
                    "verification_required": True,
                    "email": str(user["email"] or ""),
                }
            ), 403

        sender_name = str(data.get("name", "") or user["name"] or user["email"] or "Account holder").strip()
        sender_email = str(user["email"] or data.get("email", "") or "").strip()

        print(
            "[contact form] "
            f"From: {sender_name} <{sender_email}>\n"
            f"Subject: {subject}\n\n"
            f"{message}",
            flush=True,
        )
    finally:
        conn.close()

    return jsonify(
        {
            "message": "Thanks for reaching out. Your message was accepted and logged for now.",
            "sender_name": sender_name,
            "sender_email": sender_email,
        }
    ), 200


@app.post("/api/orders")
def create_order():
    data = request.get_json(silent=True) or {}

    customer_id = data.get("customer_id")
    notes = str(data.get("notes", "")).strip()
    items = data.get("items", [])

    if not isinstance(items, list) or len(items) == 0:
        return jsonify({"error": "items must be a non-empty list"}), 400

    try:
        customer_id = int(customer_id)
    except (TypeError, ValueError):
        return jsonify({"error": "customer_id is required"}), 400

    conn = get_db()
    try:
        customer = conn.execute("SELECT id FROM customers WHERE id = ?", (customer_id,)).fetchone()
        if customer is None:
            return jsonify({"error": "customer_id not found"}), 404

        try:
            parsed_items = parse_checkout_items({"items": items})
            expanded_items, total_cents = build_order_and_total(conn, parsed_items)
        except ValueError as exc:
            return jsonify({"error": str(exc)}), 400
        except LookupError as exc:
            return jsonify({"error": str(exc)}), 404

        order_id = create_local_order(
            conn=conn,
            customer_id=customer_id,
            notes=notes,
            expanded_items=expanded_items,
            total_cents=total_cents,
        )

        conn.commit()

        order = conn.execute(
            """
                 SELECT id, customer_id, status, total_cents, notes, payment_status,
                     square_payment_id, paid_at, created_at
            FROM orders
            WHERE id = ?
            """,
            (order_id,),
        ).fetchone()

        result = dict(order)
        result["items"] = expanded_items
    finally:
        conn.close()

    return jsonify(result), 201


@app.post("/api/checkout")
@app.post("/checkout")
def create_square_checkout():
    if not SQUARE_ACCESS_TOKEN or not SQUARE_LOCATION_ID:
        return jsonify(
            {
                "error": "Missing Square configuration. Set SQUARE_ACCESS_TOKEN and SQUARE_LOCATION_ID."
            }
        ), 500

    data: dict[str, Any]
    if request.is_json:
        data = request.get_json(silent=True) or {}
    else:
        data = request.form.to_dict(flat=True)

    notes = str(data.get("notes", "")).strip()
    buyer_email = str(data.get("buyer_email", "")).strip()
    allow_cash_app = to_bool(data.get("allow_cash_app"), default=to_bool(SQUARE_ENABLE_CASH_APP_PAY, True))
    allow_ach = to_bool(data.get("allow_ach"), default=to_bool(SQUARE_ENABLE_ACH_REQUEST, True))

    customer_id_raw = data.get("customer_id")
    customer_id: int | None = None
    if customer_id_raw not in (None, ""):
        try:
            customer_id = int(customer_id_raw)
        except (TypeError, ValueError):
            return jsonify({"error": "customer_id must be an integer when provided"}), 400

    try:
        parsed_items = parse_checkout_items(data)
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400

    conn = get_db()
    try:
        if customer_id is not None:
            customer = conn.execute("SELECT id FROM customers WHERE id = ?", (customer_id,)).fetchone()
            if customer is None:
                return jsonify({"error": "customer_id not found"}), 404

        try:
            expanded_items, total_cents = build_order_and_total(conn, parsed_items)
        except ValueError as exc:
            return jsonify({"error": str(exc)}), 400
        except LookupError as exc:
            return jsonify({"error": str(exc)}), 404

        order_id = create_local_order(
            conn=conn,
            customer_id=customer_id,
            notes=notes,
            expanded_items=expanded_items,
            total_cents=total_cents,
        )
        conn.commit()

        client = get_square_client()
        create_kwargs: dict[str, Any] = {
            "idempotency_key": str(uuid4()),
            "quick_pay": {
                "name": f"Bagel Shop Order #{order_id}",
                "price_money": {"amount": total_cents, "currency": "USD"},
                "location_id": SQUARE_LOCATION_ID,
            },
            "checkout_options": {
                "redirect_url": f"{APP_BASE_URL}/checkout/success?order_id={order_id}",
                "accepted_payment_methods": {
                    "apple_pay": True,
                    "google_pay": True,
                    "cash_app_pay": allow_cash_app,
                },
            },
            "payment_note": f"bagelshop_order_id:{order_id}",
        }
        if buyer_email:
            create_kwargs["pre_populated_data"] = {"buyer_email": buyer_email}

        try:
            checkout_response = client.checkout.payment_links.create(**create_kwargs)
        except ApiError as exc:
            conn.execute(
                "UPDATE orders SET payment_status = 'failed' WHERE id = ?", (order_id,)
            )
            conn.commit()
            return jsonify({"error": "Square checkout creation failed", "details": str(exc)}), 502

        checkout_url = checkout_response.payment_link.url
        ach_message = None
        if allow_ach:
            ach_message = (
                "Square Payment Links do not expose ACH as a direct accepted_payment_methods option. "
                "Cash App Pay is enabled when allowed."
            )

        if request.path == "/checkout" and not request.is_json:
            return redirect(checkout_url, code=302)

        return jsonify(
            {
                "order_id": order_id,
                "checkout_url": checkout_url,
                "requested_payment_methods": {
                    "cash_app_pay": allow_cash_app,
                    "ach": allow_ach,
                },
                "payment_method_note": ach_message,
            }
        ), 201
    finally:
        conn.close()


@app.get("/checkout/success")
def checkout_success_page():
    order_id = request.args.get("order_id", "")
    return (
        f"Payment submitted. Thank you for your order. Order ID: {order_id}. "
        "You can close this page."
    )


@app.post("/webhooks/square")
def square_webhook():
    if not SQUARE_WEBHOOK_SIGNATURE_KEY:
        return jsonify({"error": "Missing SQUARE_WEBHOOK_SIGNATURE_KEY"}), 500

    payload = request.get_data(as_text=True)
    signature_header = request.headers.get("x-square-hmacsha256-signature", "")
    notification_url = SQUARE_WEBHOOK_NOTIFICATION_URL or request.url

    if not signature_header:
        return jsonify({"error": "missing signature header"}), 401

    is_valid = verify_square_webhook_signature(
        payload,
        signature_header,
        SQUARE_WEBHOOK_SIGNATURE_KEY,
        notification_url,
    )
    if not is_valid:
        return jsonify({"error": "invalid signature"}), 401

    try:
        event = request.get_json(force=True)
    except Exception:
        return jsonify({"error": "invalid JSON payload"}), 400

    event_type = event.get("type", "")

    # --- Payment events ---
    payment_data = (((event.get("data") or {}).get("object") or {}).get("payment") or {})
    if event_type in {"payment.created", "payment.updated"} and payment_data:
        payment_id = payment_data.get("id")
        payment_status = payment_data.get("status", "")
        payment_note = str(payment_data.get("note", ""))

        order_id: int | None = None
        marker = "bagelshop_order_id:"
        if marker in payment_note:
            try:
                order_id = int(payment_note.split(marker, 1)[1].strip())
            except ValueError:
                order_id = None

        if order_id is not None:
            conn = get_db()
            try:
                if payment_status == "COMPLETED":
                    conn.execute(
                        """
                        UPDATE orders
                        SET payment_status = 'paid', square_payment_id = ?, paid_at = COALESCE(paid_at, ?)
                        WHERE id = ?
                        """,
                        (
                            payment_id,
                            str(
                                payment_data.get("updated_at")
                                or payment_data.get("created_at")
                                or now_iso()
                            ),
                            order_id,
                        ),
                    )
                elif payment_status in {"FAILED", "CANCELED"}:
                    conn.execute(
                        """
                        UPDATE orders
                        SET payment_status = 'failed', square_payment_id = ?
                        WHERE id = ?
                        """,
                        (payment_id, order_id),
                    )
                conn.commit()
            finally:
                conn.close()

    # --- Catalog change: pull fresh items from Square and upsert locally ---
    elif event_type == "catalog.version.updated":
        if SQUARE_ACCESS_TOKEN:
            try:
                client = get_square_client()
                response = client.catalog.search_items(limit=100)
                catalog_items = response.items or []
                conn = get_db()
                try:
                    sync_square_catalog_into_menu(conn)
                    conn.commit()
                finally:
                    conn.close()
            except Exception:
                pass  # Square will retry the webhook on failure

    # --- Inventory change: flip is_available when stock hits zero ---
    elif event_type == "inventory.count.updated":
        counts = (
            ((event.get("data") or {}).get("object") or {})
            .get("inventory_counts", [])
        ) or []
        if counts:
            conn = get_db()
            try:
                for count in counts:
                    variation_id = count.get("catalog_object_id", "")
                    state = count.get("state", "")
                    try:
                        qty = float(count.get("quantity", "0"))
                    except (TypeError, ValueError):
                        qty = 0.0
                    if not variation_id or state != "IN_STOCK":
                        continue
                    conn.execute(
                        "UPDATE menu_items SET is_available = ? WHERE square_variation_id = ?",
                        (1 if qty > 0 else 0, variation_id),
                    )
                conn.commit()
            finally:
                conn.close()

    return jsonify({"ok": True}), 200


@app.post("/api/seed")
def seed_data():
    # Optional helper for quick local testing.
    sample_items = [
        ("Plain Bagel", "Classic kettle-boiled plain bagel", 250),
        ("Everything Bagel", "Topped with sesame, poppy, garlic, onion", 320),
        ("Scallion Cream Cheese", "House-made scallion spread", 180),
    ]

    conn = get_db()
    try:
        existing = conn.execute("SELECT COUNT(*) AS count FROM menu_items").fetchone()
        if existing["count"] > 0:
            return jsonify({"message": "menu already has items"})

        conn.executemany(
            """
            INSERT INTO menu_items (name, description, price_cents)
            VALUES (?, ?, ?)
            """,
            sample_items,
        )
        conn.commit()
    finally:
        conn.close()

    return jsonify({"message": "seeded"}), 201


if __name__ == "__main__":
    init_db()
    app.run(host="127.0.0.1", port=5000, debug=True)
