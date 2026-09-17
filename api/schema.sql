CREATE TABLE IF NOT EXISTS leads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT,
  email TEXT NOT NULL,
  score INTEGER,
  rung TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
