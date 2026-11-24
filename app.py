"""Local POS application. Build with PyInstaller from a 32-bit Win7 environment."""

import csv
import html
import io
import json
import math
import os
import secrets
import sqlite3
import sys
import threading
import unicodedata
import webbrowser
from datetime import date, datetime, timedelta
from functools import wraps
from html.parser import HTMLParser
from markupsafe import escape
from pathlib import Path

from flask import Flask, g, jsonify, redirect, render_template, request, send_file, session, url_for, abort
from werkzeug.security import check_password_hash, generate_password_hash

import qrcode_gen


DEFAULT_SHOP_NAME = "Book Mart"
MAX_IMPORT_BYTES = 5 * 1024 * 1024
MAX_IMPORT_ROWS = 1000
MATERIAL_UNITS = {
    "g": "جرام",
    "kg": "كجم",
    "ml": "مل",
    "L": "لتر",
    "pcs": "قطعة",
}
# Canonical unit scales are used only to protect recipes: every unit belongs to a
# dimension (mass/volume/count) and carries a scale factor within that dimension.
# A material referenced by recipe_json must never be rescaled (e.g. kg <-> g),
# because recipe quantities are stored as raw numbers in the material's own unit.
MATERIAL_UNIT_SCALES = {
    "g": ("mass", 1.0),
    "kg": ("mass", 1000.0),
    "ml": ("volume", 1.0),
    "L": ("volume", 1000.0),
    "pcs": ("count", 1.0),
}
DRINK_CATEGORIES = {
    "hot": "ساخن",
    "espresso": "إسبريسو",
    "juice": "عصائر طازة",
    "frappe": "فريبي/بلند",
    "iced": "مشروبات مثلجة",
    "soda": "موهيتو/صودا",
    "smoothie": "سموذي",
    "milkshake": "ميلك شيك",
    "hotchoc": "ساکولاة ساخنة",
}
RETAIL_CATEGORIES = {
    "softdrink": "مشروبات غازية/جاهزة",
    "cookie": "کوكيز",
    "extra": "إضافات",
}
CATEGORY_SEEDS = [
    (slug, label, "drink", order)
    for order, (slug, label) in enumerate(DRINK_CATEGORIES.items(), 1)
] + [
    (slug, label, "retail", order)
    for order, (slug, label) in enumerate(RETAIL_CATEGORIES.items(), 1)
]


def category_slug_base(value):
    normalized = unicodedata.normalize("NFKC", str(value or "")).strip().casefold()
    slug = "".join(
        character if character.isalnum() or character in "-_" else "-"
        for character in normalized
    )
    return "-".join(part for part in slug.split("-") if part) or "category"


SEEDED_DRINKS = [
    ("شاي", "hot", 30), ("يانسون", "hot", 40), ("أعشاب", "hot", 35),
    ("قهوة تركي", "hot", 50), ("قهوة فرنسي", "hot", 65), ("قهوة بندق", "hot", 70),
    ("سايدر ساخن", "hot", 70),
    ("إسبريسو شوت", "espresso", 75), ("ماكياتو", "espresso", 80),
    ("كورتادو", "espresso", 85), ("فلات وايت", "espresso", 100),
    ("لاتيه", "espresso", 110), ("كابتشينو", "espresso", 110),
    ("موكا", "espresso", 120), ("موكا أبيض", "espresso", 120),
    ("عصير فراولة", "juice", 90), ("عصير مانجو", "juice", 90),
    ("عصير ليمون", "juice", 70), ("عصير برتقال", "juice", 75),
    ("فريبي كلاسيك", "frappe", 130), ("فريبي كراميل", "frappe", 140),
    ("فريبي سولتد كراميل", "frappe", 140), ("فريبي كراميل كريم بروليه", "frappe", 140),
    ("فريبي موكا", "frappe", 140), ("فريبي موكا أبيض", "frappe", 140),
    ("ماتشا بلند", "frappe", 150), ("فريبي فراولة", "frappe", 130),
    ("فريبي خوخ", "frappe", 130), ("فريبي باشن فروت", "frappe", 130),
    ("فريبي بلوبيري", "frappe", 130),
    ("آيس لاتيه", "iced", 110), ("آيس كابتشينو", "iced", 110),
    ("آيس موكا", "iced", 120), ("آيس موكا أبيض", "iced", 120),
    ("آيس ماتشا لاتيه", "iced", 120), ("آيس إسبانيش لاتيه", "iced", 130),
    ("آيس شيكن وايت موكا", "iced", 150),
    ("موهيتو كلاسيك", "soda", 90), ("موهيتو مانجو", "soda", 100),
    ("موهيتو بلوبيري", "soda", 100), ("موهيتو فراولة", "soda", 100),
    ("موهيتو باشن فروت", "soda", 100), ("بلو كوراساو", "soda", 100),
    ("ميكس ريدبول", "soda", 120), ("كريزي بينك", "soda", 130),
    ("سموذي فراولة", "smoothie", 100), ("سموذي خوخ", "smoothie", 100),
    ("سموذي بلوبيري", "smoothie", 100), ("سموذي باشن فروت", "smoothie", 100),
    ("ميلك شيك شوكولاتة", "milkshake", 140), ("ميلك شيك كراميل", "milkshake", 140),
    ("ميلك شيك سولتد كراميل", "milkshake", 140), ("ميلك شيك فانيليا", "milkshake", 140),
    ("ميلك شيك أوريو", "milkshake", 140), ("ميلك شيك خوخ", "milkshake", 140),
    ("ميلك شيك باشن فروت", "milkshake", 140), ("ميلك شيك فراولة", "milkshake", 140),
    ("ميلك شيك بلوبيري", "milkshake", 140), ("ميلك شيك كيوي", "milkshake", 140),
    ("ميلك شيك مانجو", "milkshake", 140),
    ("ساکولاة ساخنة", "hotchoc", 110), ("ساکولاة مارشميلو", "hotchoc", 125),
    ("ساکولاة فراولة", "hotchoc", 130),
]
SEEDED_RETAIL = [
    ("بيبسي", "softdrink", 50), ("ريدبول", "softdrink", 80), ("مية", "softdrink", 15),
    ("كلاسيك كوكيز", "cookie", 50), ("ريد فيلفيت كوكيز", "cookie", 60),
    ("نكهة إضافية", "extra", 30), ("صوص إضافي", "extra", 30),
    ("دريم ويب", "extra", 30), ("شوت إسبريسو", "extra", 40),
]
RETAIL_BOOK_ALIASES = {
    "بيبسي": ("بيبسي", "softdrink", 50),
    "pepsi": ("بيبسي", "softdrink", 50),
    "softdrink": ("بيبسي", "softdrink", 50),
    "ريدبول": ("ريدبول", "softdrink", 80),
    "redbull": ("ريدبول", "softdrink", 80),
    "red bull": ("ريدبول", "softdrink", 80),
    "مية": ("مية", "softdrink", 15),
    "water": ("مية", "softdrink", 15),
    "cookie": ("كلاسيك كوكيز", "cookie", 50),
    "cookies": ("كلاسيك كوكيز", "cookie", 50),
    "كلاسيك كوكيز": ("كلاسيك كوكيز", "cookie", 50),
    "كوكيز": ("كلاسيك كوكيز", "cookie", 50),
    "کوكيز": ("كلاسيك كوكيز", "cookie", 50),
    "ريد فيلفيت كوكيز": ("ريد فيلفيت كوكيز", "cookie", 60),
    "extra": ("نكهة إضافية", "extra", 30),
    "extras": ("نكهة إضافية", "extra", 30),
    "نكهة إضافية": ("نكهة إضافية", "extra", 30),
    "صوص إضافي": ("صوص إضافي", "extra", 30),
    "اضافات": ("نكهة إضافية", "extra", 30),
    "إضافات": ("نكهة إضافية", "extra", 30),
    "دريم ويب": ("دريم ويب", "extra", 30),
    "شوت إسبريسو": ("شوت إسبريسو", "extra", 40),
}
SEEDED_BOOKS = [
    ("موسوعة العلوم", "Original", 80, 110, 39),
    ("رواية الظل", "High Copy", 60, 100, 6),
]

# Every editable piece of text that can appear on a printed receipt. The admin
# replaces any of these from the settings screen; an empty value hides the line.
RECEIPT_SETTING_DEFAULTS = {
    "receipt_tagline": "Art & Gallery \u00b7 \u0641\u0631\u0639 \u0648\u0633\u0637 \u0627\u0644\u0628\u0644\u062f",
    "receipt_invoice_label": "\u0641\u0627\u062a\u0648\u0631\u0629",
    "receipt_cashier_label": "\u0627\u0644\u0643\u0627\u0634\u064a\u0631",
    "receipt_items_header": "\u0628\u0646\u062f \u0627\u0644\u0641\u0627\u062a\u0648\u0631\u0629",
    "receipt_items_count_label": "\u0639\u062f\u062f \u0627\u0644\u0623\u0635\u0646\u0627\u0641",
    "receipt_subtotal_label": "\u0627\u0644\u0645\u062c\u0645\u0648\u0639 \u0627\u0644\u0641\u0631\u0639\u064a",
    "receipt_discount_label": "\u0627\u0644\u062e\u0635\u0645",
    "receipt_total_label": "\u0627\u0644\u0625\u062c\u0645\u0627\u0644\u064a",
    "receipt_payment_label": "\u0637\u0631\u064a\u0642\u0629 \u0627\u0644\u062f\u0641\u0639",
    "receipt_paid_label": "\u0627\u0644\u0645\u062f\u0641\u0648\u0639",
    "receipt_change_label": "\u0627\u0644\u0628\u0627\u0642\u064a",
    "receipt_thanks": "\u0634\u0643\u0631\u0627\u064b \u0644\u0632\u064a\u0627\u0631\u062a\u0643\u0645",
    "receipt_contact_label": "\u0644\u0644\u0627\u0633\u062a\u0641\u0633\u0627\u0631",
    "receipt_phone": "0100 000 0000",
    "receipt_email": "bookmart@",
    "receipt_policy": "\u0627\u062d\u062a\u0641\u0638 \u0628\u0627\u0644\u0641\u0627\u062a\u0648\u0631\u0629 \u2014 \u0627\u0644\u0627\u0633\u062a\u0628\u062f\u0627\u0644 \u062e\u0644\u0627\u0644 3 \u0623\u064a\u0627\u0645",
    "receipt_currency": "\u062c.\u0645",
    "receipt_qr_mode": "none",
    "receipt_qr_value": "",
    "receipt_paper_width": "58",
    "receipt_show_logo": "1",
    "receipt_auto_print": "1",
}
RECEIPT_SETTING_KEYS = tuple(RECEIPT_SETTING_DEFAULTS)
RECEIPT_QR_MODES = ("none", "text", "url", "phone", "whatsapp", "email")
RECEIPT_PAPER_WIDTHS = ("58", "72", "80")
RECEIPT_FLAG_KEYS = ("receipt_show_logo", "receipt_auto_print")
PAYMENT_METHODS = ("\u0646\u0642\u062f\u064a", "\u0643\u0631\u062a", "\u0645\u062d\u0641\u0638\u0629")

# The uploaded brand image lives beside the database so a PyInstaller build can
# never write inside its own bundle.
LOGO_SETTINGS_KEY = "receipt_logo_file"
LOGO_SUFFIXES = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp"}
MAX_LOGO_BYTES = 2 * 1024 * 1024


def logo_file_name(value):
    name = str(value or "").strip()
    if not name:
        return None
    if "/" in name or "\\" in name:
        return None
    suffix = Path(name).suffix.lower()
    return name if suffix in LOGO_SUFFIXES else None


def current_logo_path(db):
    row = db.execute("SELECT value FROM settings WHERE key = ?", (LOGO_SETTINGS_KEY,)).fetchone()
    name = logo_file_name(row["value"] if row else "")
    if not name:
        return None
    path = DATA_DIR / name
    return path if path.is_file() else None



def resource_path(relative_path):
    """Resolve bundled resources both in development and in a PyInstaller build."""
    base = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parent))
    return base / relative_path


def data_directory():
    override = os.environ.get("BOOK_MART_DATA_DIR")
    if override:
        location = Path(override)
    elif os.environ.get("LOCALAPPDATA"):
        location = Path(os.environ["LOCALAPPDATA"]) / DEFAULT_SHOP_NAME.replace(" ", "")
    else:
        location = Path(__file__).resolve().parent
    location.mkdir(parents=True, exist_ok=True)
    return location


DATA_DIR = data_directory()
DATABASE = DATA_DIR / "database.db"
app = Flask(
    __name__,
    template_folder=str(resource_path("templates")),
    static_folder=str(resource_path("static")),
)
app.config.update(
    SECRET_KEY=None,
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE="Lax",
    DATABASE=str(DATABASE),
    MAX_CONTENT_LENGTH=MAX_IMPORT_BYTES + 65536,
)


def get_db():
    if "db" not in g:
        connection = sqlite3.connect(app.config["DATABASE"], timeout=10)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys = ON")
        connection.execute("PRAGMA busy_timeout = 10000")
        g.db = connection
    return g.db


@app.teardown_appcontext
def close_db(_error=None):
    connection = g.pop("db", None)
    if connection is not None:
        connection.close()


def seed_catalog(db):
    for name, category, price in SEEDED_DRINKS:
        seed = db.execute(
            "INSERT OR IGNORE INTO catalog_seed_keys(name, kind, category) VALUES (?, 'drink', ?)",
            (name, category),
        )
        if seed.rowcount:
            exists = db.execute(
                "SELECT 1 FROM drinks WHERE name = ? AND category = ? LIMIT 1",
                (name, category),
            ).fetchone()
            if not exists:
                db.execute(
                    "INSERT OR IGNORE INTO drinks(name, sell_price, recipe_json, category) "
                    "VALUES (?, ?, '[]', ?)",
                    (name, price, category),
                )

    for name, category, price in SEEDED_RETAIL:
        seed = db.execute(
            "INSERT OR IGNORE INTO catalog_seed_keys(name, kind, category) VALUES (?, 'retail', ?)",
            (name, category),
        )
        if seed.rowcount:
            db.execute(
                """INSERT OR IGNORE INTO retail
                   (name, category, cost_price, sell_price, stock_quantity, unit)
                   VALUES (?, ?, 0, ?, 0, 'قطعة')""",
                (name, category, price),
            )

    for title, book_type, cost, price, stock in SEEDED_BOOKS:
        seed = db.execute(
            "INSERT OR IGNORE INTO catalog_seed_keys(name, kind, category) VALUES (?, 'book', ?)",
            (title, book_type),
        )
        if seed.rowcount:
            exists = db.execute(
                "SELECT 1 FROM books WHERE title = ? AND type = ? LIMIT 1",
                (title, book_type),
            ).fetchone()
            if not exists:
                db.execute(
                    """INSERT OR IGNORE INTO books
                       (title, author, publisher, type, cost_price, sell_price, stock_quantity)
                       VALUES (?, '', '', ?, ?, ?, ?)""",
                    (title, book_type, cost, price, stock),
                )


def normalized_catalog_name(value):
    text = str(value or "").strip().casefold().replace("ك", "ک").replace("ى", "ي")
    return "".join(character for character in text if character.isalnum())


def migrated_retail_details(title):
    normalized = normalized_catalog_name(title)
    for alias, details in RETAIL_BOOK_ALIASES.items():
        alias_normalized = normalized_catalog_name(alias)
        if alias_normalized == normalized or (
            len(alias_normalized) >= 5 and normalized.startswith(alias_normalized)
        ):
            return details
    if any(
        normalized_catalog_name(keyword) in normalized
        for keyword in ("كوكيز", "کوكيز")
    ):
        return (str(title).strip(), "cookie", 0)
    if any(
        normalized_catalog_name(keyword) in normalized
        for keyword in ("إضافات", "إضافي", "اضافي")
    ):
        return (str(title).strip(), "extra", 0)
    return None


def is_retail_book_collision(title):
    if migrated_retail_details(title) is not None:
        return True
    normalized = normalized_catalog_name(title)
    return any(
        normalized_catalog_name(keyword) in normalized
        for keyword in ("كوكيز", "کوكيز", "إضافات", "إضافي", "اضافي")
    )


def migrate_retail_books(db):
    if db.execute(
        "SELECT 1 FROM settings WHERE key = 'retail_books_migrated_v1'"
    ).fetchone():
        return
    books = db.execute("SELECT id, title, sell_price FROM books ORDER BY id").fetchall()
    for book in books:
        details = migrated_retail_details(book["title"])
        if details is None:
            continue
        retail_name, category, default_price = details
        db.execute(
            """INSERT OR IGNORE INTO retail
               (name, category, cost_price, sell_price, stock_quantity, unit)
               VALUES (?, ?, 0, ?, 0, 'قطعة')""",
            (retail_name, category, book["sell_price"] or default_price),
        )
        db.execute(
            "UPDATE retail SET sell_price = ? WHERE name = ? AND category = ?",
            (book["sell_price"] if book["sell_price"] is not None else default_price, retail_name, category),
        )
        db.execute("DELETE FROM books WHERE id = ?", (book["id"],))
    db.execute(
        "INSERT INTO settings(key, value) VALUES ('retail_books_migrated_v1', 'complete')"
    )


def seed_categories(db):
    for slug, label, scope, sort_order in CATEGORY_SEEDS:
        db.execute(
            """INSERT OR IGNORE INTO categories
               (slug, label_ar, scope, sort_order, is_active, created_at)
               VALUES (?, ?, ?, ?, 1, ?)""",
            (slug, label, scope, sort_order, datetime.now().astimezone().isoformat(timespec="seconds")),
        )
    for table, scope in (("drinks", "drink"), ("retail", "retail")):
        for row in db.execute("SELECT DISTINCT category FROM " + table).fetchall():
            category = str(row["category"] or "").strip()
            if table == "drinks" and category.lower() == "cold":
                category = "iced"
            if not category:
                continue
            existing = db.execute(
                "SELECT scope FROM categories WHERE slug = ?", (category,)
            ).fetchone()
            if existing and existing["scope"] != scope:
                base = scope + "-" + category_slug_base(category)
                candidate = base
                suffix = 2
                while db.execute(
                    "SELECT 1 FROM categories WHERE slug = ?", (candidate,)
                ).fetchone():
                    candidate = base + "-" + str(suffix)
                    suffix += 1
                db.execute(
                    "UPDATE " + table + " SET category = ? WHERE category = ?",
                    (candidate, category),
                )
                category = candidate
            db.execute(
                """INSERT OR IGNORE INTO categories
                   (slug, label_ar, scope, sort_order, is_active, created_at)
                   VALUES (?, ?, ?, 100, 1, ?)""",
                (category, category, scope, datetime.now().astimezone().isoformat(timespec="seconds")),
            )


def ensure_category_defaults(db):
    seed_categories(db)
    db.commit()


def initialize_database():
    with app.app_context():
        db = get_db()
        db.executescript(
            """
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY,
                username TEXT NOT NULL UNIQUE,
                password_hash TEXT NOT NULL,
                role TEXT NOT NULL DEFAULT 'admin'
            );
            CREATE TABLE IF NOT EXISTS employees (
                id INTEGER PRIMARY KEY,
                username TEXT NOT NULL UNIQUE,
                password_hash TEXT NOT NULL,
                monthly_salary REAL NOT NULL DEFAULT 0 CHECK(monthly_salary >= 0),
                can_sell INTEGER NOT NULL DEFAULT 1,
                can_manage_expenses INTEGER NOT NULL DEFAULT 0,
                can_manage_purchases INTEGER NOT NULL DEFAULT 0,
                can_manage_inventory INTEGER NOT NULL DEFAULT 0,
                can_join_existing_shift INTEGER NOT NULL DEFAULT 0,
                is_active INTEGER NOT NULL DEFAULT 1,
                created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS business_days (
                id INTEGER PRIMARY KEY,
                project_date TEXT NOT NULL UNIQUE,
                opening_cash REAL NOT NULL DEFAULT 0,
                status TEXT NOT NULL DEFAULT 'open',
                created_at TEXT NOT NULL,
                closed_at TEXT,
                expected_cash REAL,
                counted_cash REAL,
                closing_variance REAL
            );
            CREATE TABLE IF NOT EXISTS shifts (
                id INTEGER PRIMARY KEY,
                employee_id INTEGER NOT NULL REFERENCES employees(id),
                business_day_id INTEGER NOT NULL REFERENCES business_days(id),
                started_at TEXT NOT NULL,
                ended_at TEXT,
                status TEXT NOT NULL DEFAULT 'open',
                opening_cash REAL NOT NULL DEFAULT 0,
                expected_cash REAL,
                counted_cash REAL,
                cash_variance REAL,
                worked_seconds INTEGER NOT NULL DEFAULT 0,
                payable_amount REAL NOT NULL DEFAULT 0,
                closure_reason TEXT,
                handover_to INTEGER REFERENCES employees(id)
            );
            CREATE UNIQUE INDEX IF NOT EXISTS one_open_shift_per_employee
                ON shifts(employee_id) WHERE status = 'open';
            CREATE TABLE IF NOT EXISTS cash_entries (
                id INTEGER PRIMARY KEY,
                business_day_id INTEGER NOT NULL REFERENCES business_days(id),
                shift_id INTEGER REFERENCES shifts(id),
                employee_id INTEGER REFERENCES employees(id),
                entry_type TEXT NOT NULL,
                amount REAL NOT NULL,
                category TEXT NOT NULL DEFAULT '',
                reference_type TEXT NOT NULL DEFAULT '',
                reference_id INTEGER,
                description TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL,
                UNIQUE(reference_type, reference_id, entry_type)
            );
            CREATE TABLE IF NOT EXISTS purchases (
                id INTEGER PRIMARY KEY,
                business_day_id INTEGER NOT NULL REFERENCES business_days(id),
                shift_id INTEGER REFERENCES shifts(id),
                employee_id INTEGER REFERENCES employees(id),
                timestamp TEXT NOT NULL,
                supplier TEXT NOT NULL DEFAULT '',
                category TEXT NOT NULL,
                amount REAL NOT NULL CHECK(amount >= 0),
                items_json TEXT NOT NULL,
                note TEXT NOT NULL DEFAULT ''
            );
            CREATE TABLE IF NOT EXISTS payroll_settlements (
                id INTEGER PRIMARY KEY,
                employee_id INTEGER NOT NULL REFERENCES employees(id),
                month TEXT NOT NULL,
                monthly_salary REAL NOT NULL,
                worked_seconds INTEGER NOT NULL,
                scheduled_seconds INTEGER NOT NULL,
                completed_shifts INTEGER NOT NULL,
                amount REAL NOT NULL CHECK(amount >= 0),
                paid_at TEXT NOT NULL,
                UNIQUE(employee_id, month)
            );
            CREATE TABLE IF NOT EXISTS materials (
                id INTEGER PRIMARY KEY,
                name TEXT NOT NULL,
                unit TEXT NOT NULL,
                cost_per_unit REAL NOT NULL CHECK(cost_per_unit >= 0),
                current_stock REAL NOT NULL DEFAULT 0 CHECK(current_stock >= 0),
                reorder_level REAL NOT NULL DEFAULT 5 CHECK(reorder_level >= 0),
                purchase_unit TEXT,
                usage_unit TEXT
            );
            CREATE TABLE IF NOT EXISTS drinks (
                id INTEGER PRIMARY KEY,
                name TEXT NOT NULL,
                sell_price REAL NOT NULL CHECK(sell_price >= 0),
                recipe_json TEXT NOT NULL DEFAULT '[]',
                category TEXT NOT NULL DEFAULT 'hot' -- NEW COLUMN FOR HOT/COLD CLASSIFICATION
            );
            CREATE TABLE IF NOT EXISTS books (
                id INTEGER PRIMARY KEY,
                title TEXT NOT NULL,
                author TEXT NOT NULL DEFAULT '',
                publisher TEXT NOT NULL DEFAULT '',
                type TEXT NOT NULL DEFAULT '', -- ORIGINAL/HIGH COPY
                cost_price REAL NOT NULL CHECK(cost_price >= 0),
                sell_price REAL NOT NULL CHECK(sell_price >= 0),
                stock_quantity INTEGER NOT NULL DEFAULT 0 CHECK(stock_quantity >= 0)
            );
            CREATE TABLE IF NOT EXISTS retail (
                id INTEGER PRIMARY KEY,
                name TEXT NOT NULL,
                category TEXT NOT NULL,
                cost_price REAL NOT NULL DEFAULT 0 CHECK(cost_price >= 0),
                sell_price REAL NOT NULL CHECK(sell_price >= 0),
                stock_quantity REAL NOT NULL DEFAULT 0 CHECK(stock_quantity >= 0),
                unit TEXT NOT NULL DEFAULT 'قطعة',
                UNIQUE(name, category)
            );
            CREATE TABLE IF NOT EXISTS catalog_seed_keys (
                name TEXT NOT NULL,
                kind TEXT NOT NULL,
                category TEXT NOT NULL,
                PRIMARY KEY(name, kind, category)
            );
            CREATE TABLE IF NOT EXISTS orders (
                id INTEGER PRIMARY KEY,
                timestamp TEXT NOT NULL,
                total_amount REAL NOT NULL,
                items_json TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'completed',
                cancelled_at TEXT,
                cancel_reason TEXT NOT NULL DEFAULT '',
                performed_by INTEGER,
                performed_by_name TEXT NOT NULL DEFAULT '',
                performed_by_role TEXT NOT NULL DEFAULT '',
                employee_id INTEGER REFERENCES employees(id),
                shift_id INTEGER REFERENCES shifts(id),
                business_day_id INTEGER REFERENCES business_days(id)
            );
            CREATE TABLE IF NOT EXISTS expenses (
                id INTEGER PRIMARY KEY,
                date TEXT NOT NULL,
                category TEXT NOT NULL,
                amount REAL NOT NULL CHECK(amount >= 0),
                note TEXT NOT NULL DEFAULT '',
                business_day_id INTEGER REFERENCES business_days(id),
                shift_id INTEGER REFERENCES shifts(id),
                employee_id INTEGER REFERENCES employees(id),
                purchase_id INTEGER REFERENCES purchases(id)
            );
            CREATE TABLE IF NOT EXISTS expense_categories (
                id INTEGER PRIMARY KEY,
                name TEXT NOT NULL UNIQUE,
                sort_order INTEGER NOT NULL DEFAULT 100,
                is_active INTEGER NOT NULL DEFAULT 1,
                created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS categories (
                id INTEGER PRIMARY KEY,
                slug TEXT NOT NULL UNIQUE,
                label_ar TEXT NOT NULL,
                scope TEXT NOT NULL,
                sort_order INTEGER NOT NULL DEFAULT 100,
                is_active INTEGER NOT NULL DEFAULT 1,
                created_at TEXT
            );
            CREATE TABLE IF NOT EXISTS project_log_notes (
                id INTEGER PRIMARY KEY,
                project_date TEXT NOT NULL,
                event_time TEXT NOT NULL,
                title TEXT NOT NULL,
                details TEXT NOT NULL DEFAULT '',
                created_by TEXT NOT NULL DEFAULT '',
                updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS purge_logs (
                id INTEGER PRIMARY KEY,
                scope TEXT NOT NULL,
                scope_label TEXT NOT NULL DEFAULT '',
                deleted_count INTEGER NOT NULL DEFAULT 0,
                performed_by INTEGER,
                performed_by_name TEXT NOT NULL DEFAULT '',
                performed_by_role TEXT NOT NULL DEFAULT '',
                performed_at TEXT NOT NULL,
                details TEXT NOT NULL DEFAULT ''
            );
            CREATE TABLE IF NOT EXISTS audit_logs (
                id INTEGER PRIMARY KEY,
                created_at TEXT NOT NULL,
                actor_id INTEGER,
                actor_name TEXT NOT NULL DEFAULT '',
                actor_role TEXT NOT NULL DEFAULT '',
                action TEXT NOT NULL,
                entity TEXT NOT NULL DEFAULT '',
                entity_id INTEGER,
                details TEXT NOT NULL DEFAULT ''
            );
            CREATE TABLE IF NOT EXISTS closing_reports (
                id INTEGER PRIMARY KEY,
                period_type TEXT NOT NULL,
                period_key TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'closed',
                payload_json TEXT NOT NULL,
                expected_cash REAL,
                counted_cash REAL,
                closing_variance REAL,
                closed_at TEXT NOT NULL,
                closed_by TEXT NOT NULL DEFAULT '',
                auto_generated INTEGER NOT NULL DEFAULT 0,
                UNIQUE(period_type, period_key)
            );
            """
        )
        
        # Migration Logic: Add columns if they don't exist (for older databases)
        migrations = [
            ("employees", "can_manage_inventory", "INTEGER NOT NULL DEFAULT 0"),
            ("employees", "can_join_existing_shift", "INTEGER NOT NULL DEFAULT 0"),
            ("materials", "reorder_level", "REAL NOT NULL DEFAULT 5"),
            ("drinks", "category", "TEXT NOT NULL DEFAULT 'hot'"), # Ensure category exists
            ("books", "publisher", "TEXT NOT NULL DEFAULT ''"),
            ("orders", "cancelled_at", "TEXT"),
            ("orders", "cancel_reason", "TEXT NOT NULL DEFAULT ''"),
            ("orders", "performed_by", "INTEGER"),
            ("orders", "performed_by_name", "TEXT NOT NULL DEFAULT ''"),
            ("orders", "performed_by_role", "TEXT NOT NULL DEFAULT ''"),
            ("orders", "employee_id", "INTEGER REFERENCES employees(id)"),
            ("orders", "shift_id", "INTEGER REFERENCES shifts(id)"),
            ("orders", "business_day_id", "INTEGER REFERENCES business_days(id)"),
            ("expenses", "business_day_id", "INTEGER REFERENCES business_days(id)"),
            ("expenses", "shift_id", "INTEGER REFERENCES shifts(id)"),
            ("expenses", "employee_id", "INTEGER REFERENCES employees(id)"),
            ("expenses", "purchase_id", "INTEGER REFERENCES purchases(id)"),
            ("purchases", "stock_adjusted", "INTEGER NOT NULL DEFAULT 0"),
            ("purchases", "date", "TEXT"),
            ("orders", "payment_method", "TEXT NOT NULL DEFAULT ''"),
            ("orders", "paid_amount", "REAL"),
            ("materials", "purchase_unit", "TEXT"),
            ("materials", "usage_unit", "TEXT"),
        ]
        
        for table, column, definition in migrations:
            try:
                cols = {row["name"] for row in db.execute(f"PRAGMA table_info({table})")}
                if column not in cols:
                    db.execute(f"ALTER TABLE {table} ADD COLUMN {column} {definition}")
                    print(f"Migrated: Added '{column}' to '{table}'")
            except Exception as e:
                print(f"Migration warning for {table}.{column}: {e}")

        # Legacy book reorder_level is intentionally retained in old databases but unused.
        if not db.execute(
            "SELECT 1 FROM settings WHERE key = 'data_normalization_v1'"
        ).fetchone():
            # One-time normalization: Arabic book types and recognizable material units only.
            db.execute(
                "UPDATE books SET type = 'Original' WHERE LOWER(TRIM(type)) IN ('أصلي', 'أصلية')"
            )
            db.execute(
                "UPDATE books SET type = 'High Copy' WHERE LOWER(TRIM(type)) IN ('نسخة عالية', 'نسخة', 'هاي كوبي')"
            )
            for row in db.execute("SELECT id, unit FROM materials").fetchall():
                normalized_unit = normalize_material_unit(row["unit"])
                if normalized_unit:
                    db.execute("UPDATE materials SET unit = ? WHERE id = ?", (normalized_unit, row["id"]))
            db.execute(
                "INSERT INTO settings(key, value) VALUES ('data_normalization_v1', 'complete')"
            )
        if not db.execute(
            "SELECT 1 FROM settings WHERE key = 'drink_categories_v2'"
        ).fetchone():
            db.execute("UPDATE drinks SET category = 'iced' WHERE LOWER(TRIM(category)) = 'cold'")
            db.execute(
                "INSERT INTO settings(key, value) VALUES ('drink_categories_v2', 'complete')"
            )

        seed_categories(db)
        migrate_retail_books(db)
        seed_catalog(db)
        db.execute(
            "INSERT OR IGNORE INTO users(username, password_hash, role) VALUES (?, ?, ?)",
            ("admin", generate_password_hash("123456"), "admin"),
        )
        db.execute(
            "INSERT OR IGNORE INTO settings(key, value) VALUES ('secret_key', ?)",
            (secrets.token_hex(32),),
        )
        db.execute(
            "INSERT OR IGNORE INTO settings(key, value) VALUES ('shop_name', ?)",
            (DEFAULT_SHOP_NAME,),
        )
        db.execute("INSERT OR IGNORE INTO settings(key, value) VALUES ('shop_address', '')")
        db.execute("INSERT OR IGNORE INTO settings(key, value) VALUES ('shift_hours', '8')")
        for key, value in RECEIPT_SETTING_DEFAULTS.items():
            db.execute("INSERT OR IGNORE INTO settings(key, value) VALUES (?, ?)", (key, value))
        app.config["SECRET_KEY"] = db.execute(
            "SELECT value FROM settings WHERE key = 'secret_key'"
        ).fetchone()["value"]
        db.commit()


def api_error(message, status=400):
    return jsonify({"error": message}), status


@app.errorhandler(413)
def request_too_large(_error):
    return api_error("حجم الملف يتجاوز الحد المسموح للاستيراد.")


def normalize_material_unit(value):
    text = unicodedata.normalize("NFKC", str(value or "")).strip().casefold()
    text = "".join(character for character in text if not unicodedata.combining(character))
    aliases = {
        "g": "g", "جم": "g", "جرام": "g", "غرام": "g", "gram": "g", "grams": "g",
        "gramme": "g", "grammes": "g",
        "kg": "kg", "كيلو": "kg", "كجم": "kg", "كغ": "kg",
        "kilogram": "kg", "kilograms": "kg",
        "ml": "ml", "مل": "ml", "ملي": "ml", "مليلتر": "ml", "ملل": "ml",
        "milliliter": "ml", "milliliters": "ml", "millilitre": "ml", "millilitres": "ml",
        "l": "L", "لتر": "L", "ل": "L", "liter": "L", "litre": "L",
        "liters": "L", "litres": "L",
        "pcs": "pcs", "pc": "pcs", "piece": "pcs", "pieces": "pcs",
        "قطعة": "pcs", "حبة": "pcs",
    }
    return aliases.get(text)


def material_unit_conversion_factor(from_unit, to_unit):
    """Multiplier converting a quantity from one canonical unit to another.

    Returns None when either unit is unknown or the units belong to different
    dimensions (e.g. kg -> pcs), meaning no safe automatic conversion exists.
    """
    from_scale = MATERIAL_UNIT_SCALES.get(from_unit)
    to_scale = MATERIAL_UNIT_SCALES.get(to_unit)
    if from_scale is None or to_scale is None:
        return None
    if from_scale[0] != to_scale[0]:
        return None
    return from_scale[1] / to_scale[1]


def material_recipe_usage(db, material_id):
    """True when the material appears in any drink's recipe_json."""
    for row in db.execute("SELECT recipe_json FROM drinks").fetchall():
        try:
            recipe = json.loads(row["recipe_json"] or "[]")
        except (TypeError, ValueError):
            continue
        if isinstance(recipe, list) and any(
            isinstance(item, dict) and str(item.get("material_id")) == str(material_id)
            for item in recipe
        ):
            return True
    return False


def material_unit_label(value):
    return MATERIAL_UNITS.get(value, value or "")


def normalize_optional_material_unit(value, fallback):
    normalized = normalize_material_unit(value)
    return normalized or normalize_material_unit(fallback) or fallback


def convert_material_quantity(db, material_id, quantity, from_unit, to_unit):
    factor = material_unit_conversion_factor(from_unit, to_unit)
    if factor is None:
        return quantity
    return round(float(quantity) * factor, 6)


def normalize_book_type(value):
    normalized = str(value or "").strip().casefold()
    if normalized == "original":
        return "Original"
    if normalized == "high copy":
        return "High Copy"
    raise ValueError("نوع الكتاب يجب أن يكون Original أو High Copy.")


def current_shop_name():
    row = get_db().execute("SELECT value FROM settings WHERE key = 'shop_name'").fetchone()
    return (row["value"].strip() if row and row["value"] else "") or DEFAULT_SHOP_NAME


def shop_name_direction(name):
    return "rtl" if any("\u0600" <= character <= "\u06ff" for character in name) else "ltr"


def shop_template_context():
    name = current_shop_name()
    return {
        "shop_name": name,
        "shop_name_dir": shop_name_direction(name),
        "logo_available": resource_path("static/img/logo.png").is_file(),
    }


EMPLOYEE_PERMISSION_FIELDS = (
    "can_manage_inventory",
    "can_manage_expenses",
    "can_manage_purchases",
    "can_sell",
)


def session_employee():
    """Return the active, logged-in employee row, or None when absent/inactive."""
    employee_id = session.get("employee_id")
    if not employee_id:
        return None
    employee = get_db().execute(
        "SELECT * FROM employees WHERE id = ? AND is_active = 1", (employee_id,)
    ).fetchone()
    if employee is None:
        session.clear()
    return employee


def admin_required(function):
    @wraps(function)
    def wrapped(*args, **kwargs):
        if not session.get("admin_id"):
            return api_error("يرجى تسجيل الدخول للمتابعة.", 401)
        return function(*args, **kwargs)

    return wrapped


def dashboard_access_required(function):
    """Allow admins and any active employee that holds at least one permission.

    Employees keep read access only to the dashboard sections matching their
    granted permissions; the concrete per-view gating happens in the page route.
    """
    @wraps(function)
    def wrapped(*args, **kwargs):
        if session.get("admin_id"):
            return function(*args, **kwargs)
        employee = session_employee()
        if employee is None:
            return redirect(url_for("admin_login_page"))
        if not any(employee[field] for field in EMPLOYEE_PERMISSION_FIELDS):
            return redirect(url_for("cashier_page"))
        return function(*args, **kwargs)

    return wrapped


def cashier_session_required(function):
    @wraps(function)
    def wrapped(*args, **kwargs):
        if not session.get("cashier_session") and not session.get("admin_id") and not session.get("employee_id"):
            return api_error("افتح شاشة الكاشير أولاً.", 401)
        return function(*args, **kwargs)

    return wrapped


def selling_required(function):
    """Selling (and return/void) requires an admin session or an active employee with can_sell."""
    @wraps(function)
    def wrapped(*args, **kwargs):
        if session.get("admin_id"):
            return function(*args, **kwargs)
        employee_id = session.get("employee_id")
        if not employee_id:
            return api_error("يرجى تسجيل دخول الكاشير للمتابعة.", 401)
        employee = get_db().execute(
            "SELECT * FROM employees WHERE id = ? AND is_active = 1", (employee_id,)
        ).fetchone()
        if employee is None:
            session.clear()
            return api_error("حساب الموظف غير نشط.", 403)
        if not employee["can_sell"]:
            return api_error("لا تملك صلاحية إتمام عمليات البيع.", 403)
        return function(*args, **kwargs)

    return wrapped


def employee_or_admin_required(permission=None):
    def decorate(function):
        @wraps(function)
        def wrapped(*args, **kwargs):
            if session.get("admin_id"):
                return function(*args, **kwargs)
            employee_id = session.get("employee_id")
            if not employee_id:
                return api_error("يرجى تسجيل الدخول للمتابعة.", 401)
            employee = get_db().execute(
                "SELECT * FROM employees WHERE id = ? AND is_active = 1", (employee_id,)
            ).fetchone()
            if employee is None:
                session.clear()
                return api_error("حساب الموظف غير نشط.", 403)
            if permission and not employee[permission]:
                return api_error("لا تملك صلاحية تنفيذ هذا الإجراء.", 403)
            return function(*args, **kwargs)

        return wrapped
    return decorate


def inventory_or_expense_manager_required(function):
    @wraps(function)
    def wrapped(*args, **kwargs):
        if session.get("admin_id"):
            return function(*args, **kwargs)
        employee_id = session.get("employee_id")
        if not employee_id:
            return api_error("يرجى تسجيل الدخول للمتابعة.", 401)
        employee = get_db().execute(
            "SELECT * FROM employees WHERE id = ? AND is_active = 1", (employee_id,)
        ).fetchone()
        if employee is None:
            session.clear()
            return api_error("حساب الموظف غير نشط.", 403)
        permission = "can_manage_expenses" if kwargs.get("resource") == "expenses" else "can_manage_inventory"
        if not employee[permission]:
            return api_error("لا تملك صلاحية إدارة هذا القسم.", 403)
        return function(*args, **kwargs)

    return wrapped


def open_shift_context(db):
    """Return the single open shift row, or None when no shift is open."""
    return db.execute(
        "SELECT * FROM shifts WHERE status = 'open' ORDER BY id DESC LIMIT 1"
    ).fetchone()


def active_employee_count(db):
    return db.execute(
        "SELECT COUNT(*) AS total FROM employees WHERE is_active = 1"
    ).fetchone()["total"]


def open_shift_required(function):
    """Require a personal open shift for employees; admins may operate anytime."""
    @wraps(function)
    def wrapped(*args, **kwargs):
        if session.get("admin_id"):
            return function(*args, **kwargs)
        employee_id = session.get("employee_id")
        if employee_id:
            if active_employee_shift(get_db(), employee_id) is None:
                return api_error(
                    "لا يمكن تنفيذ هذه العملية بدون وردية مفتوحة لهذا الموظف.",
                    409,
                )
            return function(*args, **kwargs)
        db = get_db()
        if open_shift_context(db) is None and active_employee_count(db) > 0:
            return api_error(
                "لا يمكن تنفيذ أي عملية بدون موظف فاتح وردية. "
                "على موظف تسجيل الحضور وفتح الوردية أولاً.",
                409,
            )
        return function(*args, **kwargs)

    return wrapped


def ensure_business_day(db, day=None):
    day = day or date.today()
    day_text = day.isoformat() if isinstance(day, date) else str(day)
    row = db.execute(
        "SELECT * FROM business_days WHERE project_date = ?", (day_text,)
    ).fetchone()
    if row:
        return row
    previous = db.execute(
        "SELECT * FROM business_days WHERE project_date < ? ORDER BY project_date DESC LIMIT 1",
        (day_text,),
    ).fetchone()
    opening_cash = 0.0
    if previous:
        keys = previous.keys()
        if previous["status"] == "closed" and "counted_cash" in keys and previous["counted_cash"] is not None:
            # A sealed day hands over the cash that was actually counted, so
            # closing with zero really does start the new day from zero.
            opening_cash = round(float(previous["counted_cash"]), 2)
        else:
            opening_cash = business_day_cash(db, previous["id"])
    cursor = db.execute(
        "INSERT INTO business_days(project_date, opening_cash, status, created_at) VALUES (?, ?, 'open', ?)",
        (day_text, opening_cash, datetime.now().astimezone().isoformat(timespec="seconds")),
    )
    db.commit()
    return db.execute("SELECT * FROM business_days WHERE id = ?", (cursor.lastrowid,)).fetchone()


def business_day_cash(db, business_day_id):
    day = db.execute(
        "SELECT opening_cash FROM business_days WHERE id = ?", (business_day_id,)
    ).fetchone()
    if day is None:
        return 0.0
    entries = db.execute(
        "SELECT COALESCE(SUM(amount), 0) AS balance FROM cash_entries WHERE business_day_id = ?",
        (business_day_id,),
    ).fetchone()["balance"]
    return round(day["opening_cash"] + entries, 2)


def add_cash_entry(db, business_day_id, entry_type, amount, category="", reference_type="", reference_id=None, description="", shift_id=None, employee_id=None):
    db.execute(
        """INSERT INTO cash_entries
           (business_day_id, shift_id, employee_id, entry_type, amount, category,
            reference_type, reference_id, description, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (
            business_day_id, shift_id, employee_id, entry_type, round(amount, 2),
            category, reference_type, reference_id, description,
            datetime.now().astimezone().isoformat(timespec="seconds"),
        ),
    )


def active_employee_shift(db, employee_id):
    return db.execute(
        "SELECT * FROM shifts WHERE employee_id = ? AND status = 'open' ORDER BY id DESC LIMIT 1",
        (employee_id,),
    ).fetchone()


def request_employee_shift(db):
    employee_id = session.get("employee_id")
    return active_employee_shift(db, employee_id) if employee_id else None


def configured_shift_seconds(db):
    row = db.execute("SELECT value FROM settings WHERE key = 'shift_hours'").fetchone()
    return int(float(row["value"] if row else 8) * 3600)


def close_employee_shift(db, shift, counted_cash=None, reason="manual", handover_to=None):
    ended_at = datetime.now().astimezone()
    started_at = datetime.fromisoformat(shift["started_at"])
    worked_seconds = max(0, int((ended_at - started_at).total_seconds()))
    employee = db.execute(
        "SELECT monthly_salary FROM employees WHERE id = ?", (shift["employee_id"],)
    ).fetchone()
    scheduled_seconds = configured_shift_seconds(db)
    daily_rate = employee["monthly_salary"] / 30
    payable = round(daily_rate * worked_seconds / scheduled_seconds, 2)
    remaining_shifts = db.execute(
        "SELECT COUNT(*) AS total FROM shifts "
        "WHERE business_day_id = ? AND status = 'open' AND id != ?",
        (shift["business_day_id"], shift["id"]),
    ).fetchone()["total"]
    expected_cash = None
    counted = None
    cash_variance = None
    if not remaining_shifts:
        expected_cash = round(float(business_day_cash(db, shift["business_day_id"])), 2)
        counted = expected_cash if counted_cash is None else round(float(counted_cash), 2)
        cash_variance = round(counted - expected_cash, 2)
    db.execute(
        """UPDATE shifts SET ended_at = ?, status = 'closed', expected_cash = ?,
           counted_cash = ?, cash_variance = ?, worked_seconds = ?, payable_amount = ?,
           closure_reason = ?, handover_to = ? WHERE id = ? AND status = 'open'""",
        (
            ended_at.isoformat(timespec="seconds"), expected_cash, counted,
            cash_variance, worked_seconds, payable, reason, handover_to, shift["id"],
        ),
    )
    db.commit()
    return {
        "shift_id": shift["id"],
        "worked_seconds": worked_seconds,
        "payable_amount": payable,
        "expected_cash": expected_cash,
        "counted_cash": counted,
        "cash_variance": cash_variance,
        "cash_reconciliation_required": not bool(remaining_shifts),
    }


def ensure_employee_shift(db, employee_id, business_day_id=None, opening_cash=None):
    if business_day_id is None:
        business_day_id = ensure_business_day(db, date.today())["id"]
    existing = active_employee_shift(db, employee_id)
    if existing and existing["status"] == "open":
        return existing

    employee = db.execute(
        "SELECT can_join_existing_shift FROM employees WHERE id = ?", (employee_id,)
    ).fetchone()
    allow_concurrent = bool(employee and employee["can_join_existing_shift"])
    open_shifts = db.execute(
        "SELECT * FROM shifts WHERE status = 'open' ORDER BY id"
    ).fetchall()
    if not allow_concurrent:
        for open_shift in open_shifts:
            if open_shift["employee_id"] == employee_id:
                continue
            close_employee_shift(
                db,
                open_shift,
                round(float(business_day_cash(db, open_shift["business_day_id"])), 2),
                "handover",
                handover_to=employee_id,
            )

    now = datetime.now().astimezone()
    drawer_balance = (
        0.0 if allow_concurrent and open_shifts else
        float(business_day_cash(db, business_day_id))
        if opening_cash is None else round(float(opening_cash), 2)
    )
    cursor = db.execute(
        """INSERT INTO shifts
           (employee_id, business_day_id, started_at, ended_at, status, opening_cash, expected_cash, counted_cash, cash_variance, worked_seconds, payable_amount, closure_reason, handover_to)
           VALUES (?, ?, ?, NULL, 'open', ?, NULL, NULL, NULL, 0, 0, '', NULL)""",
        (
            employee_id,
            business_day_id,
            now.isoformat(timespec="seconds"),
            drawer_balance,
        ),
    )
    db.commit()
    return db.execute("SELECT * FROM shifts WHERE id = ?", (cursor.lastrowid,)).fetchone()


def employee_public_payload(employee):
    if employee is None:
        return None
    payload = dict(employee)
    payload.pop("password_hash", None)
    return payload


def open_shift_presence(db):
    rows = db.execute(
        """SELECT s.id AS shift_id, s.employee_id, s.business_day_id, s.started_at,
                  e.username, e.can_sell, e.can_manage_inventory, e.can_manage_expenses,
                  e.can_manage_purchases, e.can_join_existing_shift
           FROM shifts s JOIN employees e ON e.id = s.employee_id
           WHERE s.status = 'open' AND e.is_active = 1
           ORDER BY s.started_at, s.id"""
    ).fetchall()
    presence = []
    for row in rows:
        item = dict(row)
        remaining = db.execute(
            "SELECT COUNT(*) AS total FROM shifts "
            "WHERE business_day_id = ? AND status = 'open' AND id != ?",
            (item["business_day_id"], item["shift_id"]),
        ).fetchone()["total"]
        item["cash_reconciliation_required"] = remaining == 0
        presence.append(item)
    return presence


def employee_actor(db, employee_id):
    if employee_id:
        employee = db.execute(
            "SELECT id, username FROM employees WHERE id = ? AND is_active = 1",
            (employee_id,),
        ).fetchone()
        if employee:
            return employee["id"], employee["username"], "employee"
    if session.get("admin_id"):
        return session["admin_id"], "admin", "admin"
    return None, "", ""


def log_audit(db, action, entity="", entity_id=None, details="", actor_id=None, actor_name="", actor_role=""):
    db.execute(
        """INSERT INTO audit_logs
           (created_at, actor_id, actor_name, actor_role, action, entity, entity_id, details)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
        (
            datetime.now().astimezone().isoformat(timespec="seconds"),
            actor_id, actor_name, actor_role, action, entity, entity_id, details,
        ),
    )



def resource_values(resource,payload):
    def optional_number(key, label, default=0):
        value = payload.get(key)
        if value is None or (isinstance(value, str) and not value.strip()):
            value = default
        return positive_number(value, label, True)

    if resource=="books":
        return (str(payload.get("title") or "كتاب بدون عنوان").strip(),str(payload.get("author") or "").strip(),str(payload.get("publisher") or "").strip(),normalize_book_type(payload.get("type") or "Original"),optional_number("cost_price","سعر التكلفة"),optional_number("sell_price","سعر البيع"),int(optional_number("stock_quantity","المخزون")))
    if resource=="drinks":
        recipe=payload.get("recipe",payload.get("recipe_json","[]"))
        if isinstance(recipe,list): recipe=json.dumps(recipe,ensure_ascii=False)
        return (str(payload.get("name") or "مشروب بدون اسم").strip(),optional_number("sell_price","سعر البيع"),str(recipe or "[]"),str(payload.get("category") or "hot"))
    if resource=="materials":
        base_unit = normalize_material_unit(payload.get("unit")) or "pcs"
        purchase_unit = normalize_optional_material_unit(payload.get("purchase_unit"), base_unit)
        usage_unit = normalize_optional_material_unit(payload.get("usage_unit"), base_unit)
        return (
            str(payload.get("name") or "مادة بدون اسم").strip(),
            base_unit,
            optional_number("cost_per_unit","سعر التكلفة"),
            optional_number("current_stock","المخزون"),
            optional_number("reorder_level","حد الطلب",5),
        )
    if resource=="retail":
        return (str(payload.get("name") or "منتج بدون اسم").strip(),str(payload.get("category") or "extra").strip(),optional_number("cost_price","سعر التكلفة"),optional_number("sell_price","سعر البيع"),float(optional_number("stock_quantity","المخزون")),str(payload.get("unit") or "قطعة").strip())
    if resource=="expenses":
        return (str(payload.get("date") or date.today().isoformat()).strip(),str(payload.get("category") or "").strip(),positive_number(payload.get("amount",0),"المبلغ",True),str(payload.get("note") or "").strip())
    raise ValueError("المورد غير معروف.")

def record_expense_shift_link(db,expense_id,*values):
    shift=request_employee_shift(db); eid=shift["employee_id"] if shift else None; sid=shift["id"] if shift else None
    day=ensure_business_day(db)
    db.execute("UPDATE expenses SET business_day_id=?,shift_id=?,employee_id=? WHERE id=?",(day["id"],sid,eid,expense_id))
    amount=float(values[2])
    add_cash_entry(db, day["id"], "expense", -amount, str(values[1] or ""), "expense", expense_id,
                   str(values[3] or ""), shift_id=sid, employee_id=eid)

def sync_expense_intake(db,expense_id,*values,stock_item=None):
    if not isinstance(stock_item,dict): return None
    kind=str(stock_item.get("kind") or "").strip(); pid=int(stock_item.get("id") or 0); qty=float(stock_item.get("quantity") or 0)
    if qty<=0: return None
    cost=float(stock_item.get("unit_cost") or stock_item.get("cost") or 0)
    name=str(stock_item.get("name") or "").strip()
    created = False
    if pid <= 0 and name:
        if kind=="book":
            cursor=db.execute("INSERT INTO books(title,author,publisher,type,cost_price,sell_price,stock_quantity) VALUES(?,?,?,?,?,?,?)",(name,"","",str(stock_item.get("type") or "Original"),cost,cost,qty)); pid=cursor.lastrowid; created=True
        elif kind=="retail":
            category=str(stock_item.get("category") or "extra")
            cursor=db.execute("INSERT INTO retail(name,category,cost_price,sell_price,stock_quantity,unit) VALUES(?,?,?,?,?,?)",(name,category,cost,cost,qty,str(stock_item.get("unit") or "قطعة"))); pid=cursor.lastrowid; created=True
        elif kind=="material":
            unit=normalize_material_unit(stock_item.get("unit")) or "pcs"
            cursor=db.execute("INSERT INTO materials(name,unit,cost_per_unit,current_stock,reorder_level,purchase_unit,usage_unit) VALUES(?,?,?,?,?,?,?)",(name,unit,cost,qty,positive_number(stock_item.get("reorder_level",5),"حد التنبيه",True),normalize_optional_material_unit(stock_item.get("purchase_unit"),unit),normalize_optional_material_unit(stock_item.get("usage_unit"),unit))); pid=cursor.lastrowid; created=True
        elif kind=="drink":
            category=str(stock_item.get("category") or "hot")
            cursor=db.execute("INSERT INTO drinks(name,sell_price,recipe_json,category) VALUES(?,?,?,?)",(name,cost,"[]",category)); pid=cursor.lastrowid; created=True
    if kind=="book" and not created: db.execute("UPDATE books SET stock_quantity=stock_quantity+? WHERE id=?",(qty,pid))
    elif kind=="retail" and not created: db.execute("UPDATE retail SET stock_quantity=stock_quantity+? WHERE id=?",(qty,pid))
    elif kind=="material" and not created:
        material=db.execute("SELECT unit,purchase_unit FROM materials WHERE id=?",(pid,)).fetchone()
        if material:
            purchase_unit=material["purchase_unit"] or material["unit"]
            quantity=convert_material_quantity(db,pid,qty,purchase_unit,material["unit"])
            db.execute("UPDATE materials SET current_stock=current_stock+?,cost_per_unit=? WHERE id=?",(quantity,cost,pid))
    elif kind=="drink" and not created:
        db.execute("UPDATE drinks SET sell_price=? WHERE id=?",(cost,pid))
    db.commit()
    return {"kind":kind,"id":pid,"name":name,"quantity":qty}

def apply_intake_lines(db,lines,direction):
    for line in lines:
        kind=line.get("kind"); pid=int(line.get("id") or 0); qty=float(line.get("quantity") or 0)*direction
        if kind=="book": db.execute("UPDATE books SET stock_quantity=MAX(0,stock_quantity+(?)) WHERE id=?",(qty,pid))
        elif kind=="retail": db.execute("UPDATE retail SET stock_quantity=MAX(0,stock_quantity+(?)) WHERE id=?",(qty,pid))
        elif kind=="material": db.execute("UPDATE materials SET current_stock=MAX(0,current_stock+(?)) WHERE id=?",(qty,pid))

def current_actor_identity(db):
    if session.get("admin_id"):
        row=db.execute("SELECT username FROM users WHERE id=?",(session["admin_id"],)).fetchone()
        return session["admin_id"],row["username"] if row else "admin","admin"
    eid=session.get("employee_id")
    if eid:
        row=db.execute("SELECT username FROM employees WHERE id=?",(eid,)).fetchone()
        return eid,row["username"] if row else "","employee"
    return None,"",""

def positive_number(value, label, allow_zero=True):
    if isinstance(value, str):
        digit_translation = str.maketrans("٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹", "01234567890123456789")
        value = value.translate(digit_translation).replace("٫", ".").replace("٬", "").strip()
        if "," in value:
            value = value.replace(",", "." if "." not in value else "")
    try:
        number = float(value)
    except (TypeError, ValueError):
        raise ValueError(label + " يجب أن يكون رقمًا.")
    if not math.isfinite(number) or number < 0 or (not allow_zero and number == 0):
        raise ValueError(label + (" يجب أن يكون صفرًا أو أكثر." if allow_zero else " يجب أن يكون أكبر من صفر."))
    return number


def receipt_settings(db):
    rows = db.execute(
        "SELECT key, value FROM settings WHERE key LIKE 'receipt_%'"
    ).fetchall()
    values = dict(rows)
    result = dict(RECEIPT_SETTING_DEFAULTS)
    for key, default in RECEIPT_SETTING_DEFAULTS.items():
        result[key] = values.get(key, default)
    return result


def product_recipe_cost(db, recipe):
    if not isinstance(recipe, list):
        raise ValueError("يجب أن تكون الوصفة قائمة مكونات صالحة.")
    cost = 0.0
    for ingredient in recipe:
        if not isinstance(ingredient, dict) or "material_id" not in ingredient or "qty" not in ingredient:
            raise ValueError("يجب تحديد المادة والكمية لكل مكوّن.")
        try:
            material_id = int(ingredient["material_id"])
        except (TypeError, ValueError):
            raise ValueError("معرّف المادة في الوصفة غير صالح.")
        quantity = positive_number(ingredient["qty"], "كمية المكوّن", False)
        material = db.execute(
            "SELECT cost_per_unit FROM materials WHERE id = ?", (material_id,)
        ).fetchone()
        if material is None:
            raise ValueError("تشير الوصفة إلى مادة غير موجودة.")
        cost += material["cost_per_unit"] * quantity
    return cost


# --- Routes ---

@app.get("/")
def cashier_page():
    # Opening the cashier screen ends any admin session, so the next admin visit
    # always requires a fresh login (Batch 2c session hardening). The employee
    # session -- and therefore the open shift -- is deliberately preserved so the
    # cashier stays logged in and their shift is not forgotten.
    if session.get("admin_id"):
        session.pop("admin_id", None)
    session["cashier_session"] = True
    return render_template("cashier.html", **shop_template_context())

@app.get("/admin/login")
def admin_login_page():
    if session.get("admin_id"):
        return redirect(url_for("admin_dashboard_page"))
    return render_template("admin_login.html", **shop_template_context())

@app.post("/admin/login")
def admin_login():
    username = request.form.get("username", "").strip()
    password = request.form.get("password", "")
    user = get_db().execute(
        "SELECT id, password_hash FROM users WHERE username = ? AND role = 'admin'",
        (username,),
    ).fetchone()
    if user is None or not check_password_hash(user["password_hash"], password):
        return render_template(
            "admin_login.html",
            error="اسم المستخدم أو كلمة المرور غير صحيحة.",
            **shop_template_context(),
        ), 401
    session["admin_id"] = user["id"]
    session["cashier_session"] = True
    return redirect(url_for("admin_dashboard_page"))

@app.post("/admin/logout")
def admin_logout():
    # Leaving the admin panel only drops the admin identity. An employee session
    # (and the shift it owns) is kept so returning to the cashier does not look
    # like the employee was logged out.
    session.pop("admin_id", None)
    if not session.get("employee_id"):
        session.clear()
    session["cashier_session"] = True
    return redirect(url_for("cashier_page"))

@app.get("/admin")
@dashboard_access_required
def admin_dashboard_page():
    is_admin = bool(session.get("admin_id"))
    if is_admin:
        permissions = {"inventory": True, "expenses": True, "purchases": True, "sell": True}
    else:
        employee = session_employee()
        if employee is None:
            return redirect(url_for("admin_login_page"))
        permissions = {
            "inventory": bool(employee["can_manage_inventory"]),
            "expenses": bool(employee["can_manage_expenses"]),
            "purchases": bool(employee["can_manage_purchases"]),
            "sell": bool(employee["can_sell"]),
        }
    allowed = set()
    if permissions["inventory"]:
        allowed.update({"books", "drinks", "materials", "retail", "categories"})
    if permissions["expenses"]:
        allowed.add("expenses")
    if is_admin:
        allowed.update({"dashboard", "employees", "projects", "attendance", "payroll", "settings", "purge"})
    requested = str(request.args.get("view") or "").strip()
    if requested in allowed:
        initial_view = requested
    elif is_admin:
        initial_view = "dashboard"
    elif permissions["inventory"]:
        initial_view = "books"
    elif permissions["expenses"]:
        initial_view = "expenses"
    else:
        initial_view = "books"
    return render_template(
        "admin_dashboard.html",
        is_admin=is_admin,
        permissions=permissions,
        initial_view=initial_view,
        **shop_template_context(),
    )


@app.post("/api/employee/login")
def employee_login():
    data = request.get_json(silent=True) or {}
    username = str(data.get("username", "")).strip()
    password = str(data.get("password", ""))

    if not username or not password:
        return api_error("اسم المستخدم وكلمة المرور مطلوبان.")

    db = get_db()
    employee = db.execute(
        "SELECT * FROM employees WHERE username = ? AND is_active = 1",
        (username,),
    ).fetchone()
    if employee is None or not check_password_hash(employee["password_hash"], password):
        return api_error("اسم المستخدم أو كلمة المرور غير صحيحة.", 401)

    counted_cash = None
    if data.get("counted_cash") is not None and str(data.get("counted_cash")).strip() != "":
        try:
            counted_cash = float(data["counted_cash"])
        except (TypeError, ValueError):
            return api_error("رصيد الدرج المعدود يجب أن يكون رقمًا.")
        if not math.isfinite(counted_cash) or counted_cash < 0:
            return api_error("رصيد الدرج المعدود يجب أن يكون صفرًا أو أكثر.")

    # Opening a shift is the moment the system checks the calendar: on the 1st
    # the finished months are sealed automatically before anyone records more.
    auto_closed_months = auto_close_finished_months(db)

    business_day = ensure_business_day(db)
    if business_day["status"] == "closed":
        return api_error(
            "تم تقفيل يوم " + format_iso_datetime(business_day["project_date"])
            + "؛ لا يمكن فتح وردية أخرى فيه. انتظر يومًا جديدًا أو اطلب من المدير إعادة فتحه.",
            409,
        )
    outgoing_shifts = db.execute(
        """SELECT s.*, e.username AS employee_username
           FROM shifts s JOIN employees e ON e.id = s.employee_id
           WHERE s.status = 'open' AND s.employee_id != ?
           ORDER BY s.id DESC""",
        (employee["id"],),
    ).fetchall()
    allow_concurrent = bool(employee["can_join_existing_shift"])
    outgoing = outgoing_shifts[0] if outgoing_shifts else None

    if outgoing is not None and not allow_concurrent and counted_cash is None:
        outgoing_expected = round(float(business_day_cash(db, outgoing["business_day_id"])), 2)
        started_at = datetime.fromisoformat(outgoing["started_at"])
        handover_hours = round(
            max(0.0, (datetime.now().astimezone() - started_at).total_seconds()) / 3600, 2
        )
        return jsonify({
            "success": False,
            "handover_required": True,
            "outgoing_employee": "، ".join(
                shift["employee_username"] for shift in outgoing_shifts
            ),
            "expected_cash": outgoing_expected,
            "shift_hours": handover_hours,
            "message": "الوردية الحالية مفتوحة باسم " +
                       "، ".join(shift["employee_username"] for shift in outgoing_shifts) +
                       ". أدخل رصيد الدرج المعدود لتأكيد الاستلام.",
        })

    if outgoing is not None and not allow_concurrent:
        for outgoing_shift in outgoing_shifts[:-1]:
            close_employee_shift(
                db, outgoing_shift, reason="handover", handover_to=employee["id"]
            )
        close_employee_shift(
            db, outgoing_shifts[-1], counted_cash, "handover", handover_to=employee["id"]
        )

    session.clear()
    session["employee_id"] = employee["id"]
    session["cashier_session"] = True
    shift = ensure_employee_shift(
        db,
        employee["id"],
        business_day["id"],
        opening_cash=counted_cash,
    )
    return jsonify({
        "success": True,
        "employee": employee_public_payload(employee),
        "business_day": dict(business_day),
        "shift": dict(shift),
        "parallel_presence": bool(outgoing and allow_concurrent),
        "shift_hours": configured_shift_seconds(db) / 3600,
        "auto_closed_months": [
            {"key": entry["key"], "closed_at": entry["closed_at"],
             "expected_cash": entry["expected_cash"], "counted_cash": entry["counted_cash"]}
            for entry in auto_closed_months
        ],
    })


@app.post("/api/employee/logout")
def employee_logout():
    session.clear()
    session["cashier_session"] = True
    return jsonify({"ok": True})


@app.get("/api/employee/current")
def employee_current_state():
    db = get_db()
    open_shifts = open_shift_presence(db)
    employee_id = session.get("employee_id")
    if not employee_id:
        return jsonify({"authenticated": False, "open_shifts": open_shifts})

    employee = db.execute("SELECT * FROM employees WHERE id = ? AND is_active = 1", (employee_id,)).fetchone()
    if employee is None:
        session.clear()
        return api_error("حساب الموظف غير موجود أو غير نشط.", 403)

    shift = active_employee_shift(db, employee_id)
    if shift is None:
        session.pop("employee_id", None)
        session["cashier_session"] = True
        return jsonify({"authenticated": False, "open_shifts": open_shifts})
    business_day = None
    business_day = db.execute(
        "SELECT * FROM business_days WHERE id = ?",
        (shift["business_day_id"],),
    ).fetchone()
    return jsonify({
        "authenticated": True,
        "employee": employee_public_payload(employee),
        "shift": dict(shift) if shift else None,
        "open_shifts": open_shifts,
        "other_open_shifts": db.execute(
            "SELECT COUNT(*) AS total FROM shifts WHERE status = 'open' AND id != ?",
            (shift["id"] if shift else -1,),
        ).fetchone()["total"],
        "cash_reconciliation_required": bool(
            shift and db.execute(
                "SELECT COUNT(*) AS total FROM shifts "
                "WHERE business_day_id = ? AND status = 'open'",
                (shift["business_day_id"],),
            ).fetchone()["total"] == 1
        ),
        "business_day": dict(business_day) if business_day else None,
        "cash_drawer": round(float(business_day_cash(db, business_day["id"])) if business_day else 0.0, 2),
        "shift_hours": configured_shift_seconds(db) / 3600,
        # The cashier decides whether to fire the printer straight away.
        "receipt_auto_print": receipt_settings(db)["receipt_auto_print"] == "1",
    })


@app.post("/api/employee/shift/close")
def close_employee_shift_route():
    employee_id = session.get("employee_id")
    if not employee_id:
        return api_error("لم يتم تسجيل دخول موظف في الجلسة الحالية.", 401)

    data = request.get_json(silent=True)
    if data is not None and not isinstance(data, dict):
        return api_error("بيانات إنهاء الوردية غير صالحة.")
    data = data or {}

    db = get_db()
    shift = active_employee_shift(db, employee_id)
    if shift is None:
        return api_error("لا توجد وردية مفتوحة لهذا الموظف.", 404)

    other_shifts = db.execute(
        "SELECT COUNT(*) AS total FROM shifts "
        "WHERE business_day_id = ? AND status = 'open' AND id != ?",
        (shift["business_day_id"], shift["id"]),
    ).fetchone()["total"]
    raw_counted = data.get("counted_cash")
    counted_cash = None
    if not other_shifts:
        if raw_counted is None or str(raw_counted).strip() == "":
            return api_error("رصيد الدرج المعدود مطلوب لإنهاء آخر وردية مفتوحة.")
        try:
            counted_cash = float(raw_counted)
        except (TypeError, ValueError):
            return api_error("رصيد الدرج المعدود يجب أن يكون رقمًا.")
        if not math.isfinite(counted_cash) or counted_cash < 0:
            return api_error("رصيد الدرج المعدود يجب أن يكون صفرًا أو أكثر.")
    reason = str(data.get("reason", "manual")).strip() or "manual"

    result = close_employee_shift(db, shift, counted_cash=counted_cash, reason=reason)
    return jsonify(result)


@app.post("/api/employee/shift/<int:shift_id>/close")
def close_selected_employee_shift(shift_id):
    db = get_db()
    shift = db.execute(
        """SELECT s.*, e.username, e.password_hash FROM shifts s
           JOIN employees e ON e.id = s.employee_id
           WHERE s.id = ? AND s.status = 'open' AND e.is_active = 1""",
        (shift_id,),
    ).fetchone()
    if shift is None:
        return api_error("الوردية غير موجودة أو تم إنهاؤها بالفعل.", 404)

    if session.get("employee_id") != shift["employee_id"]:
        data = request.get_json(silent=True) or {}
        password = str(data.get("password") or "")
        if not password or not check_password_hash(shift["password_hash"], password):
            return api_error(
                "أدخل كلمة مرور الموظف صاحب الوردية لتأكيد إنهائها.", 401
            )
    else:
        data = request.get_json(silent=True) or {}

    other_shifts = db.execute(
        "SELECT COUNT(*) AS total FROM shifts "
        "WHERE business_day_id = ? AND status = 'open' AND id != ?",
        (shift["business_day_id"], shift_id),
    ).fetchone()["total"]
    counted_cash = None
    if not other_shifts:
        raw_counted = data.get("counted_cash")
        if raw_counted is None or str(raw_counted).strip() == "":
            return api_error(
                "أدخل رصيد الدرج المعدود لإنهاء آخر وردية مفتوحة.", 400
            )
        try:
            counted_cash = positive_number(raw_counted, "رصيد الدرج المعدود", True)
        except ValueError as error:
            return api_error(str(error), 400)

    result = close_employee_shift(
        db, shift, counted_cash=counted_cash, reason="employee_close"
    )
    result["employee"] = shift["username"]
    if session.get("employee_id") == shift["employee_id"]:
        session.pop("employee_id", None)
        session["cashier_session"] = True
    return jsonify(result)


@app.post("/api/admin/attendance/<int:shift_id>/close")
@admin_required
def admin_close_attendance_shift(shift_id):
    db = get_db()
    shift = db.execute(
        """SELECT s.*, e.username FROM shifts s
           JOIN employees e ON e.id = s.employee_id
           WHERE s.id = ? AND s.status = 'open'""",
        (shift_id,),
    ).fetchone()
    if shift is None:
        return api_error("الوردية غير موجودة أو تم إنهاؤها بالفعل.", 404)

    other_shifts = db.execute(
        "SELECT COUNT(*) AS total FROM shifts "
        "WHERE business_day_id = ? AND status = 'open' AND id != ?",
        (shift["business_day_id"], shift_id),
    ).fetchone()["total"]
    data = request.get_json(silent=True) or {}
    counted_cash = None
    if not other_shifts:
        raw_counted = data.get("counted_cash")
        if raw_counted is None or str(raw_counted).strip() == "":
            return api_error(
                "أدخل رصيد الدرج المعدود لإنهاء آخر وردية مفتوحة.", 400
            )
        try:
            counted_cash = positive_number(raw_counted, "رصيد الدرج المعدود", True)
        except ValueError as error:
            return api_error(str(error), 400)

    result = close_employee_shift(
        db, shift, counted_cash=counted_cash, reason="admin_close"
    )
    result["employee"] = shift["username"]
    return jsonify(result)


def employee_summary_payload(row):
    if row is None:
        return None
    payload = dict(row)
    payload.pop("password_hash", None)
    return payload


@app.get("/api/admin/employees")
@admin_required
def list_admin_employees():
    db = get_db()
    rows = db.execute(
        "SELECT * FROM employees ORDER BY is_active DESC, id ASC"
    ).fetchall()
    return jsonify([employee_summary_payload(row) for row in rows])


@app.post("/api/admin/employees")
@admin_required
@open_shift_required
def create_admin_employee():
    data = request.get_json(silent=True) or {}
    username = str(data.get("username", "")).strip()
    password = str(data.get("password", "")).strip()
    if not username or not password:
        return api_error("اسم المستخدم وكلمة المرور مطلوبان.", 400)
    monthly_salary = positive_number(data.get("monthly_salary", 0), "راتب الموظف", True)
    can_sell = bool(int(data.get("can_sell", 1) or 0))
    can_manage_expenses = bool(int(data.get("can_manage_expenses", 0) or 0))
    can_manage_purchases = bool(int(data.get("can_manage_purchases", 0) or 0))
    can_manage_inventory = bool(int(data.get("can_manage_inventory", 0) or 0))

    db = get_db()
    if db.execute("SELECT 1 FROM employees WHERE username = ?", (username,)).fetchone():
        return api_error("اسم المستخدم موجود بالفعل.", 409)

    can_join_existing_shift = bool(int(data.get("can_join_existing_shift", 0) or 0))
    cursor = db.execute(
        "INSERT INTO employees (username, password_hash, monthly_salary, can_sell, can_manage_expenses, can_manage_purchases, can_manage_inventory, can_join_existing_shift, is_active, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)",
        (
            username,
            generate_password_hash(password),
            monthly_salary,
            int(can_sell),
            int(can_manage_expenses),
            int(can_manage_purchases),
            int(can_manage_inventory),
            int(can_join_existing_shift),
            datetime.now().astimezone().isoformat(timespec="seconds"),
        ),
    )
    db.commit()
    row = db.execute("SELECT * FROM employees WHERE id = ?", (cursor.lastrowid,)).fetchone()
    return jsonify(employee_summary_payload(row)), 201


@app.put("/api/admin/employees/<int:item_id>")
@admin_required
@open_shift_required
def update_admin_employee(item_id):
    data = request.get_json(silent=True) or {}
    db = get_db()
    row = db.execute("SELECT * FROM employees WHERE id = ?", (item_id,)).fetchone()
    if row is None:
        return api_error("الموظف غير موجود.", 404)

    username = str(data.get("username", row["username"])).strip() or row["username"]
    password = str(data.get("password", "")).strip()
    monthly_salary = positive_number(data.get("monthly_salary", row["monthly_salary"]), "راتب الموظف", True)
    can_sell = bool(int(data.get("can_sell", row["can_sell"]) or 0))
    can_manage_expenses = bool(int(data.get("can_manage_expenses", row["can_manage_expenses"]) or 0))
    can_manage_purchases = bool(int(data.get("can_manage_purchases", row["can_manage_purchases"]) or 0))
    can_manage_inventory = bool(int(data.get("can_manage_inventory", row["can_manage_inventory"]) or 0))
    can_join_existing_shift = bool(int(data.get("can_join_existing_shift", row["can_join_existing_shift"]) or 0))
    is_active = int(bool(data.get("is_active", row["is_active"])))

    if db.execute("SELECT 1 FROM employees WHERE username = ? AND id != ?", (username, item_id)).fetchone():
        return api_error("اسم المستخدم مستخدم من موظف آخر.", 409)

    values = [
        username,
        generate_password_hash(password) if password else row["password_hash"],
        monthly_salary,
        int(can_sell),
        int(can_manage_expenses),
        int(can_manage_purchases),
        int(can_manage_inventory),
        int(can_join_existing_shift),
        is_active,
        item_id,
    ]
    db.execute(
        "UPDATE employees SET username = ?, password_hash = ?, monthly_salary = ?, can_sell = ?, can_manage_expenses = ?, can_manage_purchases = ?, can_manage_inventory = ?, can_join_existing_shift = ?, is_active = ? WHERE id = ?",
        values,
    )
    db.commit()
    updated = db.execute("SELECT * FROM employees WHERE id = ?", (item_id,)).fetchone()
    return jsonify(employee_summary_payload(updated))


@app.delete("/api/admin/employees/<int:item_id>")
@admin_required
@open_shift_required
def delete_admin_employee(item_id):
    db = get_db()
    employee = db.execute("SELECT * FROM employees WHERE id = ?", (item_id,)).fetchone()
    if employee is None:
        return api_error("الموظف غير موجود.", 404)
    open_shift = db.execute(
        "SELECT * FROM shifts WHERE employee_id = ? AND status = 'open' LIMIT 1",
        (item_id,),
    ).fetchone()
    if open_shift:
        close_employee_shift(db, open_shift, reason="employee_deactivated")
    db.execute("UPDATE employees SET is_active = 0 WHERE id = ?", (item_id,))
    references = (
        ("shifts", "employee_id"),
        ("orders", "employee_id"),
        ("expenses", "employee_id"),
        ("purchases", "employee_id"),
        ("cash_entries", "employee_id"),
        ("payroll_settlements", "employee_id"),
    )
    for table, column in references:
        if db.execute(
            "SELECT 1 FROM " + table + " WHERE " + column + " = ? LIMIT 1",
            (item_id,),
        ).fetchone():
            db.commit()
            return api_error("تم إيقاف حساب الموظف مع الحفاظ على السجلات التاريخية.", 409)
    db.execute("DELETE FROM employees WHERE id = ?", (item_id,))
    db.commit()
    return jsonify({"ok": True, "id": item_id})


def format_iso_datetime(value, fmt=None):
    """Convert an ISO timestamp into a simple, readable Arabic-friendly string."""
    if not value:
        return ""
    raw = str(value)
    try:
        parsed = datetime.fromisoformat(raw)
    except (TypeError, ValueError):
        return raw
    if fmt:
        return parsed.strftime(fmt)
    if parsed.hour == 0 and parsed.minute == 0 and parsed.second == 0:
        return parsed.strftime("%d/%m/%Y")
    period = "ص" if parsed.hour < 12 else "م"
    hour12 = parsed.hour % 12 or 12
    return parsed.strftime("%d/%m/%Y") + " · " + "{:02d}:{:02d}".format(hour12, parsed.minute) + " " + period


def local_datetime_for_report(value):
    parsed = datetime.fromisoformat(value) if isinstance(value, str) else value
    return parsed.astimezone()


def business_date_for(value):
    """Map a local timestamp to its 10:00-start business date for reporting."""
    parsed = local_datetime_for_report(value)
    business_date = parsed.date()
    if parsed.hour < 10:
        business_date -= timedelta(days=1)
    return business_date


def today_sales_summary(db, now=None):
    business_date = business_date_for(now or datetime.now().astimezone())
    business_date_text = business_date.isoformat()
    next_date_text = (business_date + timedelta(days=1)).isoformat()
    candidates = db.execute(
        """SELECT id, timestamp, total_amount, items_json
           FROM orders
           WHERE status = 'completed' AND substr(timestamp, 1, 10) IN (?, ?)""",
        (business_date_text, next_date_text),
    ).fetchall()
    completed_orders = [
        order
        for order in candidates
        if business_date_for(order["timestamp"]) == business_date
    ]

    sales = sum(float(order["total_amount"]) for order in completed_orders)
    cogs = sum(
        float(item["unit_cost"]) * float(item["quantity"])
        for order in completed_orders
        for item in json.loads(order["items_json"])
    )
    expenses = db.execute(
        "SELECT COALESCE(SUM(amount), 0) AS value FROM expenses WHERE date = ?",
        (business_date_text,),
    ).fetchone()["value"]
    most_recent = max(
        completed_orders,
        key=lambda order: local_datetime_for_report(order["timestamp"]),
        default=None,
    )
    return {
        "business_date": business_date_text,
        "today_sales": round(sales, 2),
        "today_profit": round(sales - cogs - float(expenses or 0), 2),
        "today_orders_count": len(completed_orders),
        "last_sale": (
            {
                "id": most_recent["id"],
                "timestamp": most_recent["timestamp"],
                "total_amount": round(float(most_recent["total_amount"]), 2),
            }
            if most_recent
            else None
        ),
    }


def project_summary_rows(db):
    ensure_business_day(db)
    rows = db.execute(
        "SELECT * FROM business_days ORDER BY project_date DESC"
    ).fetchall()
    sealed_days = {
        row["period_key"]: row
        for row in db.execute(
            """SELECT period_key, status, expected_cash, counted_cash, closing_variance,
                      closed_at, closed_by, auto_generated
               FROM closing_reports WHERE period_type = 'day'"""
        )
    }
    today = date.today().isoformat()
    result = []
    for row in rows:
        day = dict(row)
        day_id = row["id"]
        sales = db.execute(
            "SELECT COALESCE(SUM(total_amount), 0) AS value FROM orders WHERE substr(timestamp, 1, 10) = ? AND status = 'completed'",
            (row["project_date"],),
        ).fetchone()["value"]
        expenses = db.execute(
            "SELECT COALESCE(SUM(amount), 0) AS value FROM expenses WHERE date = ?",
            (row["project_date"],),
        ).fetchone()["value"]
        cash_balance = round(float(business_day_cash(db, day_id)), 2)
        day["sales"] = round(float(sales or 0), 2)
        day["expenses"] = round(float(expenses or 0), 2)
        day["cash_balance"] = cash_balance
        day["closing_variance"] = round(float(row["closing_variance"] or 0), 2)
        closing = sealed_days.get(row["project_date"])
        # A sealed day is a standalone project: the reports screen lists it with
        # its stored snapshot instead of rebuilding the numbers from live rows.
        day["closing"] = dict(closing) if closing is not None else None
        day["closed"] = row["status"] == "closed" or closing is not None
        day["is_today"] = row["project_date"] == today
        result.append(day)
    return result


@app.get("/api/projects")
@cashier_session_required
def list_projects():
    return jsonify(project_summary_rows(get_db()))


@app.get("/api/admin/projects")
@admin_required
def list_admin_projects():
    return jsonify(project_summary_rows(get_db()))


def report_period_key():
    period = str(request.args.get("period", "day")).strip().lower()
    if period not in ("day", "month"):
        raise ValueError("اختر تقرير اليوم أو تقرير الشهر.")
    if period == "month":
        key = str(request.args.get("month") or date.today().strftime("%Y-%m")).strip()
        datetime.strptime(key, "%Y-%m")
        return period, key
    key = str(request.args.get("date") or date.today().isoformat()).strip()
    datetime.strptime(key, "%Y-%m-%d")
    return period, key


def order_filter_sql(period):
    column = "substr(timestamp, 1, 7)" if period == "month" else "substr(timestamp, 1, 10)"
    return column + " = ?"


def expense_filter_sql(period):
    column = "substr(date, 1, 7)" if period == "month" else "date"
    return column + " = ?"


def build_project_report(db, period, key):
    order_where = order_filter_sql(period)
    expense_where = expense_filter_sql(period)
    orders = db.execute(
        """SELECT o.id, o.timestamp, o.total_amount, o.items_json, o.status, o.cancel_reason,
                  o.cancelled_at, o.shift_id, o.employee_id,
                  e.username AS employee_name, s.started_at AS shift_started_at
           FROM orders o
           LEFT JOIN employees e ON e.id = o.employee_id
           LEFT JOIN shifts s ON s.id = o.shift_id
           WHERE """ + order_where + """
           ORDER BY o.timestamp, o.id""",
        (key,),
    ).fetchall()
    sales = []
    returns = []
    revenue = 0.0
    returns_total = 0.0
    cogs = 0.0
    completed_orders = 0
    consumption = {}
    shift_sales = {}
    shift_returns = {}
    for order in orders:
        items = json.loads(order["items_json"] or "[]")
        line_items = [
            {
                "name": item.get("name") or "",
                "quantity": item.get("quantity") or 0,
                "unit_price": round(float(item.get("unit_price") or 0), 2),
                "discount_amount": round(float(item.get("discount_amount") or 0), 2),
                "line_total": round(float(item.get("line_total") or 0), 2),
            }
            for item in items if isinstance(item, dict)
        ]
        summary = {
            "order_id": order["id"],
            "timestamp": order["timestamp"],
            "timestamp_display": format_iso_datetime(order["timestamp"]),
            "employee_name": order["employee_name"] or "غير مسجل",
            "shift_started_at": order["shift_started_at"],
            "total_amount": round(float(order["total_amount"] or 0), 2),
            "items": line_items,
            "item_names": "، ".join(entry["name"] for entry in line_items),
        }
        if order["status"] == "completed":
            revenue += float(order["total_amount"] or 0)
            completed_orders += 1
            for item in items:
                if not isinstance(item, dict):
                    continue
                cogs += float(item.get("unit_cost") or 0) * float(item.get("quantity") or 0)
                if item.get("kind") == "drink":
                    for used in item.get("materials_used") or []:
                        if not isinstance(used, dict) or used.get("material_id") is None:
                            continue
                        material_id = int(used["material_id"])
                        consumption[material_id] = consumption.get(material_id, 0) + float(used.get("total_qty") or 0)
            sales.append(summary)
            shift_sales.setdefault(order["shift_id"], []).append
        else:
            returns_total += float(order["total_amount"] or 0)
            summary["reason"] = order["cancel_reason"] or ""
            summary["cancelled_at"] = order["cancelled_at"]
            summary["cancelled_display"] = format_iso_datetime(order["cancelled_at"])
            returns.append(summary)
            shift_returns.setdefault(order["shift_id"], []).append(summary)
    expenses_rows = db.execute(
        "SELECT id, date, category, amount, note FROM expenses WHERE " +
 expense_where,
        (key,),
    ).fetchall()
    expenses_total = sum(float(row["amount"] or 0) for row in expenses_rows)
    purchase_where = "substr(timestamp, 1, 7) = ?" if period == "month" else "substr(timestamp, 1, 10) = ?"
    purchase_rows = db.execute(
        "SELECT id, timestamp, supplier, category, amount, note FROM purchases WHERE " + purchase_where + " ORDER BY timestamp, id",
        (key,),
    ).fetchall()
    purchases_total = sum(float(row["amount"] or 0) for row in purchase_rows)
    consumption_rows = []
    for material_id in sorted(consumption):
        quantity = consumption[material_id]
        material = db.execute(
            "SELECT name, unit, cost_per_unit FROM materials WHERE id = ?", (material_id,)
        ).fetchone()
        consumption_rows.append({
            "material_id": material_id,
            "name": material["name"] if material else "مادة #" + str(material_id),
            "unit": material["unit"] if material else "",
            "quantity": round(quantity, 4),
            "cost": round(quantity * float(material["cost_per_unit"]), 2) if material else 0.0,
        })
    consumption_cost = round(sum(entry["cost"] for entry in consumption_rows), 2)
    shifts = db.execute(
        """SELECT s.id, e.username, s.started_at, s.ended_at, s.status, s.opening_cash,
                  s.expected_cash, s.worked_seconds, s.payable_amount, s.closure_reason
           FROM shifts s
           JOIN employees e ON e.id = s.employee_id
           JOIN business_days b ON b.id = s.business_day_id
           WHERE """ + ("substr(b.project_date, 1, 7) = ?" if period == "month" else "b.project_date = ?") + """
           ORDER BY s.started_at""",
        (key,),
    ).fetchall()
    notes_sql = "substr(project_date, 1, 7) = ?" if period == "month" else "project_date = ?"
    notes = db.execute(
        "SELECT * FROM project_log_notes WHERE " + notes_sql + " ORDER BY event_time, id",
        (key,),
    ).fetchall()
    log = []
    for shift in shifts:
        log.append({
            "source": "shift",
            "editable": False,
            "event_time": shift["started_at"],
            "title": "تسجيل حضور: " + shift["username"],
            "details": "بداية الوردية · رصيد النظام " + str(round(float(shift["opening_cash"] or 0), 2)),
        })
        if shift["ended_at"]:
            reason = "تسليم لموظف آخر" if shift["closure_reason"] == "handover" else "إنهاء الوردية"
            log.append({
                "source": "shift",
                "editable": False,
                "event_time": shift["ended_at"],
                "title": reason + ": " + shift["username"],
                "details": "المستحق " + str(round(float(shift["payable_amount"] or 0), 2)),
            })
    for order in orders:
        names = "، ".join(str(item.get("name") or "") for item in json.loads(order["items_json"] or "[]"))
        if order["status"] == "cancelled":
            log.append({
                "source": "sale",
                "editable": False,
                "event_time": order["timestamp"],
                "title": "استرجاع عملية بيع #" + str(order["id"]),
                "details": (order["employee_name"] or "غير مسجل") + " · " + names + " · " + (order["cancel_reason"] or ""),
            })
        else:
            log.append({
                "source": "sale",
                "editable": False,
                "event_time": order["timestamp"],
                "title": "بيع #" + str(order["id"]) + " بواسطة " + (order["employee_name"] or "غير مسجل"),
                "details": names + " · الإجمالي " + str(round(float(order["total_amount"] or 0), 2)),
            })
    for row in expenses_rows:
        log.append({
            "source": "expense",
            "editable": False,
            "event_time": row["date"] + "T00:00:00",
            "title": "مصروف: " + row["category"],
            "details": str(round(float(row["amount"] or 0), 2)) + " · " + (row["note"] or ""),
        })
    for row in purchase_rows:
        log.append({
            "source": "purchase",
            "editable": False,
            "event_time": row["timestamp"],
            "title": "مشتريات: " + (row["supplier"] or row["category"] or "توريد"),
            "details": str(round(float(row["amount"] or 0), 2)) + " · " + (row["note"] or ""),
        })
    for row in consumption_rows:
        log.append({
            "source": "consumption",
            "editable": False,
            "event_time": key + ("-01T00:00:00" if period == "month" else "T00:00:00"),
            "title": "استهلاك: " + row["name"],
            "details": str(row["quantity"]) + " " + (row["unit"] or "") + " · التكلفة " + str(row["cost"]),
        })
    for note in notes:
        item = dict(note)
        item["source"] = "note"
        item["editable"] = True
        log.append(item)
    log.sort(key=lambda item: str(item.get("event_time") or ""))
    for entry in log:
        entry["event_time_display"] = format_iso_datetime(entry.get("event_time"))
    shift_breakdown = []
    seen_shifts = set()
    for shift in shifts:
        breakdown = dict(shift)
        breakdown["sales"] = shift_sales.get(shift["id"], [])
        breakdown["returns"] = shift_returns.get(shift["id"], [])
        breakdown["sales_total"] = round(sum(item["total_amount"] for item in breakdown["sales"]), 2)
        breakdown["returns_total"] = round(sum(item["total_amount"] for item in breakdown["returns"]), 2)
        breakdown["orders_count"] = len(breakdown["sales"])
        breakdown["returns_count"] = len(breakdown["returns"])
        breakdown["started_display"] = format_iso_datetime(shift["started_at"])
        breakdown["ended_display"] = format_iso_datetime(shift["ended_at"])
        shift_breakdown.append(breakdown)
        seen_shifts.add(shift["id"])
    unassigned_sales = [item for key_id, values in shift_sales.items() if key_id not in seen_shifts for item in values]
    unassigned_returns = [item for key_id, values in shift_returns.items() if key_id not in seen_shifts for item in values]
    if unassigned_sales or unassigned_returns:
        shift_breakdown.append({
            "id": None,
            "username": "بدون وردية مسجلة",
            "started_at": None,
            "ended_at": None,
            "status": "",
            "opening_cash": None,
            "expected_cash": None,
            "worked_seconds": 0,
            "payable_amount": 0,
            "closure_reason": "",
            "sales": unassigned_sales,
            "returns": unassigned_returns,
            "sales_total": round(sum(item["total_amount"] for item in unassigned_sales), 2),
            "returns_total": round(sum(item["total_amount"] for item in unassigned_returns), 2),
            "orders_count": len(unassigned_sales),
            "returns_count": len(unassigned_returns),
        })
    days = project_summary_rows(db)
    if period == "day":
        days = [row for row in days if row["project_date"] == key]
    else:
        days = [row for row in days if str(row["project_date"]).startswith(key)]
    return {
        "period": period,
        "key": key,
        "revenue": round(revenue, 2),
        "cogs": round(cogs, 2),
        "expenses": round(expenses_total, 2),
        "purchases_total": round(purchases_total, 2),
        "returns_total": round(returns_total, 2),
        "consumption_cost": consumption_cost,
        "profit": round(revenue - cogs - expenses_total, 2),
        "orders": completed_orders,
        "days": days,
        "sales": sales,
        "returns": returns,
        "purchases": [dict(row) for row in purchase_rows],
        "consumption_rows": consumption_rows,
        "expense_rows": [dict(row) for row in expenses_rows],
        "shifts": [dict(row) for row in shifts],
        "shift_breakdown": shift_breakdown,
        "notes": [dict(row) for row in notes],
        "log": log,
    }


# --- DAY & MONTH CLOSING ---------------------------------------------------
# A closing freezes a period: its report is stored verbatim in closing_reports,
# every shift still open on it is ended, and the business day is locked so the
# next day starts from the cash that was actually counted.
CLOSING_PERIOD_LABELS = {"day": "اليوم", "month": "الشهر"}
# Snapshots are kept whole; only an unusually busy month loses its event log.
CLOSING_PAYLOAD_LIMIT = 400000


def closing_snapshot(report):
    """Frozen copy of a period report, trimmed only when it grows too large."""
    payload = dict(report)
    if len(json.dumps(payload, ensure_ascii=False)) > CLOSING_PAYLOAD_LIMIT:
        payload.pop("log", None)
        payload["log_omitted"] = True
    return payload


def closing_record(db, period, key):
    """Metadata of a stored closing without the (possibly large) snapshot."""
    row = db.execute(
        "SELECT * FROM closing_reports WHERE period_type = ? AND period_key = ?",
        (period, key),
    ).fetchone()
    if row is None:
        return None
    return {
        "id": row["id"],
        "period_type": row["period_type"],
        "period_key": row["period_key"],
        "status": row["status"],
        "expected_cash": round(float(row["expected_cash"] or 0), 2),
        "counted_cash": None if row["counted_cash"] is None else round(float(row["counted_cash"]), 2),
        "closing_variance": round(float(row["closing_variance"] or 0), 2),
        "closed_at": row["closed_at"],
        "closed_at_display": format_iso_datetime(row["closed_at"]),
        "closed_by": row["closed_by"],
        "auto_generated": bool(row["auto_generated"]),
    }


def sealed_report(db, period, key):
    """The stored report for a closed period, or None while it stays open."""
    row = db.execute(
        "SELECT * FROM closing_reports WHERE period_type = ? AND period_key = ?",
        (period, key),
    ).fetchone()
    if row is None:
        return None
    try:
        payload = json.loads(row["payload_json"] or "{}")
    except (TypeError, json.JSONDecodeError):
        payload = {}
    if not isinstance(payload, dict):
        payload = {}
    payload.update(closing_record(db, period, key) or {})
    payload["sealed"] = True
    payload.setdefault("period", period)
    payload.setdefault("key", key)
    return payload


def closing_summary(db, period, key):
    """Headline numbers for the closing dialog, before anything is stored."""
    sales = returns = 0.0
    orders_count = returns_count = 0
    for row in db.execute(
        "SELECT status, COALESCE(SUM(total_amount), 0) AS value, COUNT(*) AS count FROM orders WHERE "
        + order_filter_sql(period) + " GROUP BY status",
        (key,),
    ):
        if row["status"] == "completed":
            sales, orders_count = float(row["value"]), row["count"]
        else:
            returns, returns_count = float(row["value"]), row["count"]
    expense_row = db.execute(
        "SELECT COALESCE(SUM(amount), 0) AS value, COUNT(*) AS count FROM expenses WHERE "
        + expense_filter_sql(period),
        (key,),
    ).fetchone()
    purchase_column = "substr(timestamp, 1, 7)" if period == "month" else "substr(timestamp, 1, 10)"
    purchase_row = db.execute(
        "SELECT COALESCE(SUM(amount), 0) AS value, COUNT(*) AS count FROM purchases WHERE "
        + purchase_column + " = ?",
        (key,),
    ).fetchone()
    day_column = "substr(project_date, 1, 7) = ?" if period == "month" else "project_date = ?"
    days = db.execute(
        "SELECT * FROM business_days WHERE " + day_column + " ORDER BY project_date",
        (key,),
    ).fetchall()
    drawer = round(float(business_day_cash(db, days[-1]["id"])), 2) if days else 0.0
    return {
        "period": period,
        "key": key,
        "sales": round(sales, 2),
        "orders_count": orders_count,
        "returns": round(returns, 2),
        "returns_count": returns_count,
        "expenses": round(float(expense_row["value"] or 0), 2),
        "expenses_count": expense_row["count"],
        "purchases": round(float(purchase_row["value"] or 0), 2),
        "purchases_count": purchase_row["count"],
        "days_count": len(days),
        "drawer_balance": drawer,
        "day_status": "closed" if days and days[-1]["status"] == "closed" else "open",
    }


def close_period(db, period, key, counted_cash=None, note="", actor_name="", auto_generated=False):
    """Seal a day or a month and hand the counted drawer to the next period."""
    if period not in CLOSING_PERIOD_LABELS:
        raise ValueError("نطاق التقفيل غير صالح.")
    try:
        period_date = datetime.strptime(key, "%Y-%m-%d" if period == "day" else "%Y-%m")
    except (TypeError, ValueError):
        raise ValueError("تاريخ التقفيل غير صالح.")
    if db.execute(
        "SELECT 1 FROM closing_reports WHERE period_type = ? AND period_key = ? LIMIT 1",
        (period, key),
    ).fetchone():
        raise ValueError("تم تقفيل " + CLOSING_PERIOD_LABELS[period] + " " + key + " من قبل.")

    summary = closing_summary(db, period, key)
    # A period that never saw a record has nothing to freeze.
    if not summary["days_count"] and not summary["orders_count"] and not summary["expenses_count"]:
        raise ValueError("لا توجد بيانات " + CLOSING_PERIOD_LABELS[period] + " " + key + " لتقفيلها.")

    day_column = "substr(project_date, 1, 7) = ?" if period == "month" else "project_date = ?"
    day_rows = db.execute(
        "SELECT * FROM business_days WHERE " + day_column + " ORDER BY project_date",
        (key,),
    ).fetchall()
    expected = round(float(summary["drawer_balance"]), 2)
    counted = expected if counted_cash is None else round(float(counted_cash), 2)
    variance = round(counted - expected, 2)
    now = datetime.now().astimezone().isoformat(timespec="seconds")
    closure_reason = "day_close" if period == "day" else "month_close"

    shift_column = "b.project_date = ?" if period == "day" else "substr(b.project_date, 1, 7) = ?"
    open_shifts = db.execute(
        """SELECT s.* FROM shifts s JOIN business_days b ON b.id = s.business_day_id
           WHERE s.status = 'open' AND """ + shift_column + " ORDER BY s.id",
        (key,),
    ).fetchall()
    for shift in open_shifts:
        close_employee_shift(db, shift, reason=closure_reason)

    payload = closing_snapshot(build_project_report(db, period, key))
    payload["closing"] = {
        "expected_cash": expected,
        "counted_cash": counted,
        "closing_variance": variance,
        "closed_at": now,
        "closed_by": actor_name,
        "auto_generated": bool(auto_generated),
        "note": note,
    }
    db.execute(
        """INSERT INTO closing_reports(period_type, period_key, status, payload_json,
               expected_cash, counted_cash, closing_variance, closed_at, closed_by, auto_generated)
           VALUES (?, ?, 'closed', ?, ?, ?, ?, ?, ?, ?)""",
        (
            period, key, json.dumps(payload, ensure_ascii=False), expected, counted,
            variance, now, actor_name, 1 if auto_generated else 0,
        ),
    )
    for index, day in enumerate(day_rows):
        day_expected = round(float(business_day_cash(db, day["id"])), 2)
        # Only the last day of the sealed period carries the counted drawer, so
        # every earlier day keeps a variance of zero against its own balance.
        day_counted = counted if index == len(day_rows) - 1 else day_expected
        db.execute(
            """UPDATE business_days SET status = 'closed', closed_at = ?, expected_cash = ?,
                      counted_cash = ?, closing_variance = ? WHERE id = ?""",
            (
                now, day_expected, day_counted,
                round(day_counted - day_expected, 2), day["id"],
            ),
        )
    next_day = (period_date.date() + timedelta(days=1)).isoformat()
    if period == "day" and key >= date.today().isoformat():
        if db.execute(
            "SELECT 1 FROM business_days WHERE project_date = ? LIMIT 1", (next_day,)
        ).fetchone() is None:
            # This is the reset the button promises: an empty new day whose
            # opening cash is whatever was just counted in the drawer.
            ensure_business_day(db, period_date.date() + timedelta(days=1))
    else:
        next_day = None
    db.commit()
    return {
        "period": period,
        "key": key,
        "status": "closed",
        "expected_cash": expected,
        "counted_cash": counted,
        "closing_variance": variance,
        "closed_at": now,
        "closed_at_display": format_iso_datetime(now),
        "closed_by": actor_name,
        "auto_generated": bool(auto_generated),
        "shifts_closed": [shift["id"] for shift in open_shifts],
        "days_closed": [day["project_date"] for day in day_rows],
        "next_day": next_day,
        "summary": summary,
    }


def reopen_period(db, period, key, actor_name=""):
    """Undo a closing: drop the snapshot and unlock the period's business days."""
    if period not in CLOSING_PERIOD_LABELS:
        raise ValueError("نطاق التقفيل غير صالح.")
    if closing_record(db, period, key) is None:
        raise ValueError(CLOSING_PERIOD_LABELS[period] + " " + key + " غير مقفل.")
    db.execute(
        "DELETE FROM closing_reports WHERE period_type = ? AND period_key = ?",
        (period, key),
    )
    day_column = "substr(project_date, 1, 7) = ?" if period == "month" else "project_date = ?"
    rows = db.execute(
        "SELECT id FROM business_days WHERE " + day_column, (key,)
    ).fetchall()
    for row in rows:
        db.execute(
            """UPDATE business_days SET status = 'open', closed_at = NULL, expected_cash = NULL,
                      counted_cash = NULL, closing_variance = NULL WHERE id = ?""",
            (row["id"],),
        )
    db.commit()
    app.logger.info("Closed period %s %s reopened by %s", period, key, actor_name or "unknown")
    return {"period": period, "key": key, "status": "open", "days_reopened": len(rows)}


def months_awaiting_auto_close(db, current_month=None):
    """Finished months that hold data but have never been sealed."""
    current_month = current_month or date.today().strftime("%Y-%m")
    periods = set()
    for statement in (
        "SELECT DISTINCT substr(timestamp, 1, 7) AS key FROM orders",
        "SELECT DISTINCT substr(date, 1, 7) AS key FROM expenses",
        "SELECT DISTINCT substr(timestamp, 1, 7) AS key FROM purchases",
        "SELECT DISTINCT substr(project_date, 1, 7) AS key FROM business_days",
    ):
        for row in db.execute(statement):
            if row["key"]:
                periods.add(str(row["key"]))
    sealed = {
        row["period_key"]
        for row in db.execute("SELECT period_key FROM closing_reports WHERE period_type = 'month'")
    }
    return sorted(period for period in periods if period < current_month and period not in sealed)


def auto_close_finished_months(db, actor_name="النظام"):
    """On the first of a new month the previous ones close as a shift opens."""
    closed = []
    for month_key in months_awaiting_auto_close(db):
        try:
            closed.append(close_period(
                db, "month", month_key,
                actor_name=actor_name, auto_generated=True,
            ))
        except ValueError:
            # An empty month, or one already sealed, is simply skipped.
            continue
        except Exception:
            db.rollback()
            app.logger.exception("Unexpected error auto-closing month %s", month_key)
    return closed


def day_close_manager_required(function):
    """Closing the day lives beside the expenses screen, so expense rights allow it."""
    @wraps(function)
    def wrapped(*args, **kwargs):
        if session.get("admin_id"):
            return function(*args, **kwargs)
        employee_id = session.get("employee_id")
        if not employee_id:
            return api_error("يرجى تسجيل الدخول للمتابعة.", 401)
        employee = get_db().execute(
            "SELECT * FROM employees WHERE id = ? AND is_active = 1", (employee_id,)
        ).fetchone()
        if employee is None:
            session.clear()
            return api_error("حساب الموظف غير نشط.", 403)
        if not employee["can_manage_expenses"]:
            return api_error("لا تملك صلاحية تقفيل اليوم.", 403)
        return function(*args, **kwargs)

    return wrapped


def parse_counted_cash(value):
    if value is None or str(value).strip() == "":
        return None
    try:
        counted = float(value)
    except (TypeError, ValueError):
        raise ValueError("رصيد الدرج المعدود يجب أن يكون رقمًا.")
    if not math.isfinite(counted) or counted < 0:
        raise ValueError("رصيد الدرج المعدود يجب أن يكون صفرًا أو أكثر.")
    return round(counted, 2)


def closing_report_rows(db, limit=120):
    rows = db.execute(
        """SELECT period_type, period_key, status, expected_cash, counted_cash, closing_variance,
                  closed_at, closed_by, auto_generated
           FROM closing_reports ORDER BY period_key DESC, period_type LIMIT ?""",
        (int(limit),),
    ).fetchall()
    reports = []
    for row in rows:
        entry = dict(row)
        entry["closed_at_display"] = format_iso_datetime(row["closed_at"])
        entry["auto_generated"] = bool(row["auto_generated"])
        reports.append(entry)
    return reports


@app.get("/api/closing/state")
@day_close_manager_required
def closing_state():
    """Everything the closing dialog needs: today, the month and past closings."""
    db = get_db()
    today = date.today()
    day_key = today.isoformat()
    month_key = today.strftime("%Y-%m")
    business_day = db.execute(
        "SELECT * FROM business_days WHERE project_date = ?", (day_key,)
    ).fetchone()
    shift = open_shift_context(db)
    shift_payload = None
    if shift is not None:
        person = db.execute(
            "SELECT username FROM employees WHERE id = ?", (shift["employee_id"],)
        ).fetchone()
        shift_payload = {
            "id": shift["id"],
            "username": person["username"] if person else "",
            "started_at": shift["started_at"],
            "business_day_id": shift["business_day_id"],
        }
    return jsonify({
        "today": day_key,
        "month": month_key,
        "business_day": dict(business_day) if business_day else None,
        "day_summary": closing_summary(db, "day", day_key),
        "month_summary": closing_summary(db, "month", month_key),
        "day_closing": closing_record(db, "day", day_key),
        "month_closing": closing_record(db, "month", month_key),
        "open_shift": shift_payload,
        "pending_months": months_awaiting_auto_close(db),
        "reports": closing_report_rows(db),
    })


@app.get("/api/closing/reports")
@dashboard_access_required
def closing_reports_list():
    db = get_db()
    period = str(request.args.get("period") or "").strip().lower()
    if period in CLOSING_PERIOD_LABELS:
        rows = db.execute(
            """SELECT period_type, period_key, status, expected_cash, counted_cash, closing_variance,
                      closed_at, closed_by, auto_generated
               FROM closing_reports WHERE period_type = ?
               ORDER BY period_key DESC LIMIT ?""",
            (period, int(request.args.get("limit") or 120)),
        ).fetchall()
        reports = []
        for row in rows:
            entry = dict(row)
            entry["closed_at_display"] = format_iso_datetime(row["closed_at"])
            entry["auto_generated"] = bool(row["auto_generated"])
            reports.append(entry)
        return jsonify({"period": period, "reports": reports})
    return jsonify({"reports": closing_report_rows(db)})


@app.post("/api/day-close")
@day_close_manager_required
def close_day():
    """The day-close button: freeze today as its own report and reset the day."""
    body = request.get_json(silent=True)
    if body is not None and not isinstance(body, dict):
        return api_error("بيانات التقفيل غير صالحة.")
    body = body or {}
    db = get_db()
    key = str(body.get("date") or date.today().isoformat()).strip()
    try:
        counted = parse_counted_cash(body.get("counted_cash"))
    except ValueError as error:
        return api_error(str(error))
    note = str(body.get("note") or "").strip()[:300]
    _actor_id, actor_name, _role = current_actor_identity(db)
    try:
        result = close_period(
            db, "day", key, counted_cash=counted, note=note, actor_name=actor_name
        )
    except ValueError as error:
        db.rollback()
        return api_error(str(error), 409)
    except Exception:
        db.rollback()
        app.logger.exception("Unexpected error closing the day")
        return api_error("حدث خطأ أثناء تقفيل اليوم.", 500)
    app.logger.info("Day %s closed by %s", key, actor_name or "unknown")
    return jsonify(result)


@app.post("/api/month-close")
@admin_required
def close_month_route():
    """Close one finished month, or catch up on every month still waiting."""
    body = request.get_json(silent=True)
    if body is not None and not isinstance(body, dict):
        return api_error("بيانات التقفيل غير صالحة.")
    body = body or {}
    db = get_db()
    _actor_id, actor_name, _role = current_actor_identity(db)
    month = str(body.get("month") or "").strip()
    if month:
        try:
            return jsonify(close_period(db, "month", month, actor_name=actor_name))
        except ValueError as error:
            db.rollback()
            return api_error(str(error), 409)
        except Exception:
            db.rollback()
            app.logger.exception("Unexpected error closing month %s", month)
            return api_error("حدث خطأ أثناء تقفيل الشهر.", 500)
    try:
        return jsonify({"closed": auto_close_finished_months(db, actor_name)})
    except Exception:
        db.rollback()
        app.logger.exception("Unexpected error catching up on month closings")
        return api_error("حدث خطأ أثناء تقفيل الأشهر.", 500)


@app.post("/api/closing/reopen")
@day_close_manager_required
def reopen_closing_route():
    """Unlock a sealed period again; only an admin may reopen a whole month."""
    body = request.get_json(silent=True)
    if body is not None and not isinstance(body, dict):
        return api_error("بيانات إعادة الفتح غير صالحة.")
    body = body or {}
    period = str(body.get("period") or "day").strip().lower()
    key = str(body.get("date") or body.get("month") or "").strip()
    if period not in CLOSING_PERIOD_LABELS:
        return api_error("نطاق التقفيل غير صالح.")
    if period == "month" and not session.get("admin_id"):
        return api_error("إعادة فتح الشهر متاحة للمدير فقط.", 403)
    if not key:
        return api_error("حدد الفترة المطلوب إعادة فتحها.")
    db = get_db()
    _actor_id, actor_name, _role = current_actor_identity(db)
    try:
        return jsonify(reopen_period(db, period, key, actor_name))
    except ValueError as error:
        return api_error(str(error), 409)
    except Exception:
        db.rollback()
        app.logger.exception("Unexpected error reopening period %s %s", period, key)
        return api_error("حدث خطأ أثناء إعادة فتح الفترة.", 500)


@app.get("/api/projects/report")
@cashier_session_required
def cashier_project_report():
    try:
        period, key = report_period_key()
    except ValueError:
        return api_error("تاريخ التقرير غير صالح.")
    db = get_db()
    return jsonify(sealed_report(db, period, key) or build_project_report(db, period, key))


@app.get("/api/admin/projects/report")
@admin_required
def admin_project_report():
    try:
        period, key = report_period_key()
    except ValueError:
        return api_error("تاريخ التقرير غير صالح.")
    db = get_db()
    return jsonify(sealed_report(db, period, key) or build_project_report(db, period, key))


@app.post("/api/admin/project-notes")
@admin_required
@open_shift_required
def create_project_note():
    data = request.get_json(silent=True) or {}
    title = str(data.get("title", "")).strip()
    details = str(data.get("details", "")).strip()
    project_date = str(data.get("project_date") or date.today().isoformat()).strip()
    try:
        datetime.strptime(project_date, "%Y-%m-%d")
    except ValueError:
        return api_error("تاريخ السجل يجب أن يكون يومًا صالحًا.")
    if not title:
        return api_error("عنوان الحدث مطلوب.")
    now = datetime.now().astimezone().isoformat(timespec="seconds")
    db = get_db()
    cursor = db.execute(
        """INSERT INTO project_log_notes(project_date, event_time, title, details, created_by, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)""",
        (project_date, now, title, details, "admin", now),
    )
    db.commit()
    row = db.execute("SELECT * FROM project_log_notes WHERE id = ?", (cursor.lastrowid,)).fetchone()
    return jsonify(dict(row)), 201


@app.put("/api/admin/project-notes/<int:note_id>")
@admin_required
@open_shift_required
def update_project_note(note_id):
    data = request.get_json(silent=True) or {}
    db = get_db()
    row = db.execute("SELECT * FROM project_log_notes WHERE id = ?", (note_id,)).fetchone()
    if row is None:
        return api_error("السجل غير موجود.", 404)

    username = str(data.get("username", row["username"])).strip() or row["username"]
    password = str(data.get("password", "")).strip()
    monthly_salary = positive_number(data.get("monthly_salary", row["monthly_salary"]), "راتب الموظف", True)
    can_sell = bool(int(data.get("can_sell", row["can_sell"]) or 0))
    can_manage_expenses = bool(int(data.get("can_manage_expenses", row["can_manage_expenses"]) or 0))
    can_manage_purchases = bool(int(data.get("can_manage_purchases", row["can_manage_purchases"]) or 0))
    can_manage_inventory = bool(int(data.get("can_manage_inventory", row["can_manage_inventory"]) or 0))
    is_active = int(bool(data.get("is_active", row["is_active"])))

    if db.execute("SELECT 1 FROM employees WHERE username = ? AND id != ?", (username, note_id)).fetchone():
        return api_error("اسم المستخدم مستخدم من موظف آخر.", 409)

    values = [
        username,
        generate_password_hash(password) if password else row["password_hash"],
        monthly_salary,
        int(can_sell),
        int(can_manage_expenses),
        int(can_manage_purchases),
        int(can_manage_inventory),
        is_active,
        note_id,
    ]
    db.execute(
        "UPDATE employees SET username = ?, password_hash = ?, monthly_salary = ?, can_sell = ?, can_manage_expenses = ?, can_manage_purchases = ?, can_manage_inventory = ?, is_active = ? WHERE id = ?",
        values,
    )
    db.commit()
    updated = db.execute("SELECT * FROM employees WHERE id = ?", (note_id,)).fetchone()
    return jsonify(employee_summary_payload(updated))


@app.delete("/api/admin/project-notes/<int:note_id>")
@admin_required
@open_shift_required
def delete_project_note(note_id):
    db = get_db()
    if db.execute("SELECT 1 FROM project_log_notes WHERE id = ?", (note_id,)).fetchone() is None:
        return api_error("السجل غير موجود.", 404)
    db.execute("DELETE FROM project_log_notes WHERE id = ?", (note_id,))
    db.commit()
    return jsonify({"ok": True, "id": note_id})


@app.get("/api/admin/attendance")
@admin_required
def list_admin_attendance():
    db = get_db()
    selected_date = str(request.args.get("date") or date.today().isoformat()).strip()
    try:
        datetime.strptime(selected_date, "%Y-%m-%d")
    except ValueError:
        return api_error("التاريخ غير صالح.")
    rows = db.execute(
        """SELECT s.id, s.employee_id, e.username, e.can_sell, e.can_manage_inventory,
                  e.can_manage_expenses, e.can_manage_purchases, e.can_join_existing_shift,
                  s.business_day_id,
                  b.project_date, s.started_at, s.ended_at, s.status, s.opening_cash,
                  s.worked_seconds, s.payable_amount
           FROM shifts s JOIN employees e ON e.id = s.employee_id
           JOIN business_days b ON b.id = s.business_day_id
           WHERE substr(s.started_at, 1, 10) = ?
           ORDER BY s.started_at DESC""",
        (selected_date,),
    ).fetchall()
    employee_rows = db.execute(
        "SELECT id, username, is_active FROM employees ORDER BY is_active DESC, username"
    ).fetchall()
    shift_employee_ids = {row["employee_id"] for row in rows}
    return jsonify({
        "date": selected_date,
        "shift_hours": configured_shift_seconds(db) / 3600,
        "open_shifts": open_shift_presence(db),
        "shifts": [dict(row) for row in rows],
        "employees": [
            {
                "id": row["id"],
                "username": row["username"],
                "is_active": bool(row["is_active"]),
                "attended": row["id"] in shift_employee_ids,
            }
            for row in employee_rows
        ],
    })


@app.post("/api/orders")
@cashier_session_required
@selling_required
@open_shift_required
def create_order():
    db = get_db()
    data = request.get_json(silent=True) or {}
    items = data.get("items")
    if not isinstance(items, list) or not items:
        return api_error("يجب إضافة صنف واحد على الأقل.")
    action = str(data.get("action", "complete")).strip().lower()
    order_status = "pending" if action == "pending" else "completed"

    shift = request_employee_shift(db)
    day = ensure_business_day(db)
    employee_id = session.get("employee_id")
    actor_id, actor_name, actor_role = employee_actor(db, employee_id)
    normalized = []
    total = 0.0
    try:
        for raw in items:
            kind = str(raw.get("kind", "")).strip()
            item_id = int(raw.get("id"))
            quantity = float(raw.get("quantity") or 0)
            discount_percent = float(raw.get("discount_percent") or 0)
            if quantity <= 0:
                raise ValueError("الكمية يجب أن تكون أكبر من صفر.")
            if discount_percent < 0 or discount_percent > 100:
                raise ValueError("نسبة الخصم يجب أن تكون بين صفر و100.")

            if kind == "book":
                row = db.execute("SELECT * FROM books WHERE id = ?", (item_id,)).fetchone()
                if row is None:
                    raise ValueError("الكتاب غير موجود.")
                if quantity != int(quantity) or float(row["stock_quantity"]) < quantity:
                    raise ValueError("الكمية المطلوبة من الكتاب غير متاحة.")
                name, unit_price, unit_cost = row["title"], float(row["sell_price"]), float(row["cost_price"])
            elif kind == "drink":
                row = db.execute("SELECT * FROM drinks WHERE id = ?", (item_id,)).fetchone()
                if row is None:
                    raise ValueError("المشروب غير موجود.")
                name, unit_price = row["name"], float(row["sell_price"])
                recipe = json.loads(row["recipe_json"] or "[]")
                unit_cost = product_recipe_cost(db, recipe)
                for ingredient in recipe:
                    material = db.execute("SELECT current_stock FROM materials WHERE id = ?", (int(ingredient["material_id"]),)).fetchone()
                    required = float(ingredient["qty"]) * quantity
                    if material is None or float(material["current_stock"]) + 1e-9 < required:
                        raise ValueError("المكونات غير متاحة لإعداد المشروب.")
            elif kind == "retail":
                row = db.execute("SELECT * FROM retail WHERE id = ?", (item_id,)).fetchone()
                if row is None:
                    raise ValueError("الصنف غير موجود.")
                if float(row["stock_quantity"]) < quantity:
                    raise ValueError("الكمية المطلوبة غير متاحة.")
                name, unit_price, unit_cost = row["name"], float(row["sell_price"]), float(row["cost_price"])
            else:
                raise ValueError("نوع الصنف غير معروف.")

            gross = unit_price * quantity
            discount_amount = round(gross * discount_percent / 100.0, 2)
            line_total = round(gross - discount_amount, 2)
            normalized.append({
                "kind": kind, "id": item_id, "name": name, "quantity": quantity,
                "unit_price": unit_price, "unit_cost": unit_cost,
                "discount_percent": discount_percent, "discount_amount": discount_amount,
                "line_total": line_total,
            })
            total += line_total
        total = round(total, 2)
        paid_amount = data.get("paid_amount")
        if paid_amount is None or (isinstance(paid_amount, str) and not paid_amount.strip()):
            paid_amount = total
        else:
            paid_amount = positive_number(paid_amount, "المبلغ المستلم", True)

        if order_status == "completed":
            for item in normalized:
                if item["kind"] == "book":
                    db.execute("UPDATE books SET stock_quantity = stock_quantity - ? WHERE id = ?", (item["quantity"], item["id"]))
                elif item["kind"] == "retail":
                    db.execute("UPDATE retail SET stock_quantity = stock_quantity - ? WHERE id = ?", (item["quantity"], item["id"]))
                else:
                    drink = db.execute("SELECT recipe_json FROM drinks WHERE id = ?", (item["id"],)).fetchone()
                    recipe = json.loads(drink["recipe_json"] or "[]")
                    for ingredient in recipe:
                        db.execute(
                            "UPDATE materials SET current_stock = current_stock - ? WHERE id = ?",
                            (float(ingredient["qty"]) * item["quantity"], int(ingredient["material_id"])),
                        )

        cursor = db.execute(
            """INSERT INTO orders
               (timestamp, total_amount, items_json, status, performed_by, performed_by_name,
                performed_by_role, employee_id, shift_id, business_day_id, payment_method, paid_amount)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                datetime.now().astimezone().isoformat(timespec="seconds"), total,
                json.dumps(normalized, ensure_ascii=False), order_status, actor_id, actor_name,
                actor_role, session.get("employee_id"), shift["id"] if shift else None,
                day["id"], str(data.get("payment_method", "نقدي")), paid_amount,
            ),
        )
        if order_status == "completed":
            add_cash_entry(
                db, day["id"], "sale", total, "مبيعات",
                "order", cursor.lastrowid, "بيع رقم " + str(cursor.lastrowid),
                shift_id=shift["id"] if shift else None, employee_id=session.get("employee_id"),
            )
        log_audit(
            db, "POST", "/api/orders", cursor.lastrowid,
            json.dumps(normalized, ensure_ascii=False),
            actor_id, actor_name, actor_role,
        )
        db.commit()
        return jsonify({
            "success": True, "order_id": cursor.lastrowid, "total_amount": total,
            "items": normalized,
        }), 201
    except (TypeError, ValueError, json.JSONDecodeError) as error:
        db.rollback()
        return api_error(str(error), 400)
    except sqlite3.IntegrityError as error:
        db.rollback()
        return api_error(str(error), 400)


def _void_order(order_id, reason, employee_name):
    db = get_db()
    if not reason:
        return api_error("سبب الاسترجاع مطلوب.", 400)
    if not employee_name:
        return api_error("اسم الموظف المنفذ مطلوب.", 400)
    order = db.execute("SELECT * FROM orders WHERE id = ?", (order_id,)).fetchone()
    if order is None:
        return api_error("العملية غير موجودة.", 404)
    if order["status"] == "cancelled":
        return api_error("العملية مسترجعة بالفعل.", 409)

    items = json.loads(order["items_json"] or "[]")
    for item in items:
        quantity = float(item["quantity"])
        kind = item["kind"]
        if kind == "book":
            db.execute("UPDATE books SET stock_quantity = stock_quantity + ? WHERE id = ?", (quantity, int(item["id"])))
        elif kind == "retail":
            db.execute("UPDATE retail SET stock_quantity = stock_quantity + ? WHERE id = ?", (quantity, int(item["id"])))
        elif kind == "drink":
            drink = db.execute("SELECT recipe_json FROM drinks WHERE id = ?", (int(item["id"]),)).fetchone()
            if drink:
                for ingredient in json.loads(drink["recipe_json"] or "[]"):
                    db.execute(
                        "UPDATE materials SET current_stock = current_stock + ? WHERE id = ?",
                        (float(ingredient["qty"]) * quantity, int(ingredient["material_id"])),
                    )

    employee = db.execute("SELECT id FROM employees WHERE username = ?", (employee_name.strip(),)).fetchone()
    db.execute(
        """UPDATE orders SET status = 'cancelled', cancelled_at = ?, cancel_reason = ?,
           performed_by = ?, performed_by_name = ?, performed_by_role = 'employee'
           WHERE id = ?""",
        (
            datetime.now().astimezone().isoformat(timespec="seconds"), reason,
            employee["id"] if employee else session.get("employee_id"),
            employee_name.strip(), order_id,
        ),
    )
    shift = request_employee_shift(db)
    add_cash_entry(
        db, order["business_day_id"], "refund", -float(order["total_amount"]),
        "استرجاع", "order_refund", order_id, reason,
        shift_id=shift["id"] if shift else None, employee_id=session.get("employee_id"),
    )
    db.commit()
    updated = db.execute("SELECT * FROM orders WHERE id = ?", (order_id,)).fetchone()
    payload = dict(updated)
    payload["items"] = json.loads(payload["items_json"])
    payload["total_amount"] = float(payload["total_amount"])
    return jsonify(payload)


@app.post("/api/orders/<int:order_id>/void")
@cashier_session_required
@selling_required
@open_shift_required
def void_selected_order(order_id):
    data = request.get_json(silent=True) or {}
    return _void_order(order_id, str(data.get("reason", "")).strip(), str(data.get("employee_name", "")).strip())


@app.post("/api/orders/void-last")
@cashier_session_required
@selling_required
@open_shift_required
def void_last_order():
    data = request.get_json(silent=True) or {}
    reason = str(data.get("reason", "")).strip()
    employee_name = str(data.get("employee_name", "")).strip()
    if not employee_name:
        return api_error("اسم الموظف المنفذ مطلوب.", 400)
    order = get_db().execute(
        "SELECT id FROM orders WHERE status = 'completed' ORDER BY id DESC LIMIT 1"
    ).fetchone()
    if order is None:
        return api_error("لا توجد عملية بيع للإرجاع.", 404)
    return _void_order(order["id"], reason, employee_name)


@app.get("/api/cashier/recent-orders")
@cashier_session_required
def recent_orders():
    query = str(request.args.get("q", "")).strip().casefold()
    rows = get_db().execute(
        "SELECT * FROM orders ORDER BY id DESC LIMIT 100"
    ).fetchall()
    result = []
    for row in rows:
        items = json.loads(row["items_json"] or "[]")
        haystack = " ".join(str(item.get("name", "")) for item in items).casefold()
        if query and query not in haystack:
            continue
        payload = dict(row)
        payload["items"] = items
        payload["total_amount"] = float(row["total_amount"])
        result.append(payload)
        if len(result) >= 20:
            break
    return jsonify(result)


@app.get("/api/orders/pending")
@cashier_session_required
def pending_orders():
    db = get_db()
    rows = db.execute(
        "SELECT * FROM orders WHERE status = 'pending' ORDER BY id DESC"
    ).fetchall()
    result = []
    for row in rows:
        item = dict(row)
        item["items"] = json.loads(row["items_json"] or "[]")
        item["employee_name"] = row["performed_by_name"] or "غير مسجل"
        result.append(item)
    return jsonify(result)


@app.post("/api/orders/<int:order_id>/complete")
@cashier_session_required
@selling_required
@open_shift_required
def complete_pending_order(order_id):
    db = get_db()
    order = db.execute("SELECT * FROM orders WHERE id = ? AND status = 'pending'", (order_id,)).fetchone()
    if order is None:
        return api_error("الطلب المعلق غير موجود.", 404)
    data = request.get_json(silent=True) or {}
    paid_amount = data.get("paid_amount")
    if paid_amount is None or (isinstance(paid_amount, str) and not paid_amount.strip()):
        paid_amount = float(order["total_amount"])
    else:
        try:
            paid_amount = positive_number(paid_amount, "المبلغ المستلم", True)
        except ValueError as error:
            return api_error(str(error), 400)
    items = json.loads(order["items_json"] or "[]")
    for item in items:
        if item["kind"] == "book":
            db.execute("UPDATE books SET stock_quantity = stock_quantity - ? WHERE id = ?", (float(item["quantity"]), int(item["id"])))
        elif item["kind"] == "retail":
            db.execute("UPDATE retail SET stock_quantity = stock_quantity - ? WHERE id = ?", (float(item["quantity"]), int(item["id"])))
        elif item["kind"] == "drink":
            drink = db.execute("SELECT recipe_json FROM drinks WHERE id = ?", (int(item["id"]),)).fetchone()
            if drink:
                for ingredient in json.loads(drink["recipe_json"] or "[]"):
                    db.execute("UPDATE materials SET current_stock = MAX(0, current_stock - ?) WHERE id = ?", (float(ingredient["qty"]) * float(item["quantity"]), int(ingredient["material_id"])))
    day = ensure_business_day(db)
    shift = request_employee_shift(db)
    db.execute(
        "UPDATE orders SET status = 'completed', payment_method = ?, paid_amount = ? WHERE id = ?",
        (str(data.get("payment_method") or "نقدي"), paid_amount, order_id),
    )
    add_cash_entry(db, day["id"], "sale", float(order["total_amount"]), "مبيعات", "order", order_id, "استكمال طلب معلق", shift_id=shift["id"] if shift else None, employee_id=session.get("employee_id"))
    db.commit()
    return jsonify({"success": True, "order_id": order_id})


@app.get("/api/stock-suggestions")
@cashier_session_required
def stock_suggestions():
    query = str(request.args.get("q", "")).strip().casefold()
    if len(query) < 2:
        return jsonify([])
    db = get_db()
    result = []
    for row in db.execute(
        "SELECT id, title AS name, sell_price, cost_price, stock_quantity, '' AS unit "
        "FROM books WHERE title LIKE ? LIMIT 10",
        ("%" + query + "%",),
    ).fetchall():
        result.append({
            "id": row["id"], "name": row["name"], "kind": "book",
            "kind_label": "كتاب", "stock": row["stock_quantity"], "unit": "نسخة",
            "unit_cost": row["cost_price"], "affects_stock": True,
        })
    for row in db.execute(
        "SELECT id, name, sell_price, cost_price, stock_quantity, unit FROM retail "
        "WHERE name LIKE ? LIMIT 10", ("%" + query + "%",)
    ).fetchall():
        result.append({
            "id": row["id"], "name": row["name"], "kind": "retail",
            "kind_label": "منتج جاهز", "stock": row["stock_quantity"], "unit": row["unit"],
            "unit_cost": row["cost_price"], "affects_stock": True,
        })
    for row in db.execute(
        "SELECT id, name, cost_per_unit, current_stock, unit, purchase_unit, usage_unit "
        "FROM materials WHERE name LIKE ? LIMIT 10", ("%" + query + "%",)
    ).fetchall():
        usage = row["usage_unit"] or row["unit"]
        result.append({
            "id": row["id"], "name": row["name"], "kind": "material",
            "kind_label": "مادة خام", "stock": row["current_stock"], "unit": usage,
            "unit_cost": row["cost_per_unit"], "affects_stock": True,
            "purchase_unit": row["purchase_unit"] or row["unit"],
        })
    for row in db.execute(
        "SELECT id, name, sell_price FROM drinks WHERE name LIKE ? LIMIT 10",
        ("%" + query + "%",),
    ).fetchall():
        result.append({
            "id": row["id"], "name": row["name"], "kind": "drink",
            "kind_label": "مشروب", "stock": None, "unit": "",
            "unit_cost": 0, "affects_stock": False,
        })
    return jsonify(result[:20])


@app.get("/api/categories/active")
@cashier_session_required
def active_categories():
    db = get_db()
    rows = db.execute(
        "SELECT slug, label_ar, scope, sort_order FROM categories "
        "WHERE is_active = 1 ORDER BY sort_order, id"
    ).fetchall()
    if not rows:
        rows = [
            {"slug": slug, "label_ar": label, "scope": scope, "sort_order": order}
            for slug, label, scope, order in CATEGORY_SEEDS
        ]
    return jsonify([dict(row) for row in rows])


@app.get("/api/products")
@cashier_session_required
def cashier_products():
    db = get_db()
    products = []
    for row in db.execute("SELECT id, title AS name, sell_price, stock_quantity, type, 'book' AS kind FROM books").fetchall():
        products.append({
            "id": row["id"], "name": row["name"], "sell_price": row["sell_price"],
            "stock_quantity": row["stock_quantity"], "kind": "book",
            "stock": row["stock_quantity"], "type": row["type"],
            "category": row["type"],
        })
    for row in db.execute("SELECT id, name, sell_price, category, recipe_json FROM drinks").fetchall():
        products.append({
            "id": row["id"], "name": row["name"], "sell_price": row["sell_price"],
            "stock_quantity": None, "kind": "drink", "category": row["category"],
            "recipe_json": row["recipe_json"],
        })
    for row in db.execute("SELECT id, name, sell_price, stock_quantity, category, unit FROM retail").fetchall():
        products.append({
            "id": row["id"], "name": row["name"], "sell_price": row["sell_price"],
            "stock_quantity": row["stock_quantity"], "kind": "retail",
            "category": row["category"], "unit": row["unit"],
        })
    return jsonify(products)


@app.get("/api/cashier/today-sales")
@cashier_session_required
def cashier_today_sales():
    summary = today_sales_summary(get_db())
    return jsonify(summary)


@app.get("/api/admin/dashboard")
@admin_required
def admin_dashboard_api():
    db = get_db()
    summary = today_sales_summary(db)
    low_stock = []
    for material in db.execute("SELECT * FROM materials").fetchall():
        if float(material["current_stock"]) <= float(material["reorder_level"]):
            low_stock.append({
                "id": material["id"], "name": material["name"],
                "current_stock": material["current_stock"],
                "reorder_level": material["reorder_level"],
                "unit": material["unit"],
            })
    summary["low_stock"] = low_stock
    return jsonify(summary)


@app.get("/api/categories")
@admin_required
def list_categories():
    db = get_db()
    ensure_category_defaults(db)
    rows = db.execute("SELECT * FROM categories ORDER BY scope, sort_order, id").fetchall()
    result = []
    for row in rows:
        item = dict(row)
        usage = category_usage_counts(db, item["slug"])
        item["drink_count"] = usage["drink"]
        item["retail_count"] = usage["retail"]
        item["product_count"] = usage["drink"] + usage["retail"]
        item["product_scope"] = (
            "drink" if usage["drink"] else "retail" if usage["retail"] else None
        ) if not (usage["drink"] and usage["retail"]) else None
        result.append(item)
    return jsonify(result)


def category_usage_counts(db, slug):
    return {
        "drink": db.execute(
            "SELECT COUNT(*) AS count FROM drinks WHERE category = ?", (slug,)
        ).fetchone()["count"],
        "retail": db.execute(
            "SELECT COUNT(*) AS count FROM retail WHERE category = ?", (slug,)
        ).fetchone()["count"],
    }


@app.route("/api/categories/<int:item_id>", methods=["PUT", "DELETE"])
@admin_required
def edit_category(item_id):
    db = get_db()
    row = db.execute("SELECT * FROM categories WHERE id = ?", (item_id,)).fetchone()
    if row is None:
        return api_error("التصنيف غير موجود.", 404)
    if request.method == "DELETE":
        target_slug = str(request.args.get("reassign_to") or "").strip()
        usage = category_usage_counts(db, row["slug"])
        product_count = usage["drink"] + usage["retail"]
        product_scope = (
            "drink" if usage["drink"] else "retail" if usage["retail"] else None
        ) if not (usage["drink"] and usage["retail"]) else None

        if product_count and not target_slug:
            return api_error("التصنيف مرتبط بأصناف. انقلها إلى تصنيف بديل أو عطّل التصنيف.", 409)
        if product_count and product_scope is None:
            return api_error(
                "التصنيف مرتبط بأكثر من نوع من الأصناف. افصل ارتباطاتها أو عطّل التصنيف بدل نقله دفعة واحدة.",
                409,
            )

        db.execute("BEGIN IMMEDIATE")
        if product_count:
            target = db.execute(
                "SELECT id FROM categories WHERE slug = ? AND scope = ? AND is_active = 1 AND id != ?",
                (target_slug, product_scope, item_id),
            ).fetchone()
            if target is None:
                db.rollback()
                return api_error("التصنيف البديل غير موجود أو غير نشط أو من نوع مختلف.", 400)
            db.execute(
                "UPDATE " + ("drinks" if product_scope == "drink" else "retail") +
                " SET category = ? WHERE category = ?",
                (target_slug, row["slug"]),
            )
        db.execute("DELETE FROM categories WHERE id = ?", (item_id,))
        db.commit()
        return jsonify({"ok": True, "reassigned": product_count})
    data = request.get_json(silent=True) or {}
    label = str(data.get("label_ar", row["label_ar"])).strip()
    scope = str(data.get("scope", row["scope"])).strip()
    if not label:
        return api_error("اسم التصنيف مطلوب.", 400)
    if scope not in ("drink", "retail"):
        return api_error("نوع التصنيف غير صالح.", 400)
    try:
        sort_order = int(data.get("sort_order", row["sort_order"]))
    except (TypeError, ValueError):
        return api_error("ترتيب التصنيف يجب أن يكون رقمًا.", 400)
    usage = category_usage_counts(db, row["slug"])
    product_count = usage["drink"] + usage["retail"]
    product_scope = (
        "drink" if usage["drink"] else "retail" if usage["retail"] else None
    ) if not (usage["drink"] and usage["retail"]) else None
    if scope != row["scope"] and product_count and scope != product_scope:
        return api_error(
            "لا يمكن تغيير نوع التصنيف بما يفصل أصنافه عنه. اختر نوع الأصناف المرتبطة أو انقلها أولًا.",
            409,
        )
    db.execute(
        "UPDATE categories SET label_ar = ?, scope = ?, sort_order = ?, is_active = ? WHERE id = ?",
        (label, scope, sort_order, int(bool(data.get("is_active", row["is_active"]))), item_id),
    )
    db.commit()
    return jsonify({"ok": True})


@app.post("/api/categories/<int:item_id>/move")
@admin_required
def move_category(item_id):
    db = get_db()
    row = db.execute("SELECT * FROM categories WHERE id = ?", (item_id,)).fetchone()
    if row is None:
        return api_error("التصنيف غير موجود.", 404)
    direction = str((request.get_json(silent=True) or {}).get("direction", "")).strip()
    neighbor = db.execute(
        "SELECT * FROM categories WHERE scope = ? AND sort_order "
        + ("<" if direction == "up" else ">")
        + " ? ORDER BY sort_order " + ("DESC" if direction == "up" else "ASC") + " LIMIT 1",
        (row["scope"], row["sort_order"]),
    ).fetchone()
    if neighbor:
        db.execute("UPDATE categories SET sort_order = ? WHERE id = ?", (neighbor["sort_order"], row["id"]))
        db.execute("UPDATE categories SET sort_order = ? WHERE id = ?", (row["sort_order"], neighbor["id"]))
    db.commit()
    return jsonify({"ok": True})


@app.post("/api/categories")
def create_category():
    if not session.get("admin_id"):
        return api_error("تسجيل التصنيف متاح للمسؤول فقط.", 401)
    data = request.get_json(silent=True) or {}
    label = str(data.get("label_ar", "")).strip()
    scope = str(data.get("scope", "")).strip()
    if not label:
        return api_error("اسم التصنيف مطلوب.", 400)
    if scope not in ("drink", "retail"):
        return api_error("نطاق التصنيف غير صالح.", 400)
    try:
        sort_order = int(data.get("sort_order", 100))
    except (TypeError, ValueError):
        return api_error("ترتيب التصنيف يجب أن يكون رقمًا.", 400)
    slug = unicodedata.normalize("NFKC", label).strip().lower().replace(" ", "-")
    if not slug:
        return api_error("اسم التصنيف غير صالح.", 400)
    db = get_db()
    if db.execute("SELECT 1 FROM categories WHERE slug = ?", (slug,)).fetchone():
        return api_error("التصنيف موجود بالفعل.", 409)
    cursor = db.execute(
        "INSERT INTO categories(slug, label_ar, scope, sort_order, is_active, created_at) VALUES (?, ?, ?, ?, 1, ?)",
        (slug, label, scope, sort_order, datetime.now().astimezone().isoformat(timespec="seconds")),
    )
    db.commit()
    return jsonify({"id": cursor.lastrowid, "slug": slug, "label_ar": label, "scope": scope, "sort_order": sort_order}), 201


@app.get("/api/cashier/notifications")
@cashier_session_required
def cashier_notifications():
    db = get_db()
    alerts = []
    for material in db.execute("SELECT * FROM materials").fetchall():
        stock = float(material["current_stock"])
        reorder = float(material["reorder_level"])
        if stock <= 0:
            alerts.append({"kind": "out_of_stock", "severity": "danger", "label": material["name"], "message": "المادة نفدت من المخزون"})
        elif stock <= reorder:
            alerts.append({"kind": "low_stock", "severity": "warning", "label": material["name"], "message": "المادة قاربت على النفاد"})
    for drink in db.execute("SELECT * FROM drinks").fetchall():
        try:
            recipe = json.loads(drink["recipe_json"] or "[]")
            available = True
            for ingredient in recipe:
                material = db.execute("SELECT current_stock FROM materials WHERE id = ?", (int(ingredient["material_id"]),)).fetchone()
                if material is None or float(material["current_stock"]) + 1e-9 < float(ingredient["qty"]):
                    available = False
                    break
        except (TypeError, ValueError, json.JSONDecodeError):
            available = False
        if not available:
            alerts.append({"kind": "unavailable_drink", "severity": "danger", "label": drink["name"], "message": "المشروب غير متاح حاليًا"})
    alerts.sort(key=lambda alert: 0 if alert["severity"] == "danger" else 1)
    return jsonify({
        "alerts": alerts,
        "count": len(alerts),
        "danger_count": sum(1 for alert in alerts if alert["severity"] == "danger"),
    })


@app.get("/api/search")
@cashier_session_required
def search_system():
    query = str(request.args.get("q", "")).strip().casefold()
    scope = str(request.args.get("scope", "")).strip().lower()
    if not query:
        return jsonify([])
    results = []

    is_admin = bool(session.get("admin_id"))
    db = get_db()
    employee = None
    if session.get("employee_id"):
        employee = db.execute(
            "SELECT * FROM employees WHERE id = ? AND is_active = 1",
            (session["employee_id"],),
        ).fetchone()
    can_inventory = is_admin or bool(employee and employee["can_manage_inventory"])
    can_expenses = is_admin or bool(employee and employee["can_manage_expenses"])
    can_sell = is_admin or bool(employee and employee["can_sell"])

    if scope == "cashier":
        results = []
        catalog = (
            ("books", "title", "author", "الكتب"),
            ("drinks", "name", None, "المشروبات"),
            ("retail", "name", None, "المنتجات الجاهزة"),
        )
        for table, name_column, detail_column, path in catalog:
            columns = "id, " + name_column
            if detail_column:
                columns += ", " + detail_column
            rows = db.execute("SELECT " + columns + " FROM " + table + " ORDER BY id DESC LIMIT 500").fetchall()
            for row in rows:
                label = str(row[name_column] or "")
                detail = str(row[detail_column] or "") if detail_column else ""
                if query not in (label + " " + detail).casefold():
                    continue
                results.append({
                    "type": "product",
                    "label": label,
                    "path": "نقطة البيع / " + path,
                    "view": "pos",
                    "query": label,
                })
                if len(results) >= 20:
                    return jsonify(results)
        return jsonify(results)

    if scope == "admin":
        admin_pages = []
        if is_admin:
            admin_pages = [
                ("لوحة المعلومات", "الإدارة / لوحة المعلومات", "dashboard", "الرئيسية مؤشرات"),
                ("الكتب", "الإدارة / الكتب", "books", "مخزون كتب"),
                ("المشروبات", "الإدارة / المشروبات", "drinks", "مشروب"),
                ("المواد الخام", "الإدارة / المواد الخام", "materials", "مواد خام مخزون"),
                ("منتجات جاهزة", "الإدارة / منتجات جاهزة", "retail", "منتجات"),
                ("الأقسام والتصنيفات", "الإدارة / الأقسام والتصنيفات", "categories", "تصنيف فئة قسم"),
                ("الموظفون", "الإدارة / الموظفين", "employees", "الموظفين موظف عامل"),
                ("الحضور والورديات", "الإدارة / الحضور والورديات", "attendance", "حضور وردية دوام"),
                ("الرواتب", "الإدارة / الرواتب", "payroll", "راتب أجور"),
                ("تقرير المشاريع", "الإدارة / تقرير المشاريع", "projects", "تقرير أرباح مبيعات يوم شهر سجل"),
                ("الإعدادات", "الإدارة / الإعدادات", "settings", "كلمة مرور متجر"),
                ("تفريغ البيانات", "الإدارة / تفريغ البيانات", "purge", "حذف بيانات"),
            ]
        else:
            if can_inventory:
                admin_pages.extend([
                    ("الكتب", "الإدارة / الكتب", "books", "مخزون كتب"),
                    ("المشروبات", "الإدارة / المشروبات", "drinks", "مشروب"),
                    ("المواد الخام", "الإدارة / المواد الخام", "materials", "مواد خام مخزون"),
                    ("منتجات جاهزة", "الإدارة / منتجات جاهزة", "retail", "منتجات"),
                    ("الأقسام والتصنيفات", "الإدارة / الأقسام والتصنيفات", "categories", "تصنيف فئة قسم"),
                ])
            if can_expenses:
                admin_pages.append(("المصروفات", "الإدارة / المصروفات", "reports", "مصروفات فواتير"))

        results = [
            {"type": "page", "label": label, "path": path, "view": view}
            for label, path, view, keywords in admin_pages
            if query in (label + " " + keywords).casefold()
        ]

        catalog = (
            ("books", "title", "author", "الكتب"),
            ("drinks", "name", None, "المشروبات"),
            ("retail", "name", None, "المنتجات الجاهزة"),
        )
        if can_inventory:
            catalog += (("materials", "name", None, "المواد الخام"),)
        for table, name_column, detail_column, path in catalog:
            columns = "id, " + name_column
            if detail_column:
                columns += ", " + detail_column
            rows = db.execute("SELECT " + columns + " FROM " + table + " ORDER BY id DESC LIMIT 500").fetchall()
            for row in rows:
                label = str(row[name_column] or "")
                detail = str(row[detail_column] or "") if detail_column else ""
                if query not in (label + " " + detail).casefold():
                    continue
                results.append({
                    "type": "product",
                    "label": label,
                    "path": "الإدارة / " + path,
                    "view": table,
                    "query": label,
                })
                if len(results) >= 20:
                    return jsonify(results)

        if can_inventory:
            categories = db.execute(
                "SELECT slug, label_ar FROM categories WHERE label_ar LIKE ? OR slug LIKE ? ORDER BY sort_order LIMIT 10",
                ("%" + query + "%", "%" + query + "%"),
            ).fetchall()
            results.extend({
                "type": "category",
                "label": row["label_ar"],
                "path": "الإدارة / التصنيفات",
                "view": "categories",
            } for row in categories)

        pattern = "%" + query + "%"
        if can_expenses:
            expenses = db.execute(
                "SELECT id, date, category, note FROM expenses WHERE date LIKE ? OR category LIKE ? OR note LIKE ? ORDER BY date DESC, id DESC LIMIT 10",
                (pattern, pattern, pattern),
            ).fetchall()
            results.extend({
                "type": "expense",
                "label": "مصروف " + row["category"] + " · " + row["date"],
                "path": "الإدارة / تقرير المشاريع",
                "view": "reports",
            } for row in expenses)
            purchases = db.execute(
                "SELECT id, timestamp, supplier, category, note FROM purchases WHERE timestamp LIKE ? OR supplier LIKE ? OR category LIKE ? OR note LIKE ? ORDER BY timestamp DESC, id DESC LIMIT 10",
                (pattern, pattern, pattern, pattern),
            ).fetchall()
            results.extend({
                "type": "purchase",
                "label": "مشتريات " + (row["supplier"] or row["category"]) + " · " + row["timestamp"][:10],
                "path": "الإدارة / تقرير المشاريع",
                "view": "reports",
            } for row in purchases)

        if is_admin:
            rows = db.execute(
                "SELECT id, username FROM employees WHERE username LIKE ? ORDER BY username LIMIT 10",
                ("%" + query + "%",),
            ).fetchall()
            results.extend({
                "type": "employee",
                "label": row["username"],
                "path": "الإدارة / الموظفون",
                "view": "employees",
            } for row in rows)

        if can_sell or is_admin:
            if query.isdigit():
                rows = db.execute(
                    "SELECT id, status FROM orders WHERE id = ? LIMIT 5", (int(query),)
                ).fetchall()
                results.extend({
                    "type": "order",
                    "label": "عملية بيع #" + str(row["id"]),
                    "path": "الإدارة / تقرير المشاريع",
                    "view": "projects",
                } for row in rows)
    if not scope:
        if "مشاريع" in query or "project" in query:
            results.append({
                "type": "page",
                "label": "تقرير المشاريع",
                "path": "الإدارة / تقرير المشاريع",
                "view": "projects",
            })
        if "حضور" in query or "attendance" in query:
            results.append({
                "type": "page",
                "label": "الحضور والورديات",
                "path": "الإدارة / الحضور والورديات",
                "view": "attendance",
            })
        if "موظف" in query or "employee" in query:
            results.append({
                "type": "page",
                "label": "الموظفون",
                "path": "الإدارة / الموظفون",
                "view": "employees",
            })
        for table, name_column, view_name in (
            ("books", "title", "books"),
            ("drinks", "name", "drinks"),
            ("retail", "name", "retail"),
            ("materials", "name", "materials"),
        ):
            rows = db.execute(
                "SELECT id, " + name_column + " AS label FROM " + table
                + " WHERE " + name_column + " LIKE ? LIMIT 10",
                ("%" + query + "%",),
            ).fetchall()
            results.extend({
                "type": "product",
                "label": row["label"],
                "path": "الإدارة",
                "view": view_name,
                "query": row["label"],
            } for row in rows)
        if "search expense" in query or "expense" in query:
            results.append({
                "type": "expense",
                "label": "مصروف",
                "path": "الإدارة / تقرير المشاريع",
                "view": "reports",
            })
    return jsonify(results[:20])




def intake_manager_required(function):
    @wraps(function)
    def wrapped(*args, **kwargs):
        if session.get("admin_id"):
            return function(*args, **kwargs)
        employee_id=session.get("employee_id")
        if not employee_id:
            return api_error("يرجى تسجيل الدخول للمتابعة.",401)
        employee=get_db().execute("SELECT * FROM employees WHERE id=? AND is_active=1",(employee_id,)).fetchone()
        if employee is None:
            session.clear(); return api_error("حساب الموظف غير نشط.",403)
        if not employee["can_manage_purchases"]:
            return api_error("لا تملك صلاحية تسجيل البضاعة.",403)
        return function(*args,**kwargs)
    return wrapped

def load_intake_lines(db,raw):
    try: lines=json.loads(raw or "[]")
    except (TypeError,ValueError): return []
    return lines if isinstance(lines,list) else []

def normalize_intake_line(db,entry):
    kind=str(entry.get("kind","")).strip()
    try:
        pid=int(entry.get("id")); qty=float(entry.get("quantity") or 0); cost=float(entry.get("unit_cost") or 0)
    except (TypeError,ValueError): raise ValueError("بيانات صنف البضاعة غير صالحة.")
    if qty<=0:
        raise ValueError("الكمية يجب أن تكون أكبر من صفر.")
    if "unit_cost" not in entry:
        raise ValueError("تكلفة الوحدة مطلوبة وإجبارية.")
    if cost <= 0:
        raise ValueError("تكلفة الوحدة يجب أن تكون أكبر من صفر.")
    table={"book":"books","drink":"drinks","retail":"retail","material":"materials"}.get(kind)
    if table is None: raise ValueError("نوع صنف البضاعة غير معروف.")
    name_col="title" if kind=="book" else "name"
    row=db.execute("SELECT *,"+name_col+" AS item_name FROM "+table+" WHERE id=?",(pid,)).fetchone()
    if row is None: raise ValueError("الصنف غير موجود.")
    return {"kind":kind,"id":pid,"name":row["item_name"],"quantity":qty,"unit_cost":cost,"line_total":round(qty*cost,2)}

def create_purchase_record(db,body,lines,amount,paid_from_drawer):
    day=ensure_business_day(db); shift=request_employee_shift(db)
    eid=shift["employee_id"] if shift else None; sid=shift["id"] if shift else None
    now=datetime.now().astimezone().isoformat(timespec="seconds")
    supplier=str(body.get("supplier") or "")
    cur=db.execute("INSERT INTO purchases(business_day_id,shift_id,employee_id,timestamp,supplier,category,amount,items_json,note,date) VALUES(?,?,?,?,?,?,?,?,?,?)",(day["id"],sid,eid,now,supplier,"بضاعة واردة",amount,json.dumps(lines,ensure_ascii=False),str(body.get("note") or ""),str(body.get("date") or now[:10])))
    pid=cur.lastrowid
    for line in lines:
        kind=line["kind"]
        if kind=="book": db.execute("UPDATE books SET stock_quantity=stock_quantity+? WHERE id=?",(line["quantity"],line["id"]))
        elif kind=="retail": db.execute("UPDATE retail SET stock_quantity=stock_quantity+? WHERE id=?",(line["quantity"],line["id"]))
        elif kind=="material":
            material = db.execute("SELECT unit, purchase_unit FROM materials WHERE id = ?", (line["id"],)).fetchone()
            stock_unit = material["unit"]
            purchase_unit = material["purchase_unit"] or stock_unit
            quantity = convert_material_quantity(db, line["id"], line["quantity"], purchase_unit, stock_unit)
            db.execute("UPDATE materials SET current_stock=current_stock+? WHERE id=?",(quantity,line["id"]))
    expense_id=None
    if paid_from_drawer:
        expense_id=db.execute("INSERT INTO expenses(date,category,amount,note,business_day_id,shift_id,employee_id,purchase_id) VALUES(?,?,?,?,?,?,?,?)",(str(body.get("date") or now[:10]),"تسجيل بضاعة",amount,"شراء بضاعة",day["id"],sid,eid,pid)).lastrowid
        add_cash_entry(db,day["id"],"expense",-amount,"بضاعة واردة","purchase",pid,"دفعة تسجيل بضاعة",shift_id=sid,employee_id=eid)
    return pid,expense_id

def drop_purchase_record(db,purchase_id):
    row=db.execute("SELECT * FROM purchases WHERE id=?",(purchase_id,)).fetchone()
    if row is None: return False
    for line in load_intake_lines(db,row["items_json"]):
        kind=line.get("kind"); qty=float(line.get("quantity") or 0); pid=int(line.get("id") or 0)
        if kind=="book": db.execute("UPDATE books SET stock_quantity=MAX(0,stock_quantity-?) WHERE id=?",(qty,pid))
        elif kind=="retail": db.execute("UPDATE retail SET stock_quantity=MAX(0,stock_quantity-?) WHERE id=?",(qty,pid))
        elif kind=="material":
            material = db.execute("SELECT unit, purchase_unit FROM materials WHERE id = ?", (pid,)).fetchone()
            if material:
                stock_unit = material["unit"]
                purchase_unit = material["purchase_unit"] or stock_unit
                qty = convert_material_quantity(db, pid, qty, purchase_unit, stock_unit)
            db.execute("UPDATE materials SET current_stock=MAX(0,current_stock-?) WHERE id=?",(qty,pid))
    db.execute("DELETE FROM expenses WHERE purchase_id=?",(purchase_id,)); db.execute("DELETE FROM cash_entries WHERE reference_type='purchase' AND reference_id=?",(purchase_id,)); db.execute("DELETE FROM purchases WHERE id=?",(purchase_id,))
    return True

@app.get("/api/purchases")
@cashier_session_required
def list_purchases():
    db = get_db()
    day = str(request.args.get("date") or "").strip()
    statement = """SELECT p.*, COALESCE(e.username, '') AS employee_name,
                          (SELECT id FROM expenses x WHERE x.purchase_id = p.id LIMIT 1) AS expense_id
                   FROM purchases p LEFT JOIN employees e ON e.id = p.employee_id"""
    arguments = []
    if day:
        statement += " WHERE substr(p.timestamp, 1, 10) = ?"
        arguments.append(day)
    statement += " ORDER BY p.timestamp DESC, p.id DESC LIMIT 200"
    rows = db.execute(statement, arguments).fetchall()
    payload = []
    for row in rows:
        item = dict(row)
        item["items"] = load_intake_lines(db, item.pop("items_json", "[]"))
        payload.append(item)
    return jsonify(payload)


@app.post("/api/purchases")
@intake_manager_required
@open_shift_required
def create_purchase():
    body = request.get_json(silent=True) or {}
    if not isinstance(body, dict):
        return api_error("بيانات تسجيل البضاعة غير صالحة.")
    raw_items = body.get("items")
    if not isinstance(raw_items, list) or not raw_items:
        return api_error("اختر صنفًا واحدًا على الأقل لتسجيله.")
    if len(raw_items) > 50:
        return api_error("عدد الأصناف في التسجيل أكبر من المسموح.")
    db = get_db()
    try:
        db.execute("BEGIN IMMEDIATE")
        lines = [normalize_intake_line(db, entry) for entry in raw_items]
        amount = round(sum(line["line_total"] for line in lines), 2)
        paid_from_drawer = bool(body.get("paid_from_drawer"))
        purchase_id, expense_id = create_purchase_record(db, body, lines, amount, paid_from_drawer)
        db.commit()
        return jsonify({"id": purchase_id, "expense_id": expense_id, "amount": amount}), 201
    except ValueError as error:
        db.rollback()
        return api_error(str(error))
    except Exception:
        db.rollback()
        app.logger.exception("Unexpected error saving a purchase record")
        return api_error("حدث خطأ أثناء تسجيل البضاعة.", 500)


@app.delete("/api/purchases/<int:purchase_id>")
@intake_manager_required
@open_shift_required
def delete_purchase(purchase_id):
    db = get_db()
    try:
        db.execute("BEGIN IMMEDIATE")
        if not drop_purchase_record(db, purchase_id):
            db.rollback()
            return api_error("السجل غير موجود.", 404)
        db.commit()
        return jsonify({"ok": True})
    except ValueError as error:
        db.rollback()
        return api_error(str(error))
    except Exception:
        db.rollback()
        app.logger.exception("Unexpected error deleting a purchase record")
        return api_error("حدث خطأ أثناء حذف تسجيل البضاعة.", 500)


@app.get("/api/admin/<resource>")
@inventory_or_expense_manager_required
def list_admin_resource(resource):
    if resource not in ("books", "drinks", "materials", "retail", "expenses"):
        return api_error("المورد المطلوب غير معروف.", 404)
    db = get_db()
    order_by = {
        "books": "id DESC",
        "drinks": "id DESC",
        "materials": "id DESC",
        "retail": "id DESC",
        "expenses": "date DESC, id DESC",
    }[resource]
    rows = db.execute("SELECT * FROM " + resource + " ORDER BY " + order_by).fetchall()
    payload = []
    for row in rows:
        item = dict(row)
        if resource == "materials":
            base_unit = normalize_material_unit(item.get("unit")) or item.get("unit")
            purchase_unit = normalize_optional_material_unit(item.get("purchase_unit"), base_unit)
            usage_unit = normalize_optional_material_unit(item.get("usage_unit"), base_unit)
            item["purchase_unit"] = purchase_unit
            item["usage_unit"] = usage_unit
            item["purchase_unit_label"] = material_unit_label(purchase_unit)
            item["usage_unit_label"] = material_unit_label(usage_unit)
            item["reorder_unit_label"] = material_unit_label(usage_unit)
            item["unit_label"] = material_unit_label(base_unit)
        payload.append(item)
    return jsonify(payload)


@app.get("/api/admin/payroll")
@admin_required
def list_admin_payroll():
    db = get_db()
    month = str(request.args.get("month") or date.today().strftime("%Y-%m")).strip()
    try:
        datetime.strptime(month, "%Y-%m")
    except ValueError:
        return api_error("صيغة الشهر يجب أن تكون سنة-شهر.")
    rows = db.execute(
        "SELECT id, username, monthly_salary FROM employees WHERE is_active = 1 ORDER BY username"
    ).fetchall()
    result = []
    for employee in rows:
        shifts = db.execute(
            "SELECT COALESCE(SUM(worked_seconds), 0) AS worked, COUNT(*) AS count "
            "FROM shifts WHERE employee_id = ? AND substr(started_at, 1, 7) = ?",
            (employee["id"], month),
        ).fetchone()
        settlement = db.execute(
            "SELECT * FROM payroll_settlements WHERE employee_id = ? AND month = ?",
            (employee["id"], month),
        ).fetchone()
        result.append({
            "employee_id": employee["id"],
            "username": employee["username"],
            "monthly_salary": employee["monthly_salary"],
            "worked_seconds": shifts["worked"],
            "completed_shifts": shifts["count"],
            "month": month,
            "settlement": dict(settlement) if settlement else None,
        })
    entries = []
    total = 0.0
    scheduled = configured_shift_seconds(db)
    for row in result:
        settlement = row["settlement"]
        amount = round(
            float(row["monthly_salary"]) * int(row["worked_seconds"]) / max(scheduled, 1),
            2,
        )
        if settlement:
            amount = float(settlement["amount"])
        total += amount
        entries.append({
            "employee_id": row["employee_id"],
            "username": row["username"],
            "monthly_salary": row["monthly_salary"],
            "worked_seconds": row["worked_seconds"],
            "completed_shifts": row["completed_shifts"],
            "amount": amount,
            "settlement": settlement,
        })
    return jsonify({"entries": entries, "total": round(total, 2), "month": month})


@app.post("/api/admin/payroll/settle")
@admin_required
def settle_payroll():
    db = get_db()
    data = request.get_json(silent=True) or {}
    month = str((data.get("month") if isinstance(data, dict) else None) or request.args.get("month") or date.today().strftime("%Y-%m")).strip()
    entries = list_admin_payroll().get_json()
    for entry in entries["entries"]:
        employee = db.execute("SELECT * FROM employees WHERE id = ?", (entry["employee_id"],)).fetchone()
        db.execute(
            """INSERT OR REPLACE INTO payroll_settlements
               (employee_id, month, monthly_salary, worked_seconds, scheduled_seconds,
                completed_shifts, amount, paid_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                entry["employee_id"], month, employee["monthly_salary"],
                entry["worked_seconds"], configured_shift_seconds(db),
                entry["completed_shifts"], entry["amount"],
                datetime.now().astimezone().isoformat(timespec="seconds"),
            ),
        )
    db.commit()
    return jsonify({"ok": True})


@app.get("/api/admin/expense-categories")
@inventory_or_expense_manager_required
def list_expense_categories():
    db = get_db()
    db.execute(
        "CREATE TABLE IF NOT EXISTS expense_categories "
        "(id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, sort_order INTEGER NOT NULL DEFAULT 100, "
        "is_active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL)"
    )
    db.commit()
    rows = db.execute(
        "SELECT name FROM expense_categories WHERE is_active = 1 "
        "UNION SELECT category AS name FROM expenses WHERE TRIM(category) != '' "
        "ORDER BY name"
    ).fetchall()
    if not rows:
        rows = [{"name": name} for name in (
            "كهرباء", "مياه", "صيانة", "إنترنت", "سكر", "لبن",
            "قهوة", "مشتريات", "رواتب", "إيجار", "نظافة",
        )]
    return jsonify([{"name": row["name"]} for row in rows])


@app.post("/api/admin/expense-categories")
@inventory_or_expense_manager_required
def create_expense_category():
    db = get_db()
    db.execute(
        "CREATE TABLE IF NOT EXISTS expense_categories "
        "(id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, sort_order INTEGER NOT NULL DEFAULT 100, "
        "is_active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL)"
    )
    name = str((request.get_json(silent=True) or {}).get("name", "")).strip()
    if not name:
        return api_error("اسم بند المصروف مطلوب.")
    try:
        db.execute(
            "INSERT OR IGNORE INTO expense_categories(name, sort_order, is_active, created_at) "
            "VALUES (?, 100, 1, ?)",
            (name, datetime.now().astimezone().isoformat(timespec="seconds")),
        )
        db.commit()
    except sqlite3.IntegrityError:
        db.rollback()
    return jsonify({"name": name})


@app.post("/api/admin/<resource>")
@inventory_or_expense_manager_required
@open_shift_required
def create_admin_resource(resource):
    if resource not in ("books", "drinks", "materials", "retail", "expenses"):
        return api_error("المورد المطلوب غير معروف.", 404)
    db = get_db()
    try:
        payload = request.get_json(silent=True) or {}
        values = resource_values(resource, payload)
        fields = {
            "books": "title, author, publisher, type, cost_price, sell_price, stock_quantity",
            "drinks": "name, sell_price, recipe_json, category", # Updated fields
            "materials": "name, unit, cost_per_unit, current_stock, reorder_level",
            "retail": "name, category, cost_price, sell_price, stock_quantity, unit",
            "expenses": "date, category, amount, note",
        }[resource]
        placeholders = ", ".join("?" for _ in values)
        cursor = db.execute(
            "INSERT INTO " + resource + "(" + fields + ") VALUES (" + placeholders + ")", values
        )
        if resource == "materials":
            base_unit = normalize_material_unit(payload.get("unit")) or "pcs"
            purchase_unit = normalize_optional_material_unit(payload.get("purchase_unit"), base_unit)
            usage_unit = normalize_optional_material_unit(payload.get("usage_unit"), base_unit)
            db.execute(
                "UPDATE materials SET purchase_unit = ?, usage_unit = ? WHERE id = ?",
                (purchase_unit, usage_unit, cursor.lastrowid),
            )
        purchase_id = None
        if resource == "expenses":
            record_expense_shift_link(db, cursor.lastrowid, *values)
            if "stock_item" in payload:
                purchase_id = sync_expense_intake(
                    db, cursor.lastrowid, *values, stock_item=payload.get("stock_item")
                )
            elif "new_stock_item" in payload:
                new_item = payload["new_stock_item"]
                if isinstance(new_item, dict):
                    purchase_id = sync_expense_intake(
                        db, cursor.lastrowid, *values, stock_item=dict(new_item, id=0)
                    )
        db.commit()
        return jsonify({"id": cursor.lastrowid, "purchase_id": purchase_id}), 201
    except (ValueError, TypeError, KeyError, json.JSONDecodeError, sqlite3.IntegrityError) as error:
        db.rollback()
        return api_error(str(error))

@app.route("/api/admin/<resource>/<int:item_id>", methods=["PUT", "DELETE"])
@inventory_or_expense_manager_required
@open_shift_required
def edit_admin_resource(resource, item_id):
    if resource not in ("books", "drinks", "materials", "retail", "expenses"):
        return api_error("المورد المطلوب غير معروف.", 404)
    db = get_db()
    if request.method == "DELETE":
        try:
            if resource == "materials":
                recipes = db.execute("SELECT recipe_json FROM drinks").fetchall()
                for row in recipes:
                    try:
                        recipe = json.loads(row["recipe_json"])
                    except json.JSONDecodeError:
                        continue
                    if isinstance(recipe, list) and any(
                        isinstance(item, dict) and str(item.get("material_id")) == str(item_id)
                        for item in recipe
                    ):
                        return api_error("لا يمكن حذف هذه المادة لأنها مستخدمة في وصفة مشروب.", 409)
            expense_purchase_id = None
            expense_purchase_items = "[]"
            if resource == "expenses":
                linked = db.execute(
                    """SELECT p.id, p.items_json FROM purchases p
                       JOIN expenses x ON x.purchase_id = p.id WHERE x.id = ?""",
                    (item_id,),
                ).fetchone()
                if linked is not None:
                    expense_purchase_id, expense_purchase_items = linked["id"], linked["items_json"]
            cursor = db.execute("DELETE FROM " + resource + " WHERE id = ?", (item_id,))
            if cursor.rowcount == 0:
                return api_error("السجل غير موجود.", 404)
            if resource == "materials":
                base_unit = values[1]
                db.execute(
                    "UPDATE materials SET purchase_unit = ?, usage_unit = ? WHERE id = ?",
                    (
                        normalize_optional_material_unit(payload.get("purchase_unit"), base_unit),
                        normalize_optional_material_unit(payload.get("usage_unit"), base_unit),
                        item_id,
                    ),
                )
            if resource == "expenses":
                if expense_purchase_id:
                    apply_intake_lines(
                        db,
                        load_intake_lines(db, expense_purchase_items),
                        -1,
                    )
                    db.execute("DELETE FROM purchases WHERE id = ?", (expense_purchase_id,))
                db.execute(
                    "DELETE FROM cash_entries WHERE reference_type = 'expense' AND reference_id = ?",
                    (item_id,),
                )
            db.commit()
            return jsonify({"ok": True})
        except sqlite3.IntegrityError:
            db.rollback()
            return api_error("لا يمكن حذف هذه المادة لأنها مستخدمة في وصفة مشروب.", 409)
    try:
        payload = request.get_json(silent=True) or {}
        values = resource_values(resource, payload)
        if resource == "materials":
            current = db.execute("SELECT unit FROM materials WHERE id = ?", (item_id,)).fetchone()
            if current is not None and current["unit"] != values[1]:
                factor = material_unit_conversion_factor(current["unit"], values[1])
                if material_recipe_usage(db, item_id) and (factor is None or abs(factor - 1.0) > 1e-9):
                    return api_error(
                        "لا يمكن تغيير وحدة هذه المادة لأنها مستخدمة في وصفة مشروب؛ "
                        "سيؤدي ذلك إلى تغيير مقادير الوصفة. أنشئ مادة جديدة بالوحدة المطلوبة.",
                        409,
                    )
        fields = {
            "books": "title, author, publisher, type, cost_price, sell_price, stock_quantity",
            "drinks": "name, sell_price, recipe_json, category", # Updated fields
            "materials": "name, unit, cost_per_unit, current_stock, reorder_level",
            "retail": "name, category, cost_price, sell_price, stock_quantity, unit",
            "expenses": "date, category, amount, note",
        }[resource].split(", ")
        assignments = ", ".join(field + " = ?" for field in fields)
        cursor = db.execute(
            "UPDATE " + resource + " SET " + assignments + " WHERE id = ?", values + (item_id,)
        )
        if cursor.rowcount == 0:
            return api_error("السجل غير موجود.", 404)
        if resource == "expenses":
            record_expense_shift_link(db, item_id, *values)
            if "stock_item" in payload:
                sync_expense_intake(
                    db, item_id, *values, stock_item=payload.get("stock_item")
                )
        db.commit()
        return jsonify({"ok": True})
    except (ValueError, TypeError, KeyError, json.JSONDecodeError, sqlite3.IntegrityError) as error:
        db.rollback()
        return api_error(str(error))


IMPORT_HEADERS = {
    "books": ["العنوان", "المؤلف", "النوع", "دار النشر", "سعر التكلفة", "سعر البيع", "الكمية"],
    "materials": ["الاسم", "الوحدة", "سعر التكلفة للوحدة", "المخزون الحالي", "حد التنبيه"],
    "drinks": ["الاسم", "التصنيف", "سعر البيع", "الوصفة"],
    "retail": ["الاسم", "التصنيف", "سعر التكلفة", "سعر البيع", "الكمية"],
}


def import_book_type(value):
    normalized = str(value or "").strip().casefold()
    if normalized in ("أصلي", "أصلية"):
        return "Original"
    if normalized in ("نسخة عالية", "نسخة", "هاي كوبي"):
        return "High Copy"
    return normalize_book_type(value)


def import_category(value, scope="drink"):
    normalized = str(value or "").strip().casefold()
    label = str(value or "").strip()
    categories = get_db().execute(
        "SELECT slug, label_ar FROM categories WHERE scope = ? AND is_active = 1",
        (scope,),
    ).fetchall()
    aliases = {}
    for category in categories:
        aliases[category["slug"].casefold()] = category["slug"]
        aliases[category["label_ar"].casefold()] = category["slug"]
    if scope == "drink":
        aliases.update({"بارد": "iced", "cold": "iced"})
    if normalized in aliases:
        return aliases[normalized]

    if not label:
        return "hot" if scope == "drink" else "extra"
    ensure_category_scope = "drink" if scope == "drink" else "retail"
    base = unicodedata.normalize("NFKC", label).strip().casefold().replace(" ", "-")
    if not base:
        base = "category-" + secrets.token_hex(3)
    slug = base
    suffix = 2
    while get_db().execute("SELECT 1 FROM categories WHERE slug = ?", (slug,)).fetchone():
        slug = base + "-" + str(suffix)
        suffix += 1
    max_order = get_db().execute(
        "SELECT COALESCE(MAX(sort_order), 0) AS value FROM categories WHERE scope = ?",
        (ensure_category_scope,),
    ).fetchone()["value"]
    get_db().execute(
        """INSERT INTO categories(slug, label_ar, scope, sort_order, is_active, created_at)
           VALUES (?, ?, ?, ?, 1, ?)""",
        (slug, label, ensure_category_scope, int(max_order) + 1,
         datetime.now().astimezone().isoformat(timespec="seconds")),
    )
    get_db().commit()
    return slug


class HtmlTableParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.tables = []
        self._table = None
        self._row = None
        self._cell = None
        self._capture = False

    def handle_starttag(self, tag, attrs):
        if tag == "table":
            self._table = []
        elif tag == "tr" and self._table is not None:
            self._row = []
        elif tag in ("td", "th") and self._row is not None:
            self._cell = []
            self._capture = True

    def handle_endtag(self, tag):
        if tag in ("td", "th") and self._row is not None:
            self._row.append("".join(self._cell).strip())
            self._cell = None
            self._capture = False
        elif tag == "tr" and self._table is not None and self._row is not None:
            self._table.append(self._row)
            self._row = None
        elif tag == "table" and self._table is not None:
            if self._table:
                self.tables.append(self._table)
            self._table = None

    def handle_data(self, data):
        if self._capture:
            self._cell.append(data)


def decode_import_text(content):
    for encoding in ("utf-8-sig", "cp1256", "latin-1"):
        try:
            return content.decode(encoding)
        except UnicodeDecodeError:
            continue
    raise ValueError("تعذر قراءة ترميز الملف.")


def parse_csv_bytes(content):
    text = decode_import_text(content)
    sample = text[:4096]
    try:
        dialect = csv.Sniffer().sniff(sample, delimiters=",;\t|")
    except csv.Error:
        dialect = csv.excel
    return list(csv.reader(io.StringIO(text), dialect))


def parse_html_table_bytes(content):
    parser = HtmlTableParser()
    parser.feed(decode_import_text(content))
    if not parser.tables:
        raise ValueError("لا يوجد جدول داخل ملف Excel القديم.")
    return parser.tables[0]


def parse_xls_bytes(content):
    try:
        import xlrd
    except ImportError:
        raise ValueError("استيراد ملفات Excel القديمة يتطلب تثبيت xlrd.")
    workbook = None
    try:
        workbook = xlrd.open_workbook(file_contents=content, formatting_info=False)
        worksheet = workbook.sheet_by_index(0)
        if worksheet.nrows > MAX_IMPORT_ROWS + 1:
            raise ValueError("الحد الأقصى للاستيراد " + str(MAX_IMPORT_ROWS) + " صف.")
        return [worksheet.row_values(index) for index in range(worksheet.nrows)]
    finally:
        if workbook is not None:
            workbook.release_resources()


def parse_xlsx_bytes(content):
    try:
        from openpyxl import load_workbook
    except ImportError:
        raise ValueError("استيراد XLSX غير متاح. ثبّت متطلبات التطبيق ثم أعد المحاولة.")
    workbook = load_workbook(io.BytesIO(content), read_only=True, data_only=True)
    try:
        worksheet = workbook.active
        if worksheet.max_row and worksheet.max_row > MAX_IMPORT_ROWS + 1:
            raise ValueError("الحد الأقصى للاستيراد " + str(MAX_IMPORT_ROWS) + " صف.")
        rows = []
        for index, row in enumerate(worksheet.iter_rows(values_only=True)):
            if index > MAX_IMPORT_ROWS:
                break
            rows.append(list(row))
        return rows
    finally:
        workbook.close()


def parse_xlsb_bytes(content):
    try:
        from pyxlsb import open_workbook
    except ImportError:
        raise ValueError("استيراد XLSB يتطلب تثبيت pyxlsb.")
    rows = []
    with open_workbook(io.BytesIO(content)) as workbook:
        with workbook.get_sheet(1) as worksheet:
            for index, row in enumerate(worksheet.rows()):
                if index > MAX_IMPORT_ROWS:
                    raise ValueError("الحد الأقصى للاستيراد " + str(MAX_IMPORT_ROWS) + " صف.")
                rows.append([cell.v for cell in row])
    return rows


def detect_spreadsheet_kind(filename, content):
    name = (filename or "").lower()
    head = content[:16]
    sample = content[:4096].lstrip().lower()
    if head.startswith(b"\xd0\xcf\x11\xe0"):
        return "xls"
    if head.startswith(b"PK"):
        if name.endswith(".xlsb"):
            return "xlsb"
        return "xlsx"
    if b"<html" in sample or b"<table" in sample or b"<worksheet" in sample:
        return "html"
    if name.endswith(".xlsb"):
        return "xlsb"
    if name.endswith((".xlsx", ".xlsm")):
        return "xlsx"
    if name.endswith(".xls"):
        return "xls"
    if name.endswith(".csv") or b"," in content[:200] or b";" in content[:200]:
        return "csv"
    return "unknown"


def parse_import_file(upload):
    filename = (upload.filename or "").lower()
    content = upload.read(MAX_IMPORT_BYTES + 1)
    if not content:
        raise ValueError("الملف فارغ.")
    if len(content) > MAX_IMPORT_BYTES:
        raise ValueError("حجم الملف يتجاوز الحد المسموح (5 ميجابايت).")
    kind = detect_spreadsheet_kind(filename, content)
    errors = []
    attempts = []
    if kind == "xls":
        attempts = [("xls", parse_xls_bytes), ("html", parse_html_table_bytes), ("csv", parse_csv_bytes)]
    elif kind == "xlsx":
        attempts = [("xlsx", parse_xlsx_bytes), ("xlsb", parse_xlsb_bytes)]
    elif kind == "xlsb":
        attempts = [("xlsb", parse_xlsb_bytes)]
    elif kind == "html":
        attempts = [("html", parse_html_table_bytes), ("csv", parse_csv_bytes)]
    elif kind == "csv":
        attempts = [("csv", parse_csv_bytes)]
    else:
        attempts = [
            ("xls", parse_xls_bytes),
            ("xlsx", parse_xlsx_bytes),
            ("html", parse_html_table_bytes),
            ("csv", parse_csv_bytes),
        ]
    for label, parser in attempts:
        try:
            rows = parser(content)
            if rows:
                return rows
        except ValueError as error:
            if str(error).startswith("الحد الأقصى"):
                raise
            errors.append(label + ": " + str(error))
        except Exception as error:
            errors.append(label + ": " + str(error))
    raise ValueError(
        "تعذر قراءة ملف Excel. يدعم النظام الملفات القديمة والحديثة (XLS و XLSX و XLSM و XLSB و CSV). "
        + (" التفاصيل: " + " | ".join(errors) if errors else "")
    )


def clean_import_value(value):
    return "" if value is None else str(value).strip()


def import_row_values(resource, header_indexes, row, material_names):
    def value(header, optional=False):
        index = header_indexes.get(header)
        raw = clean_import_value(row[index]) if index is not None and index < len(row) else ""
        if not raw and not optional:
            raise ValueError("الحقل «" + header + "» مطلوب.")
        return raw

    def optional_number(header, default=0):
        raw = clean_import_value(
            row[header_indexes[header]]
            if header in header_indexes and header_indexes[header] < len(row)
            else ""
        )
        if not raw:
            return default
        try:
            number = float(raw)
        except (TypeError, ValueError):
            return default
        return number if math.isfinite(number) and number >= 0 else default

    if resource == "books":
        return resource_values("books", {
            "title": value("العنوان", True) or "كتاب مستورد",
            "author": value("المؤلف", True),
            "type": import_book_type(value("النوع", True) or "Original"),
            "publisher": value("دار النشر", True),
            "cost_price": optional_number("سعر التكلفة"),
            "sell_price": optional_number("سعر البيع"),
            "stock_quantity": optional_number("الكمية"),
        })
    if resource == "materials":
        unit = normalize_material_unit(value("الوحدة", True))
        if not unit:
            unit = "قطعة"
        return resource_values("materials", {
            "name": value("الاسم", True) or "مادة مستوردة",
            "unit": unit,
            "cost_per_unit": optional_number("سعر التكلفة للوحدة"),
            "current_stock": optional_number("المخزون الحالي"),
            "reorder_level": optional_number("حد التنبيه", 5),
        })
    if resource == "retail":
        return resource_values("retail", {
            "name": value("الاسم", True) or "منتج مستورد",
            "category": import_category(value("التصنيف"), "retail"),
            "cost_price": optional_number("سعر التكلفة"),
            "sell_price": optional_number("سعر البيع"),
            "stock_quantity": optional_number("الكمية"),
            "unit": value("الوحدة", True) or "قطعة",
        })
    recipe_text = value("الوصفة", True)
    recipe = []
    if recipe_text:
        for ingredient_text in recipe_text.split(";"):
            ingredient_text = ingredient_text.strip()
            if not ingredient_text:
                continue
            if "=" not in ingredient_text:
                raise ValueError("صيغة الوصفة يجب أن تكون اسم المادة=الكمية.")
            material_name, quantity_text = ingredient_text.rsplit("=", 1)
            material_name = material_name.strip()
            material_matches = material_names.get(material_name.casefold(), [])
            if not material_matches:
                cursor = get_db().execute(
                    "INSERT INTO materials(name, unit, cost_per_unit, current_stock, reorder_level) "
                    "VALUES (?, 'قطعة', 0, 0, 5)",
                    (material_name,),
                )
                get_db().commit()
                material_match = {"id": cursor.lastrowid, "name": material_name}
                material_names.setdefault(material_name.casefold(), []).append(material_match)
                material_matches = material_names[material_name.casefold()]
            if len(material_matches) > 1:
                raise ValueError("اسم المادة مكرر ولا يمكن تحديده: " + material_name + ".")
            try:
                ingredient_qty = positive_number(quantity_text.strip(), "كمية المكوّن", False)
            except ValueError:
                ingredient_qty = 1.0
            recipe.append({
                "material_id": material_matches[0]["id"],
                "qty": ingredient_qty,
            })
    category_header = (
        "التصنيف" if "التصنيف" in header_indexes else "النوع(ساخن/بارد)"
    )
    category = import_category(value(category_header), "drink")
    return resource_values("drinks", {
        "name": value("الاسم", True) or "مشروب مستورد",
        "category": category,
        "sell_price": optional_number("سعر البيع"),
        "recipe_json": json.dumps(recipe, ensure_ascii=False),
    })


@app.get("/api/admin/templates/<resource>")
@inventory_or_expense_manager_required
def download_import_template(resource):
    if resource not in IMPORT_HEADERS:
        return api_error("القالب المطلوب غير معروف.", 404)
    try:
        from openpyxl import Workbook
        from openpyxl.worksheet.datavalidation import DataValidation
    except ImportError:
        return api_error("تنزيل قوالب XLSX يتطلب تثبيت متطلبات التطبيق.", 500)
    workbook = Workbook()
    worksheet = workbook.active
    worksheet.title = {
        "books": "الكتب",
        "materials": "المواد",
        "drinks": "المشروبات",
        "retail": "منتجات جاهزة",
    }[resource]
    worksheet.sheet_view.rightToLeft = True
    worksheet.append(IMPORT_HEADERS[resource])
    worksheet.freeze_panes = "A2"
    worksheet.auto_filter.ref = worksheet.dimensions
    for column in worksheet.columns:
        worksheet.column_dimensions[column[0].column_letter].width = max(
            18, min(32, len(str(column[0].value or "")) + 5)
        )
    if resource == "books":
        validation = DataValidation(type="list", formula1='"Original,High Copy"', allow_blank=False)
        worksheet.add_data_validation(validation)
        validation.add("C2:C1001")
    elif resource == "materials":
        validation = DataValidation(type="list", formula1='"جرام,كجم,مل,لتر,قطعة"', allow_blank=False)
        worksheet.add_data_validation(validation)
        validation.add("B2:B1001")
    elif resource == "drinks":
        category_labels = ",".join(
            row["label_ar"] for row in get_db().execute(
                "SELECT label_ar FROM categories WHERE scope = 'drink' AND is_active = 1 "
                "ORDER BY sort_order, id"
            )
        )
        validation = DataValidation(
            type="list", formula1='"' + category_labels + '"', allow_blank=False
        )
        worksheet.add_data_validation(validation)
        validation.add("B2:B1001")
    else:
        category_labels = ",".join(
            row["label_ar"] for row in get_db().execute(
                "SELECT label_ar FROM categories WHERE scope = 'retail' AND is_active = 1 "
                "ORDER BY sort_order, id"
            )
        )
        validation = DataValidation(
            type="list", formula1='"' + category_labels + '"', allow_blank=False
        )
        worksheet.add_data_validation(validation)
        validation.add("B2:B1001")
    output = io.BytesIO()
    workbook.save(output)
    output.seek(0)
    return send_file(
        output,
        as_attachment=True,
        download_name=resource + "-template.xlsx",
        mimetype="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    )


@app.post("/api/admin/import/<resource>")
@inventory_or_expense_manager_required
@open_shift_required
def import_admin_resource(resource):
    if resource not in IMPORT_HEADERS:
        return api_error("نوع الاستيراد غير معروف.", 404)
    upload = request.files.get("file")
    if upload is None:
        return api_error("اختر ملفًا للاستيراد.")
    try:
        rows = parse_import_file(upload)
        if not rows:
            raise ValueError("الملف لا يحتوي على صفوف.")
        headers = [clean_import_value(header) for header in rows[0]]
        header_indexes = {header: index for index, header in enumerate(headers)}
        if resource == "drinks" and "التصنيف" not in header_indexes:
            legacy_category_header = "النوع(ساخن/بارد)"
            if legacy_category_header in header_indexes:
                header_indexes["التصنيف"] = header_indexes[legacy_category_header]
        notes = []
        missing_headers = [header for header in IMPORT_HEADERS[resource] if header not in header_indexes]
        if missing_headers:
            notes.extend(["تم استخدام القيم الافتراضية للأعمدة الناقصة: " + "، ".join(missing_headers)])
        data_rows = rows[1:]
        if len(data_rows) > MAX_IMPORT_ROWS:
            raise ValueError("الحد الأقصى للاستيراد " + str(MAX_IMPORT_ROWS) + " صف.")
        if resource == "books" and any(
            header.strip().lower() in ("حد التنبيه", "reorder_level")
            for header in headers
        ):
            notes.append("تم تجاهل عمود حد التنبيه القديم للكتب.")
        db = get_db()
        material_names = {}
        if resource == "drinks":
            for material in db.execute("SELECT id, name FROM materials"):
                material_names.setdefault(material["name"].strip().casefold(), []).append(dict(material))
        fields = {
            "books": "title, author, publisher, type, cost_price, sell_price, stock_quantity",
            "materials": "name, unit, cost_per_unit, current_stock, reorder_level",
            "drinks": "name, sell_price, recipe_json, category",
            "retail": "name, category, cost_price, sell_price, stock_quantity, unit",
        }[resource]
        imported = 0
        errors = []
        for row_number, row in enumerate(data_rows, start=2):
            if not any(clean_import_value(value) for value in row):
                continue
            try:
                values = import_row_values(resource, header_indexes, row, material_names)
                placeholders = ", ".join("?" for _ in values)
                db.execute(
                    "INSERT INTO " + resource + "(" + fields + ") VALUES (" + placeholders + ")", values
                )
                db.commit()
                imported += 1
            except (ValueError, TypeError, KeyError, json.JSONDecodeError, sqlite3.IntegrityError) as error:
                db.rollback()
                errors.append({"row": row_number, "reason": str(error)})
        return jsonify({
            "imported": imported,
            "failed": len(errors),
            "errors": errors,
            "notes": notes,
        })
    except ValueError as error:
        return api_error(str(error))


# ==========================================
# SYSTEM PURGE (Batch 3a) — admin-only, explicit confirmation, audited
# ==========================================

# Each scope is an ordered list of FK-safe operations. Operations:
#   ("delete", table)              -> DELETE FROM table (counted)
#   ("nullify", (table, column))   -> detach nullable references instead of deleting parents
#   ("purge_materials", None)      -> delete materials and strip them from drink recipes
PURGE_SCOPES = {
    "books": {"label": "الكتب", "ops": [("delete", "books")]},
    "drinks": {"label": "المشروبات", "ops": [("delete", "drinks")]},
    "materials": {"label": "المواد الخام", "ops": [("purge_materials", None)]},
    "retail": {"label": "منتجات جاهزة", "ops": [("delete", "retail")]},
    "orders": {"label": "المبيعات والطلبات", "ops": [("delete", "orders")]},
    "expenses": {"label": "المصروفات", "ops": [("delete", "expenses")]},
    "employees": {"label": "الموظفين", "ops": [
        ("nullify", ("orders", "shift_id")),
        ("nullify", ("expenses", "shift_id")),
        ("nullify", ("purchases", "shift_id")),
        ("nullify", ("cash_entries", "shift_id")),
        ("nullify", ("shifts", "handover_to")),
        ("delete", "payroll_settlements"),
        ("delete", "shifts"),
        ("nullify", ("orders", "employee_id")),
        ("nullify", ("expenses", "employee_id")),
        ("nullify", ("purchases", "employee_id")),
        ("nullify", ("cash_entries", "employee_id")),
        ("delete", "employees"),
    ]},
    "attendance": {"label": "الحضور والورديات", "ops": [
        ("delete", "cash_entries"),
        ("delete", "purchases"),
        ("nullify", ("orders", "shift_id")),
        ("delete_orders_with_shift_or_day", None),
        ("delete", "shifts"),
        ("nullify", ("expenses", "shift_id")),
        ("nullify", ("expenses", "purchase_id")),
        ("delete", "business_days"),
    ]},
    "payroll_adjustments": {"label": "الرواتب والتسويات", "ops": [("delete", "payroll_settlements")]},
    "categories": {"label": "الأقسام والتصنيفات", "ops": [("delete", "categories")]},
}

# Order matters: children before parents. The users table is intentionally kept
# so the system never ends with zero admins.
GLOBAL_PURGE_OPERATIONS = [
    ("delete", "orders"),
    ("delete", "expenses"),
    ("delete", "cash_entries"),
    ("delete", "purchases"),
    ("delete", "payroll_settlements"),
    ("delete", "shifts"),
    ("delete", "business_days"),
    ("delete", "drinks"),
    ("delete", "retail"),
    ("delete", "books"),
    ("delete", "materials"),
    ("delete", "categories"),
    ("delete", "employees"),
    ("delete", "project_log_notes"),
]


def apply_purge_operations(db, operations):
    """Run an ordered purge plan inside the caller's transaction; return rows deleted."""
    deleted = 0
    for kind, target in operations:
        if kind == "delete":
            deleted += db.execute("DELETE FROM " + target).rowcount
        elif kind == "nullify":
            table, column = target
            db.execute(
                "UPDATE " + table + " SET " + column + " = NULL WHERE " + column + " IS NOT NULL"
            )
        elif kind == "delete_orders_with_shift_or_day":
            db.execute(
                "DELETE FROM orders WHERE shift_id IS NOT NULL OR business_day_id IS NOT NULL"
            )
        elif kind == "purge_materials":
            deleted += db.execute("DELETE FROM materials").rowcount
            valid_ids = {row["id"] for row in db.execute("SELECT id FROM materials").fetchall()}
            for drink in db.execute("SELECT id, recipe_json FROM drinks").fetchall():
                try:
                    recipe = json.loads(drink["recipe_json"] or "[]")
                except (TypeError, json.JSONDecodeError):
                    recipe = []
                if not isinstance(recipe, list):
                    continue
                kept = [
                    item for item in recipe
                    if isinstance(item, dict) and item.get("material_id") in valid_ids
                ]
                if len(kept) != len(recipe):
                    db.execute(
                        "UPDATE drinks SET recipe_json = ? WHERE id = ?",
                        (json.dumps(kept, ensure_ascii=False), drink["id"]),
                    )
    return deleted


def reseed_core_settings(db):
    """Restore default shop settings after a global purge (never leave them blank)."""
    db.execute("DELETE FROM settings WHERE key IN ('shop_name', 'shop_address', 'shift_hours')")
    db.execute("INSERT OR REPLACE INTO settings(key, value) VALUES ('shop_name', ?)", (DEFAULT_SHOP_NAME,))
    db.execute("INSERT OR REPLACE INTO settings(key, value) VALUES ('shop_address', '')")
    db.execute("INSERT OR REPLACE INTO settings(key, value) VALUES ('shift_hours', '8')")


def purge_operations_for(scope):
    if scope == "all":
        return GLOBAL_PURGE_OPERATIONS, "كل بيانات النظام"
    entry = PURGE_SCOPES.get(scope)
    if entry is None:
        return None, None
    return entry["ops"], entry["label"]


@app.get("/api/admin/purge/scopes")
@admin_required
def purge_scope_catalog():
    return jsonify({
        "scopes": [{"key": key, "label": value["label"]} for key, value in PURGE_SCOPES.items()],
    })


@app.delete("/api/admin/purge/<scope>")
@admin_required
def purge_system_scope(scope):
    operations, label = purge_operations_for(scope)
    if operations is None:
        return api_error("نطاق التفريغ غير معروف.", 404)
    payload = request.get_json(silent=True) or {}
    if payload.get("confirmed") is not True:
        return api_error("يجب تأكيد التفريغ من النافذة.", 400)
    db = get_db()
    try:
        deleted = apply_purge_operations(db, operations)
        if scope == "all":
            reseed_core_settings(db)
        admin_count = db.execute(
            "SELECT COUNT(*) AS total FROM users WHERE role = 'admin'"
        ).fetchone()["total"]
        if admin_count < 1:
            db.rollback()
            return api_error("لا يمكن إتمام التفريغ لأنه سيترك النظام بدون حساب مدير.", 409)
        performed_by, performed_by_name, performed_by_role = current_actor_identity(db)
        performed_at = datetime.now().astimezone().isoformat(timespec="seconds")
        db.execute(
            "INSERT INTO purge_logs(scope, scope_label, deleted_count, performed_by, "
            "performed_by_name, performed_by_role, performed_at, details) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (scope, label, deleted, performed_by, performed_by_name, performed_by_role,
             performed_at, "حذف " + str(deleted) + " صفًا"),
        )
        db.commit()
    except sqlite3.Error as error:
        db.rollback()
        return api_error("تعذر تنفيذ التفريغ: " + str(error), 500)
    return jsonify({
        "ok": True,
        "scope": scope,
        "label": label,
        "deleted": deleted,
        "message": "تم تفريغ «" + label + "» وحذف " + str(deleted) + " صفًا من البيانات.",
    })


# ==========================================
# EXCEL EXPORT (Batch 3b) — round-trip with the import format
# ==========================================
CATEGORY_EXPORT_HEADERS = ["label_ar", "scope", "sort_order", "is_active"]
EXPORT_SHEET_TITLES = {
    "books": "الكتب",
    "drinks": "المشروبات",
    "materials": "المواد",
    "retail": "منتجات جاهزة",
    "categories": "التصنيفات",
}


def format_export_quantity(value):
    """Format recipe quantities the same way the importer parses them back."""
    try:
        number = float(value)
    except (TypeError, ValueError):
        return "0"
    if number.is_integer():
        return str(int(number))
    return ("%.6f" % number).rstrip("0").rstrip(".")


def export_recipe_text(recipe_json, material_names):
    try:
        recipe = json.loads(recipe_json or "[]")
    except (TypeError, json.JSONDecodeError):
        return ""
    if not isinstance(recipe, list):
        return ""
    parts = []
    for item in recipe:
        if not isinstance(item, dict):
            continue
        name = material_names.get(item.get("material_id"))
        if not name:
            continue
        parts.append(str(name) + "=" + format_export_quantity(item.get("qty", 0)))
    return "; ".join(parts)


def export_resource_rows(resource, db):
    """Return export rows (values) in the exact IMPORT_HEADERS column order."""
    category_labels = {
        row["slug"]: row["label_ar"] for row in db.execute("SELECT slug, label_ar FROM categories")
    }
    if resource == "books":
        rows = db.execute(
            "SELECT title, author, type, publisher, cost_price, sell_price, stock_quantity "
            "FROM books ORDER BY id"
        ).fetchall()
        return [[r["title"], r["author"], r["type"], r["publisher"],
                 r["cost_price"], r["sell_price"], r["stock_quantity"]] for r in rows]
    if resource == "materials":
        rows = db.execute(
            "SELECT name, unit, cost_per_unit, current_stock, reorder_level FROM materials ORDER BY id"
        ).fetchall()
        return [[r["name"], material_unit_label(r["unit"]), r["cost_per_unit"],
                 r["current_stock"], r["reorder_level"]] for r in rows]
    if resource == "retail":
        rows = db.execute(
            "SELECT name, category, cost_price, sell_price, stock_quantity FROM retail ORDER BY id"
        ).fetchall()
        return [[r["name"], category_labels.get(r["category"], r["category"]),
                 r["cost_price"], r["sell_price"], r["stock_quantity"]] for r in rows]
    if resource == "drinks":
        material_names = {
            row["id"]: row["name"] for row in db.execute("SELECT id, name FROM materials")
        }
        rows = db.execute(
            "SELECT name, category, sell_price, recipe_json FROM drinks ORDER BY id"
        ).fetchall()
        result = []
        for r in rows:
            category = "iced" if r["category"] == "cold" else r["category"]
            result.append([
                r["name"],
                category_labels.get(category, category),
                r["sell_price"],
                export_recipe_text(r["recipe_json"], material_names),
            ])
        return result
    if resource == "categories":
        rows = db.execute(
            "SELECT label_ar, scope, sort_order, is_active FROM categories "
            "ORDER BY scope, sort_order, id"
        ).fetchall()
        return [[r["label_ar"], r["scope"], r["sort_order"], r["is_active"]] for r in rows]
    return []


@app.get("/api/admin/export/<resource>")
@inventory_or_expense_manager_required
def export_admin_resource(resource):
    if resource != "categories" and resource not in IMPORT_HEADERS:
        return api_error("نوع التصدير غير معروف.", 404)
    if resource == "categories" and not session.get("admin_id"):
        return api_error("تصدير التصنيفات متاح للمدير فقط.", 403)
    try:
        from openpyxl import Workbook
    except ImportError:
        return api_error("تصدير XLSX يتطلب تثبيت متطلبات التطبيق.", 500)
    db = get_db()
    headers = CATEGORY_EXPORT_HEADERS if resource == "categories" else IMPORT_HEADERS[resource]
    workbook = Workbook()
    worksheet = workbook.active
    worksheet.title = EXPORT_SHEET_TITLES[resource]
    worksheet.sheet_view.rightToLeft = True
    worksheet.append(headers)
    for row in export_resource_rows(resource, db):
        worksheet.append(row)
    worksheet.freeze_panes = "A2"
    for column in worksheet.columns:
        worksheet.column_dimensions[column[0].column_letter].width = max(
            16, min(40, max(len(str(cell.value or "")) for cell in column) + 4)
        )
    output = io.BytesIO()
    workbook.save(output)
    output.seek(0)
    filename = "bookmart_" + resource + "_" + date.today().strftime("%Y%m%d") + ".xlsx"
    return send_file(
        output,
        as_attachment=True,
        download_name=filename,
        mimetype="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    )


@app.get("/api/admin/reports")
@admin_required
def monthly_report():
    month = request.args.get("month", date.today().strftime("%Y-%m"))
    try:
        parsed = datetime.strptime(month, "%Y-%m")
    except ValueError:
        return api_error("يجب إدخال الشهر بالصيغة سنة-شهر.")
    prefix = parsed.strftime("%Y-%m")
    orders = get_db().execute(
        "SELECT total_amount, items_json FROM orders WHERE substr(timestamp, 1, 7) = ? AND status = 'completed'",
        (prefix,),
    ).fetchall()
    revenue = sum(row["total_amount"] for row in orders)
    cogs = sum(
        item["unit_cost"] * item["quantity"]
        for row in orders
        for item in json.loads(row["items_json"])
    )
    expenses = get_db().execute(
        "SELECT COALESCE(SUM(amount), 0) AS total FROM expenses WHERE substr(date, 1, 7) = ?",
        (prefix,),
    ).fetchone()["total"]
    return jsonify({
        "month": prefix,
        "revenue": round(revenue, 2),
        "cogs": round(cogs, 2),
        "expenses": round(expenses, 2),
        "profit": round(revenue - cogs - expenses, 2),
        "orders": len(orders),
    })


def write_setting(db, key, value):
    """Store a setting whether or not the row already exists."""
    db.execute(
        "INSERT OR REPLACE INTO settings(key, value) VALUES (?, ?)", (key, str(value))
    )


@app.get("/api/admin/settings")
@admin_required
def get_settings():
    db = get_db()
    rows = db.execute(
        "SELECT key, value FROM settings WHERE key IN ('shop_name', 'shop_address', 'shift_hours')"
    )
    values = dict(rows)
    values["shop_name"] = values.get("shop_name") or DEFAULT_SHOP_NAME
    values["shift_hours"] = float(values.get("shift_hours") or 8)
    values["receipt"] = receipt_settings(db)
    logo = current_logo_path(db)
    values["logo_available"] = logo is not None
    values["logo_uploaded"] = bool(logo_file_name(
        (db.execute("SELECT value FROM settings WHERE key = ?", (LOGO_SETTINGS_KEY,)).fetchone() or {"value": ""})["value"]
    ))
    return jsonify(values)


@app.get("/branding/logo")
def branding_logo():
    db = get_db()
    path = current_logo_path(db)
    if path is None:
        bundled = DATA_DIR / "logo.png"
        if bundled.is_file():
            path = bundled
        else:
            bundled = resource_path("static/img/logo.png")
            if bundled.is_file():
                path = bundled
    if path is None or not path.is_file():
        return abort(404)
    return send_file(path, mimetype=LOGO_SUFFIXES.get(path.suffix.lower(), "application/octet-stream"))


@app.get("/api/receipt-preview")
@admin_required
def receipt_preview():
    db = get_db()
    values = receipt_settings(db)
    row = db.execute("SELECT value FROM settings WHERE key = 'shop_address'").fetchone()
    shop_address = str(row["value"] if row else "")
    logo_path = current_logo_path(db)
    if logo_path is None:
        logo_path = DATA_DIR / "logo.png"
    now = datetime.now().astimezone()
    sample_items = [
        {"name": "Espresso", "quantity": 1, "unit_price": 60, "line_total": 60},
        {"name": "Cheesecake", "quantity": 1, "unit_price": 90, "line_total": 90},
        {"name": "Water", "quantity": 1, "unit_price": 15, "line_total": 15},
    ]
    return render_template(
        "receipt.html",
        order={"id": 125, "performed_by_name": "", "payment_method": "نقدي"},
        items=sample_items,
        shop_name=current_shop_name(),
        shop_name_dir=shop_name_direction(current_shop_name()),
        shop_address=shop_address,
        receipt=values,
        paper_width=int(values["receipt_paper_width"]),
        logo_available=logo_path.is_file(),
        subtotal=165,
        discount=0,
        total=165,
        paid_amount=165,
        change_amount=0,
        order_date=now.strftime("%d/%m/%Y"),
        order_time=now.strftime("%H:%M"),
        qr_html="",
        preview=True,
    )


@app.get("/api/print-receipt/<int:order_id>")
@cashier_session_required
def print_receipt(order_id):
    db = get_db()
    order = db.execute("SELECT * FROM orders WHERE id = ?", (order_id,)).fetchone()
    if order is None:
        return api_error("العملية غير موجودة.", 404)
    try:
        items = json.loads(order["items_json"] or "[]")
    except json.JSONDecodeError:
        items = []
    receipt = receipt_settings(db)
    valid_items = [item for item in items if isinstance(item, dict)]
    subtotal = round(sum(
        float(item.get("unit_price") or 0) * float(item.get("quantity") or 1)
        for item in valid_items
    ), 2)
    total = round(float(order["total_amount"] or 0), 2)
    paid_amount = order["paid_amount"]
    paid_amount = total if paid_amount is None else round(float(paid_amount), 2)
    change_amount = round(max(0, paid_amount - total), 2)

    logo_path = current_logo_path(db)
    if logo_path is None:
        logo_path = DATA_DIR / "logo.png"
    logo_available = logo_path.is_file()

    qr_value = ""
    qr_mode = receipt.get("receipt_qr_mode", "none")
    if qr_mode in ("text", "url"):
        qr_value = receipt.get("receipt_qr_value", "")
    elif qr_mode == "phone":
        qr_value = receipt.get("receipt_phone", "")
    elif qr_mode == "whatsapp":
        phone = "".join(character for character in receipt.get("receipt_phone", "") if character.isdigit() or character == "+")
        qr_value = "https://wa.me/" + phone.lstrip("+") if phone else ""
    elif qr_mode == "email":
        qr_value = receipt.get("receipt_email", "")
    qr_html = qrcode_gen.qr_html_table(qr_value) if qr_value else ""

    try:
        order_time = datetime.fromisoformat(order["timestamp"])
    except (TypeError, ValueError):
        order_time = None

    return render_template(
        "receipt.html",
        order=order,
        items=valid_items,
        shop_name=current_shop_name(),
        shop_name_dir=shop_name_direction(current_shop_name()),
        shop_address=(db.execute("SELECT value FROM settings WHERE key = 'shop_address'").fetchone() or {"value": ""})["value"],
        receipt=receipt,
        paper_width=int(receipt["receipt_paper_width"]),
        logo_available=logo_available,
        subtotal=subtotal,
        discount=round(max(0, subtotal - total), 2),
        total=total,
        paid_amount=paid_amount,
        change_amount=change_amount,
        order_date=order_time.strftime("%d/%m/%Y") if order_time else "",
        order_time=order_time.strftime("%H:%M") if order_time else "",
        qr_html=qr_html,
        preview=request.args.get("preview") is not None,
    )


@app.post("/api/admin/logo")
@admin_required
def upload_logo():
    """Replace the image printed above the shop name on every receipt."""
    upload = request.files.get("logo")
    if upload is None or not upload.filename:
        return api_error("اختر صورة لرفعها.")
    suffix = Path(upload.filename).suffix.lower()
    if suffix not in LOGO_SUFFIXES:
        return api_error("الصورة يجب أن تكون من نوع PNG أو JPG أو GIF أو WEBP.")
    blob = upload.read(MAX_LOGO_BYTES + 1)
    if len(blob) > MAX_LOGO_BYTES:
        return api_error("حجم الصورة يتجاوز 2 ميجابايت.")
    if not blob:
        return api_error("الصورة فارغة.")
    name = "receipt_logo_" + secrets.token_hex(8) + suffix
    db = get_db()
    previous = logo_file_name(
        (db.execute("SELECT value FROM settings WHERE key = ?", (LOGO_SETTINGS_KEY,)).fetchone() or {"value": ""})["value"]
    )
    (DATA_DIR / name).write_bytes(blob)
    write_setting(db, LOGO_SETTINGS_KEY, name)
    db.commit()
    if previous and previous != name:
        try:
            (DATA_DIR / previous).unlink()
        except OSError:
            pass
    return jsonify({"ok": True, "logo_url": "/branding/logo?v=" + secrets.token_hex(4)})


@app.delete("/api/admin/logo")
@admin_required
def delete_logo():
    """Fall back to the bundled logo shipped with the program."""
    db = get_db()
    previous = logo_file_name(
        (db.execute("SELECT value FROM settings WHERE key = ?", (LOGO_SETTINGS_KEY,)).fetchone() or {"value": ""})["value"]
    )
    if previous:
        try:
            (DATA_DIR / previous).unlink()
        except OSError:
            pass
        write_setting(db, LOGO_SETTINGS_KEY, "")
        db.commit()
    return jsonify({"ok": True, "logo_available": current_logo_path(db) is not None})


@app.put("/api/admin/settings")
@admin_required
@open_shift_required
def update_settings():
    data = request.get_json(silent=True) or {}
    if not isinstance(data, dict):
        return api_error("بيانات الإعدادات غير صالحة.")
    name = str(data.get("shop_name", "")).strip()
    address = str(data.get("shop_address", "")).strip()
    db = get_db()
    current_hours = db.execute(
        "SELECT value FROM settings WHERE key = 'shift_hours'"
    ).fetchone()
    try:
        shift_hours = positive_number(
            data.get("shift_hours", current_hours["value"] if current_hours else 8),
            "عدد ساعات الوردية",
            False,
        )
    except ValueError as error:
        return api_error(str(error))
    if shift_hours > 24:
        return api_error("عدد ساعات الوردية يجب ألا يتجاوز 24 ساعة.")

    # Receipt wording arrives flattened or nested; both come from the same form.
    supplied = dict(data.get("receipt") or {}) if isinstance(data.get("receipt"), dict) else {}
    for key in RECEIPT_SETTING_KEYS:
        if key in data:
            supplied[key] = data[key]
    cleaned = {}
    for key, value in supplied.items():
        if key not in RECEIPT_SETTING_KEYS:
            continue
        if key in RECEIPT_FLAG_KEYS:
            cleaned[key] = "1" if str(value).strip() in ("1", "true", "on", "yes") else "0"
        elif key == "receipt_paper_width":
            width = str(value).strip()
            if width not in RECEIPT_PAPER_WIDTHS:
                return api_error("عرض الورق غير مدعوم؛ اختر 58 أو 72 أو 80 مم.")
            cleaned[key] = width
        elif key == "receipt_qr_mode":
            mode = str(value).strip() or "none"
            if mode not in RECEIPT_QR_MODES:
                return api_error("نوع الكيو ار كود غير معروف.")
            cleaned[key] = mode
        else:
            cleaned[key] = str(value if value is not None else "").strip()
            if len(cleaned[key]) > 120:
                return api_error("نص الفاتورة طويل جدًا: " + RECEIPT_SETTING_DEFAULTS.get(key, key) + ".")
    effective_qr_value = str(
        cleaned.get("receipt_qr_value", receipt_settings(db)["receipt_qr_value"])
    ).strip()
    if cleaned.get("receipt_qr_mode") in ("text", "url") and not effective_qr_value:
        # Phone, WhatsApp and email codes are derived from the printed contact
        # lines, so only the free text and link modes demand their own payload.
        return api_error("اكتب النص أو الرابط الذي تريد وضعه داخل الكيو ار كود.")
    db.execute("UPDATE settings SET value = ? WHERE key = 'shop_name'", (name,))
    db.execute("UPDATE settings SET value = ? WHERE key = 'shop_address'", (address,))
    db.execute("UPDATE settings SET value = ? WHERE key = 'shift_hours'", (str(shift_hours),))
    for key, value in cleaned.items():
        write_setting(db, key, value)
    db.commit()
    return jsonify({"ok": True, "shop_name": current_shop_name(), "receipt": receipt_settings(db)})


@app.put("/api/admin/password")
@admin_required
@open_shift_required
def change_password():
    data = request.get_json(silent=True) or {}
    if not isinstance(data, dict):
        return api_error("بيانات كلمة المرور غير صالحة.")
    
    new_password = data.get("new_password", "")
    
    # Validation: Only check length and existence of new password
    if not isinstance(new_password, str) or len(new_password) < 6:
        return api_error("يجب ألا تقل كلمة المرور الجديدة عن 6 أحرف.")
    
    db = get_db()
    # Update directly without checking old password since session is already validated by @admin_required
    db.execute(
        "UPDATE users SET password_hash = ? WHERE id = ?",
        (generate_password_hash(new_password), session["admin_id"]),
    )
    db.commit()
    return jsonify({"ok": True})


def run_desktop():
    from werkzeug.serving import make_server

    server = make_server("127.0.0.1", 0, app, threaded=True)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    address = "http://127.0.0.1:" + str(server.server_port)
    try:
        import webview

        with app.app_context():
            window_title = current_shop_name()
        webview.create_window(window_title, address, width=1100, height=720, min_size=(760, 540))
        webview.start()
    except ImportError:
        app.logger.warning("pywebview is unavailable; opening the local app in the default browser.")
        webbrowser.open(address)
        thread.join()
    finally:
        server.shutdown()


if __name__ == "__main__":
    initialize_database()
    if "--web" in sys.argv:
        app.run(host="127.0.0.1", port=5000, threaded=True)
    else:
        run_desktop()
else:
    initialize_database()
