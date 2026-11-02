CREATE TABLE contacts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  contact_kind TEXT NOT NULL CHECK (contact_kind IN ('phone', 'wechat', 'qq', 'email', 'other')),
  contact_text TEXT NOT NULL,
  city TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 1),
  import_fingerprint TEXT,
  deleted INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1))
);
CREATE INDEX contacts_visible ON contacts(deleted, name, id);
CREATE INDEX contacts_city ON contacts(deleted, city);
CREATE UNIQUE INDEX contacts_fingerprint ON contacts(import_fingerprint) WHERE import_fingerprint IS NOT NULL;
CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL,
  auth_version TEXT NOT NULL
);
CREATE INDEX sessions_expiry ON sessions(expires_at);
CREATE TABLE rate_limits (
  bucket TEXT PRIMARY KEY,
  attempts INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX rate_limits_expiry ON rate_limits(expires_at);
CREATE TABLE import_batches (
  digest TEXT PRIMARY KEY,
  imported_at TEXT NOT NULL,
  added INTEGER NOT NULL,
  updated INTEGER NOT NULL,
  removed INTEGER NOT NULL
);
CREATE TABLE import_state (id INTEGER PRIMARY KEY CHECK (id = 1), revision INTEGER NOT NULL);
INSERT INTO import_state VALUES (1, 0);
CREATE TABLE import_guard (id INTEGER PRIMARY KEY CHECK (id = 1), valid INTEGER NOT NULL CHECK (valid = 1));
CREATE TRIGGER contacts_insert_revision AFTER INSERT ON contacts BEGIN UPDATE import_state SET revision = revision + 1 WHERE id = 1; END;
CREATE TRIGGER contacts_update_revision AFTER UPDATE ON contacts BEGIN UPDATE import_state SET revision = revision + 1 WHERE id = 1; END;
CREATE TRIGGER contacts_delete_revision AFTER DELETE ON contacts BEGIN UPDATE import_state SET revision = revision + 1 WHERE id = 1; END;
