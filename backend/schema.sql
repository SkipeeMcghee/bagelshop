PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS menu_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    image_url TEXT NOT NULL DEFAULT '',
    price_cents INTEGER NOT NULL CHECK (price_cents >= 0),
    is_available INTEGER NOT NULL DEFAULT 1,
    square_catalog_id TEXT,
    square_variation_id TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS customers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT,
    phone TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

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
    shipping_address_line2 TEXT DEFAULT NULL,
    shipping_city TEXT NOT NULL DEFAULT '',
    shipping_state TEXT NOT NULL DEFAULT '',
    shipping_postal_code TEXT NOT NULL DEFAULT '',
    shipping_country TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL DEFAULT '',
    event_date TEXT NOT NULL,
    location TEXT NOT NULL DEFAULT '',
    start_time TEXT NOT NULL DEFAULT '',
    end_time TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id INTEGER,
    status TEXT NOT NULL DEFAULT 'new',
    subtotal_cents INTEGER NOT NULL DEFAULT 0 CHECK (subtotal_cents >= 0),
    total_cents INTEGER NOT NULL DEFAULT 0 CHECK (total_cents >= 0),
    notes TEXT NOT NULL DEFAULT '',
    fulfillment_method TEXT NOT NULL DEFAULT 'pickup' CHECK (fulfillment_method IN ('pickup', 'delivery')),
    buyer_phone TEXT NOT NULL DEFAULT '',
    delivery_address_line1 TEXT NOT NULL DEFAULT '',
    delivery_address_line2 TEXT NOT NULL DEFAULT '',
    delivery_city TEXT NOT NULL DEFAULT '',
    delivery_state TEXT NOT NULL DEFAULT '',
    delivery_postal_code TEXT NOT NULL DEFAULT '',
    delivery_country TEXT NOT NULL DEFAULT '',
    delivery_distance_miles REAL,
    delivery_fee_cents INTEGER NOT NULL DEFAULT 0 CHECK (delivery_fee_cents >= 0),
    delivery_fee_waived INTEGER NOT NULL DEFAULT 0,
    delivery_fee_rule_label TEXT NOT NULL DEFAULT '',
    shipping_required INTEGER NOT NULL DEFAULT 0,
    shipping_deposit_cents INTEGER NOT NULL DEFAULT 0 CHECK (shipping_deposit_cents >= 0),
    pickup_location_name TEXT NOT NULL DEFAULT '',
    payment_status TEXT NOT NULL DEFAULT 'pending' CHECK (payment_status IN ('pending', 'paid', 'failed')),
    square_payment_id TEXT,
    paid_at TEXT,
    confirmation_email_sent_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (customer_id) REFERENCES customers(id)
);

CREATE TABLE IF NOT EXISTS delivery_settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    origin_address_line1 TEXT NOT NULL DEFAULT '',
    origin_address_line2 TEXT DEFAULT NULL,
    origin_city TEXT NOT NULL DEFAULT '',
    origin_state TEXT NOT NULL DEFAULT '',
    origin_postal_code TEXT NOT NULL DEFAULT '',
    origin_country TEXT NOT NULL DEFAULT 'US',
    base_fee_cents INTEGER NOT NULL DEFAULT 299 CHECK (base_fee_cents >= 0),
    per_mile_fee_cents INTEGER NOT NULL DEFAULT 85 CHECK (per_mile_fee_cents >= 0),
    long_distance_shipping_threshold_miles REAL NOT NULL DEFAULT 30 CHECK (long_distance_shipping_threshold_miles >= 0),
    long_distance_deposit_cents INTEGER NOT NULL DEFAULT 20000 CHECK (long_distance_deposit_cents >= 0),
    pickup_location_name TEXT NOT NULL DEFAULT 'Daytona Supply Warehouse',
    pickup_address_line1 TEXT NOT NULL DEFAULT '',
    pickup_address_line2 TEXT DEFAULT NULL,
    pickup_city TEXT NOT NULL DEFAULT '',
    pickup_state TEXT NOT NULL DEFAULT '',
    pickup_postal_code TEXT NOT NULL DEFAULT '',
    pickup_country TEXT NOT NULL DEFAULT 'US',
    require_phone_for_pickup INTEGER NOT NULL DEFAULT 1,
    require_address_for_delivery INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS delivery_fee_waivers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    label TEXT NOT NULL DEFAULT '',
    max_distance_miles REAL NOT NULL CHECK (max_distance_miles >= 0),
    minimum_subtotal_cents INTEGER NOT NULL CHECK (minimum_subtotal_cents >= 0),
    active INTEGER NOT NULL DEFAULT 1,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS ignored_inventory (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    match_type TEXT NOT NULL DEFAULT 'category' CHECK (match_type IN ('category')),
    match_value TEXT NOT NULL DEFAULT '',
    active INTEGER NOT NULL DEFAULT 1,
    notes TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (match_type, match_value)
);

CREATE TABLE IF NOT EXISTS order_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id INTEGER NOT NULL,
    menu_item_id INTEGER NOT NULL,
    quantity INTEGER NOT NULL CHECK (quantity > 0),
    unit_price_cents INTEGER NOT NULL CHECK (unit_price_cents >= 0),
    line_total_cents INTEGER NOT NULL CHECK (line_total_cents >= 0),
    FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE,
    FOREIGN KEY (menu_item_id) REFERENCES menu_items(id)
);
