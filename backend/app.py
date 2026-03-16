from __future__ import annotations

import os
import json
import sqlite3
import base64
import hmac
import hashlib
from pathlib import Path
from typing import Any
from uuid import uuid4

from flask import Flask, jsonify, redirect, request
from square.client import Square
from square.core.api_error import ApiError
from square.environment import SquareEnvironment

BASE_DIR = Path(__file__).resolve().parent
DB_PATH = BASE_DIR / "bagelshop.db"
SCHEMA_PATH = BASE_DIR / "schema.sql"

app = Flask(__name__)

SQUARE_ACCESS_TOKEN = os.getenv("SQUARE_ACCESS_TOKEN", "")
SQUARE_LOCATION_ID = os.getenv("SQUARE_LOCATION_ID", "")
SQUARE_ENVIRONMENT = os.getenv("SQUARE_ENVIRONMENT", "sandbox")
SQUARE_WEBHOOK_SIGNATURE_KEY = os.getenv("SQUARE_WEBHOOK_SIGNATURE_KEY", "")
SQUARE_WEBHOOK_NOTIFICATION_URL = os.getenv("SQUARE_WEBHOOK_NOTIFICATION_URL", "")
APP_BASE_URL = os.getenv("APP_BASE_URL", "http://127.0.0.1:5000")
SQUARE_ENABLE_CASH_APP_PAY = os.getenv("SQUARE_ENABLE_CASH_APP_PAY", "1")
SQUARE_ENABLE_ACH_REQUEST = os.getenv("SQUARE_ENABLE_ACH_REQUEST", "1")


def get_square_client() -> Square:
    environment = (
        SquareEnvironment.PRODUCTION
        if SQUARE_ENVIRONMENT.lower() == "production"
        else SquareEnvironment.SANDBOX
    )
    return Square(token=SQUARE_ACCESS_TOKEN, environment=environment)


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


def normalize_square_catalog_item(item: Any) -> dict[str, Any]:
    item_id = getattr(item, "id", None)
    item_data = model_to_dict(item)
    name = item_data.get("name", "")
    description = item_data.get("description", "")

    price_cents: int | None = None
    variation_id: str | None = None
    for variation in item_data.get("variations", []) or []:
        variation_data = model_to_dict(variation)
        price_money = model_to_dict(variation_data.get("price_money"))
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
        "description": description,
        "price_cents": price_cents,
        "variation_id": variation_id,
    }


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

    menu_columns = {
        row["name"] for row in conn.execute("PRAGMA table_info(menu_items)").fetchall()
    }
    if "square_catalog_id" not in menu_columns:
        conn.execute("ALTER TABLE menu_items ADD COLUMN square_catalog_id TEXT")
    if "square_variation_id" not in menu_columns:
        conn.execute("ALTER TABLE menu_items ADD COLUMN square_variation_id TEXT")


@app.after_request
def add_cors_headers(response):
    # Keep CORS open for local dev and static hosting like GitHub Pages.
    response.headers["Access-Control-Allow-Origin"] = "*"
    response.headers["Access-Control-Allow-Headers"] = "Content-Type"
    response.headers["Access-Control-Allow-Methods"] = "GET,POST,OPTIONS"
    return response


@app.route("/api/<path:_path>", methods=["OPTIONS"])
def preflight(_path: str):
    return ("", 204)


@app.get("/api/health")
def health_check():
    return jsonify({"status": "ok"})


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
    normalized = [normalize_square_catalog_item(item) for item in catalog_items]
    return jsonify({"count": len(normalized), "items": normalized})


@app.post("/api/square/catalog/sync")
def sync_square_catalog_to_menu():
    if not SQUARE_ACCESS_TOKEN:
        return jsonify({"error": "Missing Square configuration. Set SQUARE_ACCESS_TOKEN."}), 500

    data = request.get_json(silent=True) or {}
    text_filter = str(data.get("q", "")).strip() or None

    client = get_square_client()
    try:
        response = client.catalog.search_items(text_filter=text_filter, limit=100)
    except ApiError as exc:
        return jsonify({"error": "Square catalog request failed", "details": str(exc)}), 502

    catalog_items = response.items or []
    normalized = [normalize_square_catalog_item(item) for item in catalog_items]

    conn = get_db()
    inserted = 0
    updated = 0
    skipped = 0
    try:
        for item in normalized:
            name = str(item.get("name", "")).strip()
            description = str(item.get("description", "")).strip()
            price_cents = item.get("price_cents")
            square_catalog_id = item.get("id")
            square_variation_id = item.get("variation_id")

            if not name or price_cents is None:
                skipped += 1
                continue

            # Prefer matching by Square catalog ID if already synced once.
            existing = None
            if square_catalog_id:
                existing = conn.execute(
                    "SELECT id FROM menu_items WHERE square_catalog_id = ?",
                    (square_catalog_id,),
                ).fetchone()
            if existing is None:
                existing = conn.execute(
                    "SELECT id FROM menu_items WHERE name = ?",
                    (name,),
                ).fetchone()

            if existing:
                conn.execute(
                    """
                    UPDATE menu_items
                    SET description = ?, price_cents = ?, is_available = 1,
                        square_catalog_id = ?, square_variation_id = ?
                    WHERE id = ?
                    """,
                    (description, int(price_cents), square_catalog_id,
                     square_variation_id, existing["id"]),
                )
                updated += 1
            else:
                conn.execute(
                    """
                    INSERT INTO menu_items
                        (name, description, price_cents, is_available,
                         square_catalog_id, square_variation_id)
                    VALUES (?, ?, ?, 1, ?, ?)
                    """,
                    (name, description, int(price_cents),
                     square_catalog_id, square_variation_id),
                )
                inserted += 1

        conn.commit()
    finally:
        conn.close()

    return jsonify(
        {
            "inserted": inserted,
            "updated": updated,
            "skipped": skipped,
            "total_catalog_items": len(normalized),
        }
    ), 200


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
        rows = conn.execute(
            """
            SELECT id, name, description, price_cents, is_available, created_at
            FROM menu_items
            ORDER BY id ASC
            """
        ).fetchall()
    finally:
        conn.close()

    return jsonify([dict(row) for row in rows])


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
            INSERT INTO menu_items (name, description, price_cents)
            VALUES (?, ?, ?)
            """,
            (name, description, price_cents),
        )
        conn.commit()
        item_id = cursor.lastrowid
        row = conn.execute(
            """
            SELECT id, name, description, price_cents, is_available, created_at
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


@app.get("/api/orders")
def get_orders():
    conn = get_db()
    try:
        order_rows = conn.execute(
            """
            SELECT id, customer_id, status, total_cents, notes, payment_status,
                   square_payment_id, created_at
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
                   square_payment_id, created_at
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
                        SET payment_status = 'paid', square_payment_id = ?
                        WHERE id = ?
                        """,
                        (payment_id, order_id),
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
                normalized_items = [normalize_square_catalog_item(i) for i in catalog_items]
                conn = get_db()
                try:
                    for item in normalized_items:
                        name = str(item.get("name", "")).strip()
                        description = str(item.get("description", "")).strip()
                        price_cents = item.get("price_cents")
                        square_catalog_id = item.get("id")
                        square_variation_id = item.get("variation_id")
                        if not name or price_cents is None:
                            continue
                        existing = None
                        if square_catalog_id:
                            existing = conn.execute(
                                "SELECT id FROM menu_items WHERE square_catalog_id = ?",
                                (square_catalog_id,),
                            ).fetchone()
                        if existing is None:
                            existing = conn.execute(
                                "SELECT id FROM menu_items WHERE name = ?", (name,)
                            ).fetchone()
                        if existing:
                            conn.execute(
                                """
                                UPDATE menu_items
                                SET description = ?, price_cents = ?, is_available = 1,
                                    square_catalog_id = ?, square_variation_id = ?
                                WHERE id = ?
                                """,
                                (description, int(price_cents), square_catalog_id,
                                 square_variation_id, existing["id"]),
                            )
                        else:
                            conn.execute(
                                """
                                INSERT INTO menu_items
                                    (name, description, price_cents, is_available,
                                     square_catalog_id, square_variation_id)
                                VALUES (?, ?, ?, 1, ?, ?)
                                """,
                                (name, description, int(price_cents),
                                 square_catalog_id, square_variation_id),
                            )
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
