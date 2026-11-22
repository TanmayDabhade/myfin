//! The saved workspace is one JSON object shared by every window. Windows send
//! only what they changed, as operations on paths one or two keys deep:
//! `["set", [key], value]`, `["set", [key, entry], value]`, `["del", path]` and
//! `["obj", [key]]` (make `key` an object, keeping its entries if it already is
//! one). Two levels is enough for the maps the workspace holds (prices per
//! symbol, macro series, notes), so two windows loading different symbols
//! don't overwrite each other.
use serde_json::{json, Map, Value};

pub type Path = Vec<String>;

fn path_of(v: &Value) -> Result<Path, String> {
    let parts = v.as_array().ok_or("Invalid workspace path")?;
    if parts.is_empty() || parts.len() > 2 {
        return Err("Invalid workspace path".into());
    }
    parts
        .iter()
        .map(|p| p.as_str().filter(|s| !s.is_empty() && s.len() <= 200).map(String::from).ok_or_else(|| "Invalid workspace path".to_string()))
        .collect()
}

fn object(v: &mut Value) -> &mut Map<String, Value> {
    if !v.is_object() {
        *v = Value::Object(Map::new());
    }
    v.as_object_mut().expect("just made an object")
}

/// Applies `ops` in order and returns the paths they touched.
pub fn apply(body: &mut Value, ops: &[Value]) -> Result<Vec<Path>, String> {
    let mut touched = Vec::with_capacity(ops.len());
    for op in ops {
        let parts = op.as_array().ok_or("Invalid workspace change")?;
        let kind = parts.first().and_then(Value::as_str).ok_or("Invalid workspace change")?;
        let path = path_of(parts.get(1).ok_or("Invalid workspace change")?)?;
        let root = object(body);
        match (kind, path.as_slice()) {
            ("set", [k]) => {
                root.insert(k.clone(), parts.get(2).cloned().ok_or("Missing value")?);
            }
            ("set", [k, e]) => {
                object(root.entry(k.clone()).or_insert(Value::Null)).insert(e.clone(), parts.get(2).cloned().ok_or("Missing value")?);
            }
            ("del", [k]) => {
                root.remove(k);
            }
            ("del", [k, e]) => {
                if let Some(Value::Object(m)) = root.get_mut(k) {
                    m.remove(e);
                }
            }
            ("obj", [k]) => {
                object(root.entry(k.clone()).or_insert(Value::Null));
            }
            _ => return Err("Invalid workspace change".into()),
        }
        touched.push(path);
    }
    Ok(touched)
}

/// The current value at each path: `{p, v}`, `{p, obj: true}` for an object
/// at the top level (its entries are read by their own paths), or `{p, gone: true}`.
pub fn read(body: &Value, paths: &[Path]) -> Value {
    Value::Array(
        paths
            .iter()
            .map(|p| {
                let found = match p.as_slice() {
                    [k] => body.get(k),
                    [k, e] => body.get(k).and_then(Value::as_object).and_then(|m| m.get(e)),
                    _ => None,
                };
                match (found, p.len()) {
                    (None, _) => json!({"p": p, "gone": true}),
                    (Some(Value::Object(_)), 1) => json!({"p": p, "obj": true}),
                    (Some(v), _) => json!({"p": p, "v": v}),
                }
            })
            .collect(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sets_and_deletes_one_and_two_levels_deep() {
        let mut b = json!({"mode": "sample", "marketAssets": {"AAPL": {"p": 1}}});
        let ops = vec![
            json!(["set", ["mode"], "market"]),
            json!(["set", ["marketAssets", "MSFT"], {"p": 2}]),
            json!(["del", ["marketAssets", "AAPL"]]),
            json!(["set", ["watchlist"], ["MSFT"]]),
        ];
        let touched = apply(&mut b, &ops).unwrap();
        assert_eq!(b, json!({"mode": "market", "marketAssets": {"MSFT": {"p": 2}}, "watchlist": ["MSFT"]}));
        assert_eq!(touched.len(), 4);
    }

    #[test]
    fn entries_written_by_two_windows_both_survive() {
        let mut b = json!({"marketAssets": {}});
        apply(&mut b, &[json!(["set", ["marketAssets", "AAPL"], 1])]).unwrap();
        apply(&mut b, &[json!(["set", ["marketAssets", "MSFT"], 2])]).unwrap();
        assert_eq!(b["marketAssets"], json!({"AAPL": 1, "MSFT": 2}));
    }

    #[test]
    fn obj_keeps_existing_entries_and_replaces_scalars() {
        let mut b = json!({"notes": {"a": 1}, "macro": 5});
        apply(&mut b, &[json!(["obj", ["notes"]]), json!(["obj", ["macro"]])]).unwrap();
        assert_eq!(b, json!({"notes": {"a": 1}, "macro": {}}));
    }

    #[test]
    fn a_null_value_is_kept_and_an_empty_workspace_starts_as_an_object() {
        let mut b = Value::Null;
        apply(&mut b, &[json!(["set", ["lastSync"], null])]).unwrap();
        assert_eq!(b, json!({"lastSync": null}));
    }

    #[test]
    fn rejects_bad_paths_and_kinds() {
        let mut b = json!({});
        for op in [json!(["set", [], 1]), json!(["set", ["a", "b", "c"], 1]), json!(["set", [""], 1]), json!(["put", ["a"], 1]), json!(["set", ["a"]]), json!(["obj", ["a", "b"]])] {
            assert!(apply(&mut b, &[op]).is_err());
        }
    }

    #[test]
    fn reads_values_objects_and_missing_paths() {
        let b = json!({"mode": "market", "marketAssets": {"AAPL": 1}});
        let p = |x: &[&str]| x.iter().map(|s| s.to_string()).collect::<Path>();
        assert_eq!(
            read(&b, &[p(&["mode"]), p(&["marketAssets"]), p(&["marketAssets", "AAPL"]), p(&["marketAssets", "MSFT"]), p(&["gone"])]),
            json!([
                {"p": ["mode"], "v": "market"},
                {"p": ["marketAssets"], "obj": true},
                {"p": ["marketAssets", "AAPL"], "v": 1},
                {"p": ["marketAssets", "MSFT"], "gone": true},
                {"p": ["gone"], "gone": true}
            ])
        );
    }
}
