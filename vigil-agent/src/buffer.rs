use anyhow::Result;
use rusqlite::Connection;

/// SQLite-backed event buffer that stores monitoring events locally
/// when the Hub connection is unavailable.
pub struct EventBuffer {
    conn: Connection,
}

impl EventBuffer {
    /// Open (or create) the SQLite buffer database.
    pub fn new(path: &str) -> Result<Self> {
        let conn = Connection::open(path)?;

        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS events (
                id    INTEGER PRIMARY KEY AUTOINCREMENT,
                data  TEXT NOT NULL,
                ts    TEXT NOT NULL DEFAULT (datetime('now'))
            );
            CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);",
        )?;

        // Keep the DB lean
        conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;")?;

        Ok(Self { conn })
    }

    /// Push an event into the buffer.
    pub fn push(&mut self, event: &str) -> Result<()> {
        self.conn
            .execute("INSERT INTO events (data) VALUES (?1)", [event])?;
        Ok(())
    }

    /// Drain up to `limit` oldest events from the buffer, deleting them after retrieval.
    pub fn drain(&mut self, limit: usize) -> Result<Vec<String>> {
        let mut stmt = self
            .conn
            .prepare("SELECT id, data FROM events ORDER BY id ASC LIMIT ?1")?;

        let rows: Vec<(i64, String)> = stmt
            .query_map([limit], |row| Ok((row.get(0)?, row.get(1)?)))?
            .collect::<Result<Vec<_>, _>>()?;

        if !rows.is_empty() {
            let ids: Vec<String> = rows.iter().map(|(id, _)| id.to_string()).collect();
            let placeholders = ids.join(",");
            self.conn.execute(
                &format!("DELETE FROM events WHERE id IN ({placeholders})"),
                [],
            )?;
        }

        Ok(rows.into_iter().map(|(_, data)| data).collect())
    }

    /// Number of buffered events.
    #[allow(dead_code)]
    pub fn count(&self) -> Result<usize> {
        let count: usize = self
            .conn
            .query_row("SELECT COUNT(*) FROM events", [], |row| row.get(0))?;
        Ok(count)
    }
}
