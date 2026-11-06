// Live vessel map: Leaflet over Esri dark gray tiles, fed by the AISStream snapshot.
// The map element is created once and moved into each fresh render, so the
// page re-rendering doesn't reload tiles or reset the view.
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import locations from "./maritime-locations.json" with { type: "json" };
export { locations };

// Esri's dark gray canvas: no key needed (CARTO's basemaps now require one).
const ESRI = "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas";
const TILES = `${ESRI}/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}`;
const LABELS = `${ESRI}/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}`;
const ATTRIBUTION =
  'Tiles &copy; <a href="https://www.esri.com/">Esri</a> &mdash; Esri, HERE, Garmin, &copy; OpenStreetMap contributors';
const ZOOM = 8; // about the 2°×2° area AISStream is subscribed to

let map = null,
  el = null,
  sites = null,
  ships = null,
  area = null,
  current = null;
const markers = new Map(); // mmsi -> { marker, key }

const esc = (x) =>
  String(x ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );

// Ships with a known course point along it; the rest are plain dots.
function icon(v) {
  const moving = v.cog != null && (v.sog ?? 0) >= 0.5;
  return L.divIcon({
    className: "",
    iconSize: [14, 14],
    iconAnchor: [7, 7],
    html: moving
      ? `<div class="ship ${esc(v.class)}" style="transform:rotate(${Math.round(v.cog)}deg)"></div>`
      : `<div class="ship dot ${esc(v.class)}"></div>`,
  });
}

function shipLabel(v) {
  const speed = v.sog == null ? "speed n/a" : `${v.sog.toFixed(1)} kn`;
  return `<b>${esc(v.name)}</b><br>${esc(v.class)} · ${speed}<br>${esc(v.status)}${v.destination ? "<br>→ " + esc(v.destination) : ""}`;
}

/** Puts the map into `slot` (creating it on first use; no slot means it is
 * already on the page) and centres it on `loc`. */
export function mountVesselMap(slot, loc, onPick) {
  if (!slot && !map) return;
  if (!map) {
    el = document.createElement("div");
    el.className = "vessel-leaflet";
    slot.replaceWith(el);
    map = L.map(el, {
      worldCopyJump: true,
      zoomControl: true,
      attributionControl: true,
      preferCanvas: false,
    });
    L.tileLayer(TILES, {
      attribution: ATTRIBUTION,
      maxNativeZoom: 16,
      maxZoom: 18,
    }).addTo(map);
    L.tileLayer(LABELS, { maxNativeZoom: 16, maxZoom: 18 }).addTo(map);
    // Re-measure whenever the panel changes size (window resize, layout shifts).
    new ResizeObserver(() => map.invalidateSize()).observe(el);
    sites = L.layerGroup().addTo(map);
    ships = L.layerGroup().addTo(map);
    map.setView([loc.lat, loc.lon], ZOOM);
    current = loc.id;
  } else if (slot) slot.replaceWith(el);
  map.invalidateSize();
  sites.clearLayers();
  for (const x of locations) {
    if (x.id === loc.id) continue;
    L.circleMarker([x.lat, x.lon], {
      radius: 5,
      color: "#6b6b6b",
      weight: 1,
      fillColor: "#3d3d3d",
      fillOpacity: 0.9,
    })
      .bindTooltip(`${esc(x.name)} · click to watch`)
      .on("click", () => onPick(x.id))
      .addTo(sites);
  }
  if (area) area.remove();
  area = L.rectangle(
    [
      [loc.lat - 1, loc.lon - 1],
      [loc.lat + 1, loc.lon + 1],
    ],
    { color: "#5a5a5a", weight: 1, dashArray: "4 4", fill: false, interactive: false },
  ).addTo(map);
  if (current !== loc.id) {
    current = loc.id;
    clearVessels();
    map.flyTo([loc.lat, loc.lon], ZOOM, { duration: 0.8 });
  }
}

export function clearVessels() {
  ships?.clearLayers();
  markers.clear();
}

/** Moves existing markers, adds new ones and drops vessels no longer shown. */
export function updateVessels(vessels) {
  if (!ships) return;
  const seen = new Set();
  for (const v of vessels) {
    seen.add(v.mmsi);
    const key = `${v.class}|${v.cog == null ? "" : Math.round(v.cog)}|${(v.sog ?? 0) >= 0.5}`;
    const hit = markers.get(v.mmsi);
    if (hit) {
      hit.marker.setLatLng([v.lat, v.lon]);
      if (hit.key !== key) hit.marker.setIcon(icon(v));
      hit.marker.setTooltipContent(shipLabel(v));
      hit.key = key;
    } else {
      const marker = L.marker([v.lat, v.lon], { icon: icon(v), keyboard: false })
        .bindTooltip(shipLabel(v), { direction: "top", offset: [0, -6] })
        .addTo(ships);
      markers.set(v.mmsi, { marker, key });
    }
  }
  for (const [mmsi, { marker }] of markers)
    if (!seen.has(mmsi)) {
      marker.remove();
      markers.delete(mmsi);
    }
}

/** Pans to one vessel, e.g. when its table row is clicked. */
export function focusVessel(mmsi) {
  const hit = markers.get(mmsi);
  if (!hit || !map) return;
  map.panTo(hit.marker.getLatLng());
  hit.marker.openTooltip();
}
