//! The app was called Market Lens until 0.3. Its data lived in the
//! `com.marketlens.desktop` app-data folder, in `market-lens.sqlite`. On the
//! first launch of Aperture those files move to the new folder so nobody loses
//! their workspace, saved keys or downloaded SEC data.
use std::path::Path;

pub const OLD_IDENTIFIER: &str = "com.marketlens.desktop";
pub const DB: &str = "aperture.sqlite";

// Each group moves together or not at all: a database without its WAL file
// would lose recent writes. WAL and SHM files go first, the database last.
const GROUPS: &[&[(&str, &str)]] = &[
    &[
        ("market-lens.sqlite-wal", "aperture.sqlite-wal"),
        ("market-lens.sqlite-shm", "aperture.sqlite-shm"),
        ("market-lens.sqlite", DB),
    ],
    &[
        ("reference.sqlite-wal", "reference.sqlite-wal"),
        ("reference.sqlite-shm", "reference.sqlite-shm"),
        ("reference.sqlite", "reference.sqlite"),
    ],
    &[("credentials.json", "credentials.json")],
    &[("f13", "f13")],
];

/// Moves Market Lens data from `old` into `new` when `new` has no Aperture
/// database yet. Returns the names of the files that moved. Files already
/// present in `new` are never overwritten. Everything else in `old` (such as
/// web view caches) is left where it is.
pub fn migrate(old: &Path, new: &Path) -> std::io::Result<Vec<String>> {
    let mut moved = Vec::new();
    if new.join(DB).exists() || !old.join("market-lens.sqlite").exists() {
        return Ok(moved);
    }
    std::fs::create_dir_all(new)?;
    let mut first_error = None;
    for group in GROUPS {
        let mut done: Vec<(&str, &str)> = Vec::new();
        let mut failed = None;
        for &(from, to) in group.iter() {
            let (src, dst) = (old.join(from), new.join(to));
            if !src.exists() {
                continue;
            }
            if dst.exists() {
                failed = Some(std::io::Error::new(
                    std::io::ErrorKind::AlreadyExists,
                    format!("{to} already exists"),
                ));
                break;
            }
            match std::fs::rename(&src, &dst) {
                Ok(()) => done.push((from, to)),
                Err(e) => {
                    failed = Some(e);
                    break;
                }
            }
        }
        match failed {
            // Put back what this group already moved so the old copy stays whole.
            Some(e) => {
                for &(from, to) in done.iter().rev() {
                    let _ = std::fs::rename(new.join(to), old.join(from));
                }
                first_error.get_or_insert(e);
            }
            None => moved.extend(done.iter().map(|&(_, to)| to.to_string())),
        }
    }
    match first_error {
        Some(e) if moved.is_empty() => Err(e),
        _ => Ok(moved),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn dirs(name: &str) -> (std::path::PathBuf, std::path::PathBuf) {
        let root = std::env::temp_dir().join(format!("aperture-legacy-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let (old, new) = (root.join(OLD_IDENTIFIER), root.join("com.aperture.desktop"));
        fs::create_dir_all(&old).unwrap();
        (old, new)
    }

    #[test]
    fn moves_market_lens_data_into_the_new_folder() {
        let (old, new) = dirs("move");
        for f in ["market-lens.sqlite", "market-lens.sqlite-wal", "market-lens.sqlite-shm", "reference.sqlite", "credentials.json"] {
            fs::write(old.join(f), f).unwrap();
        }
        fs::create_dir_all(old.join("f13")).unwrap();
        fs::write(old.join("f13/2026q3.zip"), "zip").unwrap();
        fs::create_dir_all(old.join("EBWebView")).unwrap();

        let moved = migrate(&old, &new).unwrap();
        assert_eq!(moved.len(), 6);
        assert_eq!(fs::read_to_string(new.join(DB)).unwrap(), "market-lens.sqlite");
        assert_eq!(fs::read_to_string(new.join("aperture.sqlite-wal")).unwrap(), "market-lens.sqlite-wal");
        assert_eq!(fs::read_to_string(new.join("credentials.json")).unwrap(), "credentials.json");
        assert_eq!(fs::read_to_string(new.join("f13/2026q3.zip")).unwrap(), "zip");
        assert!(!old.join("market-lens.sqlite").exists());
        assert!(old.join("EBWebView").exists(), "unrelated files stay behind");
        // A second launch does nothing.
        assert!(migrate(&old, &new).unwrap().is_empty());
    }

    #[test]
    fn never_touches_an_existing_aperture_database() {
        let (old, new) = dirs("existing");
        fs::create_dir_all(&new).unwrap();
        fs::write(old.join("market-lens.sqlite"), "old").unwrap();
        fs::write(new.join(DB), "new").unwrap();
        assert!(migrate(&old, &new).unwrap().is_empty());
        assert_eq!(fs::read_to_string(new.join(DB)).unwrap(), "new");
        assert!(old.join("market-lens.sqlite").exists());
    }

    #[test]
    fn keeps_a_group_whole_when_one_file_cannot_move() {
        let (old, new) = dirs("partial");
        fs::create_dir_all(&new).unwrap();
        fs::write(old.join("market-lens.sqlite"), "db").unwrap();
        fs::write(old.join("reference.sqlite-wal"), "wal").unwrap();
        fs::write(old.join("reference.sqlite"), "ref").unwrap();
        fs::write(new.join("reference.sqlite"), "taken").unwrap();
        let moved = migrate(&old, &new).unwrap();
        assert_eq!(moved, vec![DB.to_string()]);
        // The reference WAL went back next to its database.
        assert!(old.join("reference.sqlite-wal").exists());
        assert!(!new.join("reference.sqlite-wal").exists());
    }

    #[test]
    fn fresh_install_does_nothing() {
        let (old, new) = dirs("fresh");
        fs::remove_dir_all(&old).unwrap();
        assert!(migrate(&old, &new).unwrap().is_empty());
        assert!(!new.exists());
    }
}
