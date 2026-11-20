-- Base de datos SQLite para Calle Segura
PRAGMA foreign_keys = ON;

BEGIN TRANSACTION;

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  full_name TEXT,
  role TEXT NOT NULL DEFAULT 'citizen' CHECK (role IN ('citizen', 'staff', 'admin')),
  is_blocked INTEGER NOT NULL DEFAULT 0 CHECK (is_blocked IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS report_categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  report_type TEXT NOT NULL CHECK (report_type IN ('emergency', 'problem')),
  name TEXT NOT NULL,
  UNIQUE (report_type, name)
);

CREATE TABLE IF NOT EXISTS report_statuses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  sort_order INTEGER NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  category_id INTEGER NOT NULL,
  status_id INTEGER NOT NULL DEFAULT 1,
  description TEXT NOT NULL,
  latitude REAL NOT NULL,
  longitude REAL NOT NULL,
  address TEXT,
  emergency_service TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (category_id) REFERENCES report_categories(id),
  FOREIGN KEY (status_id) REFERENCES report_statuses(id)
);

CREATE TABLE IF NOT EXISTS report_evidence (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  report_id INTEGER NOT NULL,
  file_name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  file_path TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (report_id) REFERENCES reports(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS report_status_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  report_id INTEGER NOT NULL,
  status_id INTEGER NOT NULL,
  changed_by INTEGER,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (report_id) REFERENCES reports(id) ON DELETE CASCADE,
  FOREIGN KEY (status_id) REFERENCES report_statuses(id),
  FOREIGN KEY (changed_by) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_reports_user ON reports(user_id);
CREATE INDEX IF NOT EXISTS idx_reports_status ON reports(status_id);
CREATE INDEX IF NOT EXISTS idx_reports_created ON reports(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_evidence_report ON report_evidence(report_id);

INSERT OR IGNORE INTO report_statuses (id, name, sort_order) VALUES
  (1, 'Nuevo', 1),
  (2, 'Visto', 2),
  (3, 'En curso', 3),
  (4, 'Resuelto', 4);

INSERT OR IGNORE INTO report_categories (report_type, name) VALUES
  ('emergency', 'Robo o asalto'),
  ('emergency', 'Incendio'),
  ('emergency', 'Accidente'),
  ('emergency', 'Persona en riesgo'),
  ('problem', 'Luminaria apagada'),
  ('problem', 'Basura acumulada'),
  ('problem', 'Bache o vereda dañada'),
  ('problem', 'Grafiti');

-- password_hash 'demo_hash...' se reemplaza por un hash real al iniciar app.py
INSERT OR IGNORE INTO users (email, password_hash, full_name, role) VALUES
  ('vecina@correo.cl', 'demo_hash_vecina', 'Vecina de prueba', 'citizen'),
  ('jorge@correo.cl', 'demo_hash_jorge', 'Jorge de prueba', 'citizen'),
  ('ana@correo.cl', 'demo_hash_ana', 'Ana de prueba', 'citizen'),
  ('luis@correo.cl', 'demo_hash_luis', 'Luis de prueba', 'citizen'),
  ('funcionario@municipalidad.cl', 'demo_hash_funcionario', 'Funcionario municipal', 'staff');

INSERT INTO reports (id, user_id, category_id, status_id, description, latitude, longitude, address, created_at)
SELECT 1, u.id, c.id, 1, 'Robo de celular a peatón en la esquina, el sujeto huyó hacia el norte.', -37.60810, -73.65020, 'Calle Prat con Calle Lira', datetime('now', '-2 hours')
FROM users u JOIN report_categories c ON c.report_type = 'emergency' AND c.name = 'Robo o asalto'
WHERE u.email = 'vecina@correo.cl'
ON CONFLICT(id) DO NOTHING;

INSERT INTO reports (id, user_id, category_id, status_id, description, latitude, longitude, address, created_at)
SELECT 2, u.id, c.id, 2, 'Tres postes sin luz en la cuadra. De noche queda muy oscuro.', -37.61250, -73.64610, 'Av. Santa Rosa con Calle Lira', datetime('now', '-30 minutes')
FROM users u JOIN report_categories c ON c.report_type = 'problem' AND c.name = 'Luminaria apagada'
WHERE u.email = 'jorge@correo.cl'
ON CONFLICT(id) DO NOTHING;

INSERT INTO reports (id, user_id, category_id, status_id, description, latitude, longitude, address, created_at)
SELECT 3, u.id, c.id, 3, 'Hoyo grande en la calzada. Ya hubo un ciclista caído.', -37.60460, -73.65480, 'Calle Prat con Av. Matta', datetime('now', '-52 minutes')
FROM users u JOIN report_categories c ON c.report_type = 'problem' AND c.name = 'Bache o vereda dañada'
WHERE u.email = 'ana@correo.cl'
ON CONFLICT(id) DO NOTHING;

INSERT INTO reports (id, user_id, category_id, status_id, description, latitude, longitude, address, created_at)
SELECT 4, u.id, c.id, 4, 'Escombros dejados en la plaza hace una semana.', -37.61530, -73.65890, 'Av. Santa Rosa con Av. Matta', datetime('now', '-100 minutes')
FROM users u JOIN report_categories c ON c.report_type = 'problem' AND c.name = 'Basura acumulada'
WHERE u.email = 'luis@correo.cl'
ON CONFLICT(id) DO NOTHING;

INSERT OR IGNORE INTO report_status_history (report_id, status_id, changed_by, note)
SELECT id, status_id, (SELECT id FROM users WHERE email = 'funcionario@municipalidad.cl'), 'Estado inicial de la demo'
FROM reports;

COMMIT;
