//! Live AIS vessel positions from AISStream. This module holds the pure parts
//! (subscription, classification, bounded storage, backoff); the websocket
//! loop lives in the desktop binary.
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashMap;

pub const STREAM_URL: &str = "wss://stream.aisstream.io/v0/stream";
/// Most vessels kept at once, and how long an unseen vessel is kept.
pub const MAX_VESSELS: usize = 2_000;
pub const MAX_AGE_SECS: i64 = 2 * 3600;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct BBox {
    pub south: f64,
    pub west: f64,
    pub north: f64,
    pub east: f64,
}

impl BBox {
    /// A box of `radius` degrees around a point, clamped to valid coordinates.
    pub fn around(lat: f64, lon: f64, radius: f64) -> Result<Self, String> {
        if !lat.is_finite() || !lon.is_finite() || lat.abs() > 90.0 || lon.abs() > 180.0 || !(0.1..=5.0).contains(&radius) {
            return Err("Invalid vessel area".into());
        }
        Ok(BBox {
            south: (lat - radius).max(-90.0),
            north: (lat + radius).min(90.0),
            west: (lon - radius).max(-180.0),
            east: (lon + radius).min(180.0),
        })
    }
    pub fn contains(&self, lat: f64, lon: f64) -> bool {
        lat >= self.south && lat <= self.north && lon >= self.west && lon <= self.east
    }
}

/// The key goes only into this message, sent over the encrypted websocket.
pub fn subscription(key: &str, b: &BBox) -> String {
    json!({
        "APIKey": key,
        "BoundingBoxes": [[[b.south, b.west], [b.north, b.east]]],
        "FilterMessageTypes": ["PositionReport", "ShipStaticData", "StandardClassBPositionReport"],
    })
    .to_string()
}

/// AIS ship-type codes: 70–79 cargo, 80–89 tanker. A tanker code describes
/// the hull, not what it is carrying.
pub fn classify(code: Option<i64>) -> &'static str {
    match code {
        Some(70..=79) => "cargo",
        Some(80..=89) => "tanker",
        Some(30..=39) | Some(50..=59) => "service",
        Some(60..=69) => "passenger",
        Some(_) => "other",
        None => "unknown",
    }
}

pub fn nav_status(code: Option<i64>) -> &'static str {
    match code {
        Some(0) => "Under way (engine)",
        Some(1) => "At anchor",
        Some(2) => "Not under command",
        Some(3) => "Restricted manoeuvrability",
        Some(5) => "Moored",
        Some(6) => "Aground",
        Some(7) => "Fishing",
        Some(8) => "Under way (sailing)",
        _ => "Not reported",
    }
}

#[derive(Serialize, Clone, Debug, Default, PartialEq)]
pub struct Vessel {
    pub mmsi: u64,
    pub name: String,
    pub lat: f64,
    pub lon: f64,
    pub sog: Option<f64>,
    pub cog: Option<f64>,
    pub status: String,
    pub class: String,
    pub type_code: Option<i64>,
    pub destination: String,
    pub seen: i64,
}

fn field<'a>(v: &'a Value, names: &[&str]) -> Option<&'a Value> {
    names.iter().find_map(|n| v.get(*n)).filter(|x| !x.is_null())
}
fn text(v: &Value, names: &[&str]) -> String {
    field(v, names).and_then(Value::as_str).unwrap_or("").trim().chars().take(60).collect()
}
fn num(v: &Value, names: &[&str]) -> Option<f64> {
    field(v, names).and_then(Value::as_f64).filter(|x| x.is_finite())
}

#[derive(Default)]
pub struct Store {
    pub vessels: HashMap<u64, Vessel>,
    /// Ship types learned from static reports, applied to later positions.
    types: HashMap<u64, (i64, String)>,
}

impl Store {
    /// Applies one AISStream message. Returns false for messages it ignores.
    pub fn apply(&mut self, msg: &Value, bbox: &BBox, now: i64) -> bool {
        let kind = msg["MessageType"].as_str().unwrap_or("");
        let meta = &msg["MetaData"];
        let Some(mmsi) = meta["MMSI"].as_u64().filter(|m| (100_000_000..=999_999_999).contains(m)) else {
            return false;
        };
        let body = &msg["Message"][kind];
        if kind == "ShipStaticData" {
            let Some(code) = field(body, &["Type", "ShipType"]).and_then(Value::as_i64) else { return false };
            let dest = text(body, &["Destination"]);
            self.types.insert(mmsi, (code, dest.clone()));
            if let Some(v) = self.vessels.get_mut(&mmsi) {
                v.type_code = Some(code);
                v.class = classify(Some(code)).into();
                v.destination = dest;
            }
            return true;
        }
        if !kind.ends_with("PositionReport") {
            return false;
        }
        let lat = num(meta, &["Latitude", "latitude"]).or_else(|| num(body, &["Latitude"]));
        let lon = num(meta, &["Longitude", "longitude"]).or_else(|| num(body, &["Longitude"]));
        let (Some(lat), Some(lon)) = (lat, lon) else { return false };
        if !bbox.contains(lat, lon) {
            return false;
        }
        // AIS uses 102.3 knots and 360 degrees as "not available".
        let sog = num(body, &["Sog"]).filter(|s| *s < 102.2);
        let cog = num(body, &["Cog"]).filter(|c| *c < 360.0);
        let (type_code, destination) = self.types.get(&mmsi).cloned().map(|(c, d)| (Some(c), d)).unwrap_or((None, String::new()));
        let mut name = text(meta, &["ShipName"]);
        if name.is_empty() {
            name = format!("MMSI {mmsi}");
        }
        self.vessels.insert(
            mmsi,
            Vessel {
                mmsi,
                name,
                lat,
                lon,
                sog,
                cog,
                status: nav_status(field(body, &["NavigationalStatus"]).and_then(Value::as_i64)).into(),
                class: classify(type_code).into(),
                type_code,
                destination,
                seen: now,
            },
        );
        self.prune(now);
        true
    }
    /// Drops stale vessels, then the oldest ones beyond the size limit.
    pub fn prune(&mut self, now: i64) {
        self.vessels.retain(|_, v| now - v.seen <= MAX_AGE_SECS);
        if self.vessels.len() > MAX_VESSELS {
            let mut by_age: Vec<(i64, u64)> = self.vessels.values().map(|v| (v.seen, v.mmsi)).collect();
            by_age.sort();
            for (_, m) in by_age.iter().take(self.vessels.len() - MAX_VESSELS) {
                self.vessels.remove(m);
            }
        }
        if self.types.len() > MAX_VESSELS * 2 {
            let live: std::collections::HashSet<u64> = self.vessels.keys().copied().collect();
            self.types.retain(|m, _| live.contains(m));
        }
    }
}

/// Reconnect delay: 1, 2, 4 … 60 seconds, plus up to 1 second of jitter.
pub fn backoff(attempt: u32, jitter_ms: u64) -> std::time::Duration {
    let base = 1u64 << attempt.min(6);
    std::time::Duration::from_millis(base.min(60) * 1000 + jitter_ms % 1000)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn bbox() -> BBox {
        BBox::around(26.5, 56.3, 1.0).unwrap()
    }
    fn position(mmsi: u64, lat: f64, lon: f64) -> Value {
        json!({"MessageType":"PositionReport","MetaData":{"MMSI":mmsi,"ShipName":"  FIXTURE ONE ","Latitude":lat,"Longitude":lon},
               "Message":{"PositionReport":{"Sog":12.5,"Cog":360.0,"NavigationalStatus":1}}})
    }
    #[test]
    fn subscription_uses_lat_lon_corners() {
        let s: Value = serde_json::from_str(&subscription("KEY", &bbox())).unwrap();
        assert_eq!(s["APIKey"], "KEY");
        assert_eq!(s["BoundingBoxes"][0][0][0], 25.5);
        assert_eq!(s["BoundingBoxes"][0][1][1], 57.3);
        assert!(BBox::around(95.0, 0.0, 1.0).is_err());
        assert!(BBox::around(0.0, 0.0, 50.0).is_err());
    }
    #[test]
    fn classifies_hull_types_only() {
        assert_eq!(classify(Some(84)), "tanker");
        assert_eq!(classify(Some(71)), "cargo");
        assert_eq!(classify(None), "unknown");
        assert_eq!(classify(Some(37)), "service");
    }
    #[test]
    fn merges_static_type_into_positions_and_handles_unavailable_values() {
        let mut s = Store::default();
        assert!(s.apply(&position(123456789, 26.4, 56.2), &bbox(), 100));
        let v = &s.vessels[&123456789];
        assert_eq!((v.name.as_str(), v.class.as_str(), v.cog, v.status.as_str()), ("FIXTURE ONE", "unknown", None, "At anchor"));
        let stat = json!({"MessageType":"ShipStaticData","MetaData":{"MMSI":123456789},"Message":{"ShipStaticData":{"Type":80,"Destination":"FUJAIRAH"}}});
        assert!(s.apply(&stat, &bbox(), 101));
        assert_eq!(s.vessels[&123456789].class, "tanker");
        assert!(s.apply(&json!({"MessageType":"PositionReport","MetaData":{"MMSI":123456789,"latitude":26.0,"longitude":56.0},"Message":{"PositionReport":{"Sog":102.3}}}), &bbox(), 102));
        let v = &s.vessels[&123456789];
        assert_eq!((v.class.as_str(), v.destination.as_str(), v.sog), ("tanker", "FUJAIRAH", None));
    }
    #[test]
    fn rejects_bad_ids_and_out_of_area_positions() {
        let mut s = Store::default();
        assert!(!s.apply(&position(12, 26.4, 56.2), &bbox(), 1));
        assert!(!s.apply(&position(123456789, 10.0, 10.0), &bbox(), 1));
        assert!(!s.apply(&json!({"MessageType":"SafetyBroadcastMessage","MetaData":{"MMSI":123456789}}), &bbox(), 1));
        assert!(s.vessels.is_empty());
    }
    #[test]
    fn retention_is_bounded_by_age_and_count() {
        let mut s = Store::default();
        for i in 0..(MAX_VESSELS as u64 + 50) {
            s.apply(&position(200_000_000 + i, 26.0, 56.0), &bbox(), 1_000 + i as i64);
        }
        assert_eq!(s.vessels.len(), MAX_VESSELS);
        assert!(!s.vessels.contains_key(&200_000_000), "oldest dropped first");
        s.prune(1_000 + MAX_VESSELS as i64 + 50 + MAX_AGE_SECS + 1);
        assert!(s.vessels.is_empty());
    }
    #[test]
    fn backoff_grows_and_caps() {
        assert_eq!(backoff(0, 0).as_secs(), 1);
        assert_eq!(backoff(3, 0).as_secs(), 8);
        assert_eq!(backoff(20, 999).as_millis(), 60_999);
    }
}
