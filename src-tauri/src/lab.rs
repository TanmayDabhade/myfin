//! Quant Lab record store, in the workspace database. Bodies are JSON from the
//! research engine. Write-once records (datasets, runs, frozen selections,
//! holdout evaluations, job events) can be written again only with the exact
//! same body, so a holdout result can never be replaced or re-run quietly.
use rusqlite::{params, Connection, OptionalExtension};

pub const SCHEMA: &str = "CREATE TABLE IF NOT EXISTS quant_lab(
    kind TEXT NOT NULL, id TEXT NOT NULL, parent TEXT, body TEXT NOT NULL,
    immutable INTEGER NOT NULL, created INTEGER NOT NULL, PRIMARY KEY(kind, id)) WITHOUT ROWID;
  CREATE INDEX IF NOT EXISTS quant_lab_parent ON quant_lab(kind, parent, created);";

const KINDS: [&str; 6] = ["experiment", "snapshot", "run", "selection", "holdout", "event"];
const WRITE_ONCE: [&str; 5] = ["snapshot", "run", "selection", "holdout", "event"];
const MAX_BODY: usize = 16_000_000;

fn check(kind: &str, id: &str) -> Result<(), String> {
    if !KINDS.contains(&kind) {
        return Err("Unknown Quant Lab record".into());
    }
    if id.is_empty() || id.len() > 120 || !id.chars().all(|c| c.is_ascii_alphanumeric() || "_-:.".contains(c)) {
        return Err("Invalid Quant Lab record id".into());
    }
    Ok(())
}

pub fn put(db: &Connection, kind: &str, id: &str, parent: Option<&str>, body: &str, immutable: bool, now: i64) -> Result<(), String> {
    check(kind, id)?;
    if body.len() > MAX_BODY {
        return Err("Quant Lab record exceeds 16 MB".into());
    }
    serde_json::from_str::<serde_json::Value>(body).map_err(|_| "Quant Lab record is not JSON".to_string())?;
    let write_once = immutable || WRITE_ONCE.contains(&kind);
    let existing: Option<(String, i64)> = db
        .query_row("SELECT body, immutable FROM quant_lab WHERE kind=?1 AND id=?2", params![kind, id], |r| Ok((r.get(0)?, r.get(1)?)))
        .optional()
        .map_err(|e| e.to_string())?;
    if let Some((old, locked)) = existing {
        if write_once || locked != 0 {
            return if old == body { Ok(()) } else { Err(format!("This {kind} is already recorded and can't be changed.")) };
        }
        db.execute("UPDATE quant_lab SET body=?3, parent=?4 WHERE kind=?1 AND id=?2", params![kind, id, body, parent])
            .map_err(|e| e.to_string())?;
        return Ok(());
    }
    db.execute(
        "INSERT INTO quant_lab(kind,id,parent,body,immutable,created) VALUES(?1,?2,?3,?4,?5,?6)",
        params![kind, id, parent, body, write_once as i64, now],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn get(db: &Connection, kind: &str, id: &str) -> Result<Option<String>, String> {
    check(kind, id)?;
    db.query_row("SELECT body FROM quant_lab WHERE kind=?1 AND id=?2", params![kind, id], |r| r.get(0))
        .optional()
        .map_err(|e| e.to_string())
}

pub fn list(db: &Connection, kind: &str, parent: Option<&str>) -> Result<Vec<String>, String> {
    check(kind, "list")?;
    let mut st = db
        .prepare("SELECT body FROM quant_lab WHERE kind=?1 AND (?2 IS NULL OR parent=?2) ORDER BY created, id")
        .map_err(|e| e.to_string())?;
    let rows = st.query_map(params![kind, parent], |r| r.get(0)).map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<String>, _>>().map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn db() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch(SCHEMA).unwrap();
        c
    }
    #[test]
    fn write_once_records_cannot_change() {
        let c = db();
        put(&c, "holdout", "sel_1", Some("exp_1"), r#"{"a":1}"#, false, 1).unwrap();
        // The same body again is fine (a retried request).
        put(&c, "holdout", "sel_1", Some("exp_1"), r#"{"a":1}"#, false, 2).unwrap();
        assert!(put(&c, "holdout", "sel_1", Some("exp_1"), r#"{"a":2}"#, false, 3).is_err());
        assert_eq!(get(&c, "holdout", "sel_1").unwrap().unwrap(), r#"{"a":1}"#);
    }
    #[test]
    fn experiments_update_and_list_by_parent() {
        let c = db();
        put(&c, "experiment", "exp_1", None, r#"{"v":1}"#, false, 1).unwrap();
        put(&c, "experiment", "exp_1", None, r#"{"v":2}"#, false, 2).unwrap();
        assert_eq!(list(&c, "experiment", None).unwrap(), vec![r#"{"v":2}"#.to_string()]);
        put(&c, "run", "run_a", Some("exp_1"), "{}", true, 3).unwrap();
        put(&c, "run", "run_b", Some("exp_2"), "{}", true, 4).unwrap();
        assert_eq!(list(&c, "run", Some("exp_1")).unwrap().len(), 1);
    }
    #[test]
    fn rejects_unknown_kinds_ids_and_non_json() {
        let c = db();
        assert!(put(&c, "workspace", "x", None, "{}", false, 1).is_err());
        assert!(put(&c, "run", "../x", None, "{}", false, 1).is_err());
        assert!(put(&c, "run", "x", None, "not json", false, 1).is_err());
    }
}
