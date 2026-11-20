from pathlib import Path
import math
import os
import secrets
import sqlite3
import time
from threading import Lock

from flask import Flask, abort, jsonify, request, send_from_directory
from werkzeug.middleware.proxy_fix import ProxyFix
from werkzeug.security import check_password_hash, generate_password_hash


ROOT = Path(__file__).resolve().parent
DATABASE = ROOT / "calle_segura.db"
INDEX = "index.html"
PORT = int(os.getenv("PORT", "5000"))
SSL_CERT_FILE = os.getenv("SSL_CERT_FILE")
SSL_KEY_FILE = os.getenv("SSL_KEY_FILE")
DEMO_PASSWORD = os.getenv("DEMO_PASSWORD")
ALLOW_AUTO_REGISTRATION = os.getenv("ALLOW_AUTO_REGISTRATION", "0").lower() in ("1", "true", "yes", "on")
EMERGENCY_SERVICES = frozenset(("Carabineros", "Bomberos", "Ambulancia", "Seguridad municipal", "Otro"))
LOGIN_MAX_ATTEMPTS = max(1, int(os.getenv("LOGIN_MAX_ATTEMPTS", "5")))
LOGIN_WINDOW_SECONDS = max(60, int(os.getenv("LOGIN_WINDOW_SECONDS", "300")))
SERVICE_AREA_ENABLED = os.getenv("SERVICE_AREA_ENABLED", "0").lower() in ("1", "true", "yes", "on")
SERVICE_BOUNDS = {
    "min_lat": float(os.getenv("SERVICE_MIN_LAT", "-37.66")),
    "max_lat": float(os.getenv("SERVICE_MAX_LAT", "-37.57")),
    "min_lon": float(os.getenv("SERVICE_MIN_LON", "-73.70")),
    "max_lon": float(os.getenv("SERVICE_MAX_LON", "-73.60")),
}
PUBLIC_FILES = frozenset({
    INDEX,
    "app.js",
    "codigo.css",
    "logo-calle-segura.png",
    "manifest.webmanifest",
    "service-worker.js",
})
# Activar solo si Flask está detrás de tu propio proxy (Apache/XAMPP): toma la IP real del cliente.
TRUST_PROXY = os.getenv("TRUST_PROXY", "0").lower() in ("1", "true", "yes", "on")
ALLOWED_ORIGINS = frozenset(filter(None, (origin.strip() for origin in os.getenv("CORS_ORIGINS", "").split(","))))

_login_attempts = {}
_login_lock = Lock()

app = Flask(__name__, static_folder=None)
if TRUST_PROXY:
    app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1)


@app.after_request
def cors(response):
    origin = request.headers.get("Origin")
    if origin and origin in ALLOWED_ORIGINS:
        response.headers["Access-Control-Allow-Origin"] = origin
        response.headers["Access-Control-Allow-Headers"] = "Content-Type, Authorization"
        response.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
        response.headers["Vary"] = "Origin"
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    response.headers.setdefault("X-Frame-Options", "DENY")
    response.headers.setdefault("Referrer-Policy", "strict-origin-when-cross-origin")
    return response


def connect_db():
    db = sqlite3.connect(DATABASE, timeout=10)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA foreign_keys = ON")
    return db


def ensure_database():
    is_new = not DATABASE.exists()
    db = connect_db()
    if is_new:
        db.executescript((ROOT / "codigo.sql").read_text(encoding="utf-8"))
    report_columns = {row["name"] for row in db.execute("PRAGMA table_info(reports)").fetchall()}
    if "emergency_service" not in report_columns:
        db.execute("ALTER TABLE reports ADD COLUMN emergency_service TEXT")
    # Las cuentas demo del SQL traen un marcador; se les pone un hash real.
    # En producción se debe definir DEMO_PASSWORD o las cuentas demo quedarán
    # inutilizables con una contraseña aleatoria.
    if DEMO_PASSWORD:
        demo_password = DEMO_PASSWORD
    else:
        demo_password = secrets.token_urlsafe(32)
    db.execute("UPDATE users SET password_hash = ? WHERE password_hash LIKE 'demo_hash%'", (generate_password_hash(demo_password),))
    db.commit()
    db.close()


def request_json_object():
    data = request.get_json(silent=True)
    return data if isinstance(data, dict) else None


def webauthn_config():
    rp_id = WEBAUTHN_RP_ID or request.host.split(":", 1)[0]
    origin = WEBAUTHN_ORIGIN or request.url_root.rstrip("/")
    return rp_id, origin


def store_webauthn_challenge(db, challenge, user_id, purpose):
    db.execute("DELETE FROM webauthn_challenges WHERE created_at <= datetime('now', '-5 minutes')")
    db.execute(
        "INSERT INTO webauthn_challenges (challenge, user_id, purpose) VALUES (?, ?, ?)",
        (challenge, user_id, purpose),
    )


def consume_webauthn_challenge(db, user_id, purpose):
    if user_id is None:
        row = db.execute(
            "SELECT challenge FROM webauthn_challenges WHERE user_id IS NULL AND purpose = ? AND created_at > datetime('now', '-5 minutes') ORDER BY created_at DESC LIMIT 1",
            (purpose,),
        ).fetchone()
    else:
        row = db.execute(
            "SELECT challenge FROM webauthn_challenges WHERE user_id = ? AND purpose = ? AND created_at > datetime('now', '-5 minutes') ORDER BY created_at DESC LIMIT 1",
            (user_id, purpose),
        ).fetchone()
    if row is None:
        return None
    db.execute("DELETE FROM webauthn_challenges WHERE challenge = ?", (row["challenge"],))
    return bytes(row["challenge"])


def consume_webauthn_challenge_by_value(db, challenge, purpose):
    """Consume exactamente el desafío firmado por el navegador (uso único)."""
    row = db.execute(
        "SELECT challenge FROM webauthn_challenges WHERE challenge = ? AND user_id IS NULL AND purpose = ? AND created_at > datetime('now', '-5 minutes')",
        (challenge, purpose),
    ).fetchone()
    if row is None:
        return None
    db.execute("DELETE FROM webauthn_challenges WHERE challenge = ?", (challenge,))
    db.commit()  # se invalida aunque la verificación falle después
    return bytes(row["challenge"])


def login_is_rate_limited():
    now = time.monotonic()
    key = request.remote_addr or "unknown"
    with _login_lock:
        recent = [stamp for stamp in _login_attempts.get(key, []) if now - stamp < LOGIN_WINDOW_SECONDS]
        if len(recent) >= LOGIN_MAX_ATTEMPTS:
            _login_attempts[key] = recent
            return True
        recent.append(now)
        _login_attempts[key] = recent
    return False


def clear_login_attempts():
    key = request.remote_addr or "unknown"
    with _login_lock:
        _login_attempts.pop(key, None)


def parse_coord(value, low, high):
    try:
        n = float(value)
    except (TypeError, ValueError):
        return None
    return n if math.isfinite(n) and low <= n <= high else None


def is_service_location(latitude, longitude):
    if not SERVICE_AREA_ENABLED:
        return True
    return (
        SERVICE_BOUNDS["min_lat"] <= latitude <= SERVICE_BOUNDS["max_lat"]
        and SERVICE_BOUNDS["min_lon"] <= longitude <= SERVICE_BOUNDS["max_lon"]
    )


def current_user(db):
    auth = request.headers.get("Authorization", "")
    token = auth[7:] if auth.startswith("Bearer ") else ""
    if not token:
        return None
    return db.execute("""
        SELECT u.id, u.email, u.role, u.is_blocked FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.token = ? AND s.created_at > datetime('now', '-30 days')
    """, (token,)).fetchone()


def report_json(row, exact_location=False):
    item = dict(row)
    item["type"] = "em" if item.pop("report_type") == "emergency" else "pr"
    if not exact_location:
        item["latitude"] = round(item["latitude"], 3)
        item["longitude"] = round(item["longitude"], 3)
        item["address"] = "Ubicación aproximada" if item["address"] else None
    return item


def staff_user(db):
    u = current_user(db)
    return u if u and u["role"] in ("staff", "admin") and not u["is_blocked"] else None


@app.get("/api/health")
def health():
    db = connect_db()
    reports = db.execute("SELECT COUNT(*) FROM reports").fetchone()[0]
    db.close()
    return jsonify({"ok": True, "reports": reports})


@app.post("/api/login")
def login():
    data = request_json_object()
    if data is None:
        return jsonify({"error": "El cuerpo debe ser un objeto JSON"}), 400
    email = str(data.get("email", "")).strip().lower()
    password = str(data.get("password", ""))
    if "@" not in email or len(password) < 6:
        return jsonify({"error": "Correo o contraseña inválidos"}), 400
    if login_is_rate_limited():
        response = jsonify({"error": "Demasiados intentos. Intenta nuevamente más tarde."})
        response.status_code = 429
        response.headers["Retry-After"] = str(LOGIN_WINDOW_SECONDS)
        return response

    db = connect_db()
    row = db.execute("SELECT id, password_hash FROM users WHERE email = ?", (email,)).fetchone()
    if row is None:  # registro automático de ciudadanos
        if not ALLOW_AUTO_REGISTRATION:
            db.close()
            return jsonify({"error": "La cuenta no existe"}), 401
        if len(password) < 8:
            db.close()
            return jsonify({"error": "La contraseña debe tener al menos 8 caracteres"}), 400
        db.execute("INSERT INTO users (email, password_hash, full_name) VALUES (?, ?, ?)",
                   (email, generate_password_hash(password), email.split("@")[0]))
        db.commit()
    elif not check_password_hash(row["password_hash"], password):
        db.close()
        return jsonify({"error": "Correo o contraseña inválidos"}), 401
    user = db.execute("SELECT id, email, full_name, role, is_blocked FROM users WHERE email = ?", (email,)).fetchone()
    if user["is_blocked"]:
        db.close()
        return jsonify({"error": "La cuenta está bloqueada"}), 403
    clear_login_attempts()
    token = secrets.token_urlsafe(32)
    db.execute("INSERT INTO sessions (token, user_id) VALUES (?, ?)", (token, user["id"]))
    db.commit()
    db.close()
    return jsonify({**dict(user), "token": token})


@app.post("/api/register")
def register():
    data = request_json_object()
    if data is None:
        return jsonify({"error": "El cuerpo debe ser un objeto JSON"}), 400
    email = str(data.get("email", "")).strip().lower()
    password = str(data.get("password", ""))
    full_name = " ".join(str(data.get("full_name", "")).split())[:120] or email.split("@")[0]
    if "@" not in email or len(email) > 254 or len(password) < 8:
        return jsonify({"error": "Correo inválido o contraseña demasiado corta"}), 400
    if login_is_rate_limited():
        response = jsonify({"error": "Demasiados intentos. Intenta nuevamente más tarde."})
        response.status_code = 429
        response.headers["Retry-After"] = str(LOGIN_WINDOW_SECONDS)
        return response

    db = connect_db()
    if db.execute("SELECT 1 FROM users WHERE email = ?", (email,)).fetchone() is not None:
        db.close()
        return jsonify({"error": "El correo ya está registrado"}), 409
    try:
        db.execute(
            "INSERT INTO users (email, password_hash, full_name) VALUES (?, ?, ?)",
            (email, generate_password_hash(password), full_name),
        )
        user = db.execute(
            "SELECT id, email, full_name, role, is_blocked FROM users WHERE email = ?",
            (email,),
        ).fetchone()
        token = secrets.token_urlsafe(32)
        db.execute("INSERT INTO sessions (token, user_id) VALUES (?, ?)", (token, user["id"]))
        db.commit()
    except sqlite3.IntegrityError:
        db.close()
        return jsonify({"error": "El correo ya está registrado"}), 409
    db.close()
    clear_login_attempts()
    return jsonify({**dict(user), "token": token}), 201


def passkey_register_options():
    db = connect_db()
    user = current_user(db)
    if user is None or user["is_blocked"]:
        db.close()
        return jsonify({"error": "Debes iniciar sesión"}), 401

    rp_id, _ = webauthn_config()
    challenge = secrets.token_bytes(32)
    existing = db.execute(
        "SELECT credential_id FROM webauthn_credentials WHERE user_id = ?",
        (user["id"],),
    ).fetchall()
    options = generate_registration_options(
        rp_id=rp_id,
        rp_name=WEBAUTHN_RP_NAME,
        user_name=user["email"],
        user_id=int(user["id"]).to_bytes(8, "big"),
        user_display_name=user["full_name"] or user["email"],
        challenge=challenge,
        authenticator_selection=AuthenticatorSelectionCriteria(
            authenticator_attachment=AuthenticatorAttachment.PLATFORM,
            resident_key=ResidentKeyRequirement.REQUIRED,
            user_verification=UserVerificationRequirement.REQUIRED,
        ),
        exclude_credentials=[PublicKeyCredentialDescriptor(id=bytes(row["credential_id"])) for row in existing],
    )
    store_webauthn_challenge(db, challenge, user["id"], "registration")
    db.commit()
    db.close()
    return jsonify(json.loads(options_to_json(options)))


def passkey_register_verify():
    data = request_json_object()
    if data is None:
        return jsonify({"error": "El cuerpo debe ser un objeto JSON"}), 400
    db = connect_db()
    user = current_user(db)
    if user is None or user["is_blocked"]:
        db.close()
        return jsonify({"error": "Debes iniciar sesión"}), 401
    challenge = consume_webauthn_challenge(db, user["id"], "registration")
    if challenge is None:
        db.close()
        return jsonify({"error": "La solicitud de huella expiró"}), 400
    rp_id, origin = webauthn_config()
    try:
        verification = verify_registration_response(
            credential=data,
            expected_challenge=challenge,
            expected_rp_id=rp_id,
            expected_origin=origin,
            require_user_verification=True,
        )
        db.execute(
            "INSERT INTO webauthn_credentials (user_id, credential_id, public_key, sign_count) VALUES (?, ?, ?, ?)",
            (user["id"], verification.credential_id, verification.credential_public_key, verification.sign_count),
        )
        db.commit()
    except Exception:
        db.close()
        return jsonify({"error": "No se pudo registrar la huella"}), 400
    db.close()
    return jsonify({"ok": True})


def passkey_login_options():
    db = connect_db()
    challenge = secrets.token_bytes(32)
    rp_id, _ = webauthn_config()
    options = generate_authentication_options(
        rp_id=rp_id,
        challenge=challenge,
        user_verification=UserVerificationRequirement.REQUIRED,
    )
    store_webauthn_challenge(db, challenge, None, "authentication")
    db.commit()
    db.close()
    return jsonify(json.loads(options_to_json(options)))


def passkey_login_verify():
    data = request_json_object()
    if data is None:
        return jsonify({"error": "El cuerpo debe ser un objeto JSON"}), 400
    raw_id = data.get("rawId") or data.get("id")
    if not isinstance(raw_id, str):
        return jsonify({"error": "Credencial de huella inválida"}), 400
    try:
        credential_id = base64url_to_bytes(raw_id)
    except Exception:
        return jsonify({"error": "Credencial de huella inválida"}), 400

    try:
        client_data = json.loads(base64url_to_bytes(data["response"]["clientDataJSON"]))
        signed_challenge = base64url_to_bytes(client_data["challenge"])
    except Exception:
        return jsonify({"error": "Credencial de huella inválida"}), 400

    db = connect_db()
    credential = db.execute(
        "SELECT user_id, public_key, sign_count FROM webauthn_credentials WHERE credential_id = ?",
        (credential_id,),
    ).fetchone()
    challenge = consume_webauthn_challenge_by_value(db, signed_challenge, "authentication")
    if credential is None or challenge is None:
        db.close()
        return jsonify({"error": "Huella no registrada o solicitud expirada"}), 401
    rp_id, origin = webauthn_config()
    try:
        verification = verify_authentication_response(
            credential=data,
            expected_challenge=challenge,
            expected_rp_id=rp_id,
            expected_origin=origin,
            credential_public_key=bytes(credential["public_key"]),
            credential_current_sign_count=credential["sign_count"],
            require_user_verification=True,
        )
    except Exception:
        db.close()
        return jsonify({"error": "No se pudo verificar la huella"}), 401
    db.execute(
        "UPDATE webauthn_credentials SET sign_count = ? WHERE credential_id = ?",
        (verification.new_sign_count, credential_id),
    )
    user = db.execute(
        "SELECT id, email, full_name, role, is_blocked FROM users WHERE id = ?",
        (credential["user_id"],),
    ).fetchone()
    if user is None or user["is_blocked"]:
        db.close()
        return jsonify({"error": "La cuenta está bloqueada o no existe"}), 403
    token = secrets.token_urlsafe(32)
    db.execute("INSERT INTO sessions (token, user_id) VALUES (?, ?)", (token, user["id"]))
    db.commit()
    db.close()
    return jsonify({**dict(user), "token": token})


@app.get("/api/reports")
def get_reports():
    db = connect_db()
    user = current_user(db)
    if user is None:
        db.close()
        return jsonify({"error": "Debes iniciar sesión"}), 401
    if user["is_blocked"]:
        db.close()
        return jsonify({"error": "La cuenta está bloqueada"}), 403
    rows = db.execute("""
        SELECT r.id, r.description, r.latitude, r.longitude, r.address,
               r.created_at, r.emergency_service, c.name AS category,
               c.report_type, s.name AS status
        FROM reports r
        JOIN users u ON u.id = r.user_id
        JOIN report_categories c ON c.id = r.category_id
        JOIN report_statuses s ON s.id = r.status_id
        ORDER BY r.created_at DESC
    """).fetchall()
    db.close()
    return jsonify([report_json(row, exact_location=user["role"] in ("staff", "admin")) for row in rows])


@app.post("/api/logout")
def logout():
    auth = request.headers.get("Authorization", "")
    token = auth[7:] if auth.startswith("Bearer ") else ""
    if token:
        db = connect_db()
        db.execute("DELETE FROM sessions WHERE token = ?", (token,))
        db.commit()
        db.close()
    return jsonify({"ok": True})


@app.post("/api/reports")
def create_report():
    data = request_json_object()
    if data is None:
        return jsonify({"error": "El cuerpo debe ser un objeto JSON"}), 400
    report_type = data.get("type")
    category = " ".join(str(data.get("category", "")).split())[:80]
    description = str(data.get("description", "")).strip()
    emergency_service = " ".join(str(data.get("emergency_service", "")).split())[:80]
    if report_type not in ("em", "pr") or not category:
        return jsonify({"error": "Faltan datos del reporte"}), 400
    if report_type == "em" and emergency_service not in EMERGENCY_SERVICES:
        return jsonify({"error": "Selecciona el servicio de emergencia"}), 400
    if report_type == "pr":
        emergency_service = None
    lat = parse_coord(data.get("latitude"), -90, 90)
    lon = parse_coord(data.get("longitude"), -180, 180)
    if lat is None or lon is None:
        return jsonify({"error": "Ubicación inválida"}), 400
    if not is_service_location(lat, lon):
        return jsonify({"error": "La ubicación está fuera de la zona de servicio"}), 400

    db = connect_db()
    user = current_user(db)
    if user is None:
        db.close()
        return jsonify({"error": "Debes iniciar sesión"}), 401
    if user["is_blocked"]:
        db.close()
        return jsonify({"error": "La cuenta está bloqueada"}), 403

    category_type = "emergency" if report_type == "em" else "problem"
    cat = db.execute("SELECT id FROM report_categories WHERE report_type = ? AND name = ?", (category_type, category)).fetchone()
    if cat is None:
        db.execute("INSERT OR IGNORE INTO report_categories (report_type, name) VALUES (?, ?)", (category_type, category))
        cat = db.execute("SELECT id FROM report_categories WHERE report_type = ? AND name = ?", (category_type, category)).fetchone()

    cur = db.execute("""
        INSERT INTO reports (user_id, category_id, status_id, description, latitude, longitude, address, emergency_service)
        VALUES (?, ?, 1, ?, ?, ?, ?, ?)
    """, (user["id"], cat["id"], description[:1000], lat, lon,
          str(data.get("address") or "")[:200] or None, emergency_service))
    report_id = cur.lastrowid
    db.execute("INSERT INTO report_status_history (report_id, status_id, changed_by, note) VALUES (?, 1, ?, ?)", (report_id, user["id"], "Reporte creado"))
    db.commit()
    db.close()
    return jsonify({"ok": True, "id": report_id}), 201


@app.post("/api/reports/<int:report_id>/location")
def update_report_location(report_id):
    """Actualiza la última ubicación compartida por la persona que creó un reporte de robo."""
    data = request_json_object()
    if data is None:
        return jsonify({"error": "El cuerpo debe ser un objeto JSON"}), 400
    lat = parse_coord(data.get("latitude"), -90, 90)
    lon = parse_coord(data.get("longitude"), -180, 180)
    if lat is None or lon is None:
        return jsonify({"error": "Ubicación inválida"}), 400
    if not is_service_location(lat, lon):
        return jsonify({"error": "La ubicación está fuera de la zona de servicio"}), 400

    db = connect_db()
    user = current_user(db)
    if user is None:
        db.close()
        return jsonify({"error": "Debes iniciar sesión"}), 401
    if user["is_blocked"]:
        db.close()
        return jsonify({"error": "La cuenta está bloqueada"}), 403

    report = db.execute("""
        SELECT r.user_id, c.report_type, c.name AS category
        FROM reports r JOIN report_categories c ON c.id = r.category_id
        WHERE r.id = ?
    """, (report_id,)).fetchone()
    if report is None or report["user_id"] != user["id"]:
        db.close()
        return jsonify({"error": "Reporte no encontrado"}), 404
    if report["report_type"] != "emergency" or report["category"] != "Robo o asalto":
        db.close()
        return jsonify({"error": "El seguimiento solo está disponible para reportes de robo o asalto"}), 400

    db.execute("UPDATE reports SET latitude = ?, longitude = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?", (lat, lon, report_id))
    db.commit()
    db.close()
    return jsonify({"ok": True})


# --- Portal municipal (solo funcionarios) ---

@app.get("/api/users")
def list_users():
    db = connect_db()
    if not staff_user(db):
        db.close()
        return jsonify({"error": "No autorizado"}), 403
    rows = db.execute("""
        SELECT u.id, u.email, u.full_name, u.role, u.is_blocked,
               (SELECT COUNT(*) FROM reports r WHERE r.user_id = u.id) AS reports
        FROM users u ORDER BY u.id
    """).fetchall()
    db.close()
    return jsonify([dict(r) for r in rows])


@app.post("/api/reports/<int:report_id>/status")
def set_status(report_id):
    data = request_json_object()
    if data is None:
        return jsonify({"error": "El cuerpo debe ser un objeto JSON"}), 400
    status = data.get("status")
    if not isinstance(status, str):
        return jsonify({"error": "Estado inválido"}), 400
    db = connect_db()
    staff = staff_user(db)
    if not staff:
        db.close()
        return jsonify({"error": "No autorizado"}), 403
    st = db.execute("SELECT id FROM report_statuses WHERE name = ?", (status,)).fetchone()
    if st is None or db.execute("SELECT 1 FROM reports WHERE id = ?", (report_id,)).fetchone() is None:
        db.close()
        return jsonify({"error": "Datos inválidos"}), 400
    db.execute("UPDATE reports SET status_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?", (st["id"], report_id))
    db.execute("INSERT INTO report_status_history (report_id, status_id, changed_by, note) VALUES (?, ?, ?, ?)",
               (report_id, st["id"], staff["id"], "Cambio desde portal municipal"))
    db.commit()
    db.close()
    return jsonify({"ok": True})


@app.post("/api/users/<int:user_id>/block")
def block_user(user_id):
    data = request_json_object()
    if data is None:
        return jsonify({"error": "El cuerpo debe ser un objeto JSON"}), 400
    blocked = data.get("blocked")
    if blocked not in (True, False, 0, 1):
        return jsonify({"error": "Estado de bloqueo inválido"}), 400
    db = connect_db()
    if not staff_user(db):
        db.close()
        return jsonify({"error": "No autorizado"}), 403
    db.execute("UPDATE users SET is_blocked = ? WHERE id = ? AND role = 'citizen'", (int(bool(blocked)), user_id))
    db.commit()
    db.close()
    return jsonify({"ok": True})


@app.route("/", defaults={"path": ""})
@app.route("/<path:path>")
def frontend(path):
    if path in PUBLIC_FILES:
        return send_from_directory(ROOT, path)
    if path == "api" or path.startswith("api/"):
        return jsonify({"error": "Recurso no encontrado"}), 404
    if not path or "." not in path:
        return send_from_directory(ROOT, INDEX)
    abort(404)


ensure_database()

if __name__ == "__main__":
    ssl_context = (SSL_CERT_FILE, SSL_KEY_FILE) if SSL_CERT_FILE and SSL_KEY_FILE else None
    app.run(host="0.0.0.0", port=PORT, debug=False, ssl_context=ssl_context)
