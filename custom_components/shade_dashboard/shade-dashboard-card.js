/*
 * shade-dashboard-card
 *
 * A spatial PowerView shade dashboard (design "1a — Wall Panel"). Renders the
 * house's window elevations with CSS (gradients + clip-path), reflects live
 * `cover.*` positions from Home Assistant, and drives them via core cover
 * services. Works both as a custom panel (the "Shades" sidebar dashboard) and
 * as a `shade-dashboard-card` on any Lovelace view.
 *
 * The window -> entity map arrives from the integration (const.py, via the
 * panel config). DEFAULT_LAYOUT below mirrors it so the card also works
 * standalone; tests/test_layout_sync.py guards the two against drift.
 *
 * Rendering strategy: build the static DOM once, then patch only the dynamic
 * bits (fabric heights, labels, rings, offline state, control bar, sun, summary)
 * on each hass update — so the 0.45s fabric animation and horizontal scroll
 * position are preserved.
 */

const GLASS_LOWER = "linear-gradient(180deg,#D8DFE2 0%,#E9E6DB 55%,#A8B29B 100%)";
const GLASS_UPPER = "linear-gradient(180deg,#CBD6DC 0%,#E2E2D6 100%)";
const FABRIC = "linear-gradient(180deg,#DED7CB,#D1C9BB)";
const HATCH = "repeating-linear-gradient(45deg,#EFEBE3 0 7px,#E2DBCE 7px 14px)";
const RING = "0 0 0 2px #F5F1EA, 0 0 0 5px #C67B3B";
const ACCENT = "#C67B3B";
const HEM = "#AA9C81"; // shade fabric bottom bar (kept distinct so it reads on every window)
const SCENE_ACTIVE_BG = "color-mix(in oklab, #C67B3B 18%, #FFFDF9)";

// Mirror of const.py (build_panel_config). Kept in sync by test_layout_sync.py.
const DEFAULT_LAYOUT = {
  shades: {
    u1: { entity: "cover.shade_u1" },
    u2: { entity: "cover.shade_u2" },
    u3: { entity: "cover.shade_u3" },
    l1: { entity: "cover.shade_l1" },
    l2: { entity: "cover.shade_l2" },
    u4: { entity: "cover.shade_u4" },
    u5: { entity: "cover.shade_u5" },
    u6: { entity: "cover.shade_u6" },
    u7: { entity: "cover.shade_u7" },
    l3: { entity: "cover.shade_l3" },
    l4: { entity: "cover.shade_l4" },
    l5: { entity: "cover.shade_l5" },
    l6: { entity: "cover.shade_l6" },
    l7: { entity: "cover.shade_l7" },
    l8: { entity: "cover.shade_l8" },
    lrh1: { entity: "cover.shade_lrh1" },
    uh1: { entity: "cover.shade_uh1" },
    uh2: { entity: "cover.shade_uh2" },
    uh3: { entity: "cover.shade_uh3" },
    ko1: { entity: "cover.shade_ko1" },
    ko2: { entity: "cover.shade_ko2" },
    mbr1: { entity: "cover.shade_mbr1" },
  },
  groups: {
    south: ["cover.shade_u1", "cover.shade_u2", "cover.shade_u3", "cover.shade_l1", "cover.shade_l2"],
    west: ["cover.shade_u4", "cover.shade_u5", "cover.shade_u6", "cover.shade_u7", "cover.shade_l3", "cover.shade_l4", "cover.shade_l5", "cover.shade_l6"],
    north: ["cover.shade_l7", "cover.shade_l8"],
    hallway: ["cover.shade_lrh1"],
    upstairs_hallway: ["cover.shade_uh1", "cover.shade_uh2", "cover.shade_uh3"],
    office: ["cover.shade_ko1", "cover.shade_ko2"],
    main_bedroom: ["cover.shade_mbr1"],
  },
  scenes: {
    open_all: { title: "Open All", desc: "Every shade up", kind: "group", group: "all", dir: "up" },
    close_all: { title: "Close All", desc: "Every shade down", kind: "group", group: "all", dir: "down" },
  },
  sun: {
    elevation_entity: "sensor.home2_sun_elevation",
    azimuth_entity: "sensor.home2_sun_azimuth",
    // sun2 (terrain/elevation-corrected) sunrise & sunset timestamps.
    rising_entity: "sensor.home2_sun_rising",
    setting_entity: "sensor.home2_sun_setting",
    west_lux: "sensor.west_light_level",
    south_lux: "sensor.south_light_level",
  },
  // Physics for the sun simulation (mirror of const.py SUN_GEO). Wall azimuths
  // are the walls' true-north outward normals; viewer params are the eye point
  // the projection renders from (feet). Strict JSON — test_layout_sync parses it.
  sun_geo: {
    "lat": 39.582804,
    "lon": -105.249572,
    "walls": {
      "west": {"az": 295.0, "viewer_x": 8.34, "viewer_d": 18.0, "eye_h": 5.4},
      "south": {"az": 201.0, "viewer_x": 9.5, "viewer_d": 14.0, "eye_h": 5.4},
      "up_west": {"az": 295.0, "viewer_x": 8.0, "viewer_d": 7.0, "eye_h": 5.4}
    }
  },
  toggles: {
    movie: { title: "Movie Mode", desc_on: "On · everything closed", desc_off: "Off", entity: "input_boolean.movie_mode" },
    automation: { title: "Auto shades", desc_on: "On · sun & sunset control", desc_off: "Off · manual only", entity: "input_boolean.shade_automation", enable_script: "script.enable_shade_automation", disable_script: "script.disable_shade_automation" },
  },
};
DEFAULT_LAYOUT.groups.main_floor = [...DEFAULT_LAYOUT.groups.south, ...DEFAULT_LAYOUT.groups.west, ...DEFAULT_LAYOUT.groups.north, ...DEFAULT_LAYOUT.groups.hallway];
DEFAULT_LAYOUT.groups.upstairs = [...DEFAULT_LAYOUT.groups.main_bedroom, ...DEFAULT_LAYOUT.groups.upstairs_hallway, ...DEFAULT_LAYOUT.groups.office];
DEFAULT_LAYOUT.groups.all = [...DEFAULT_LAYOUT.groups.main_floor, ...DEFAULT_LAYOUT.groups.upstairs];
// Bulk group moves go through shade_dashboard.move_group (one synced gateway call
// per group, no PowerView scenes).
// Entities on the G3 gateway (live-tracked). Everything except the main bedroom.
DEFAULT_LAYOUT.tracked = Object.entries(DEFAULT_LAYOUT.shades).filter(([s]) => s !== "mbr1").map(([, v]) => v.entity);
// Slots that support recalibration (PowerView shades; the RYSE main-bedroom shade does not).
DEFAULT_LAYOUT.recal_slots = Object.keys(DEFAULT_LAYOUT.shades).filter((s) => s !== "mbr1");

// Presentation metadata (label number + control-bar subtitle). Card-side only.
const SLOT_META = {
  u1: { num: "U1", sub: "Living room · south wall" }, u2: { num: "U2", sub: "Living room · south wall" }, u3: { num: "U3", sub: "Living room · south wall" },
  l1: { num: "1", sub: "Living room · south wall" }, l2: { num: "2", sub: "Living room · south wall" },
  u4: { num: "U4", sub: "Living room · west wall" }, u5: { num: "U5", sub: "Living room · west wall" }, u6: { num: "U6", sub: "Living room · west wall" }, u7: { num: "U7", sub: "Living room · west wall" },
  l3: { num: "3", sub: "Living room · west wall" }, l4: { num: "4", sub: "Living room · west wall" }, l5: { num: "5", sub: "Living room · west wall" }, l6: { num: "6", sub: "Living room · west wall" },
  l7: { num: "7", sub: "Living room · north wall" }, l8: { num: "8", sub: "Living room · north wall" },
  lrh1: { num: "", sub: "Living room · hallway" },
  uh1: { num: "1", sub: "Upstairs · hallway" }, uh2: { num: "2", sub: "Upstairs · hallway" }, uh3: { num: "3", sub: "Upstairs · hallway" },
  ko1: { num: "1", sub: "Kyle's office" }, ko2: { num: "2", sub: "Kyle's office" },
  mbr1: { num: "", sub: "Main bedroom · sliding doors" },
};

function fireEvent(node, type, detail) {
  node.dispatchEvent(new CustomEvent(type, { detail: detail || {}, bubbles: true, composed: true }));
}

// --- static DOM builders (styles mirror the design prototype) ----------------
const fabric = (slot, hem) =>
  `<div data-fabric="${slot}" style="position:absolute;top:0;left:0;right:0;height:0;background:${FABRIC};border-bottom:${hem}px solid ${HEM};transition:height .45s ease"></div>`;
const offline = (slot) =>
  `<div data-offline="${slot}" style="display:none;position:absolute;inset:0;align-items:center;justify-content:center;background:${HATCH}"><span style="writing-mode:vertical-rl;font:700 10px ui-monospace,Menlo,monospace;letter-spacing:2px;color:#A2988A">OFFLINE</span></div>`;
const flash = (slot, clip) =>
  `<div data-flash="${slot}" class="sd-flash-ov" style="${clip ? `clip-path:url(#sd-clip-${slot})` : "border-radius:3px"}"></div>`;
const winRect = (slot, glass) =>
  `<div data-slot="${slot}" title="${slot}" style="position:relative;width:84px;height:190px;border:3px solid #1F1B17;border-radius:3px;background:${glass};overflow:hidden;cursor:pointer">${fabric(slot, 4)}${flash(slot)}${offline(slot)}</div>`;
const label = (slot) =>
  `<span data-label="${slot}" style="font:700 13px ui-monospace,Menlo,monospace;color:#6E6558;letter-spacing:.3px"></span>`;
const lowerCol = (slot, glass = GLASS_LOWER) =>
  `<div style="display:flex;flex-direction:column;align-items:center;gap:6px">${winRect(slot, glass)}${label(slot)}</div>`;
// Sliding-door shade: a wide (~2.5-window) glass door whose fabric travels
// HORIZONTALLY — anchored at the left (open), growing rightward to cover (closed).
// width = (100 - position)% (the leading hem is on the right). `data-axis="x"`
// tells _setFabric to animate width instead of height.
const winDoor = (slot) =>
  `<div data-slot="${slot}" title="${slot}" style="position:relative;width:210px;height:190px;border:3px solid #1F1B17;border-radius:3px;background:${GLASS_LOWER};overflow:hidden;cursor:pointer">` +
    `<div style="position:absolute;top:0;bottom:0;left:33.33%;width:2px;background:rgba(31,27,23,.22)"></div>` +
    `<div style="position:absolute;top:0;bottom:0;left:66.66%;width:2px;background:rgba(31,27,23,.22)"></div>` +
    `<div data-fabric="${slot}" data-axis="x" style="position:absolute;top:0;left:0;bottom:0;width:0;background:${FABRIC};border-right:4px solid ${HEM};transition:width .45s ease"></div>` +
    flash(slot) +
    offline(slot) +
  `</div>`;
const doorCol = (slot) =>
  `<div style="display:flex;flex-direction:column;align-items:center;gap:6px">${winDoor(slot)}${label(slot)}</div>`;
// Compact mobile tiles — same data hooks (data-slot/fabric/flash/offline/label)
// so _update/_setFabric/flash/selection all work unchanged.
const mobileWin = (slot, glass) =>
  `<div style="display:flex;flex-direction:column;align-items:center;gap:3px">` +
    `<div data-slot="${slot}" title="${slot}" style="position:relative;width:46px;height:64px;border:2px solid #1F1B17;border-radius:3px;background:${glass};overflow:hidden;cursor:pointer">${fabric(slot, 3)}${flash(slot)}${offline(slot)}</div>` +
    `<span data-label="${slot}" style="font:700 10px ui-monospace,Menlo,monospace;color:#6E6558"></span>` +
  `</div>`;
const mobileDoorTile = (slot) =>
  `<div style="display:flex;flex-direction:column;align-items:center;gap:3px">` +
    `<div data-slot="${slot}" title="${slot}" style="position:relative;width:132px;height:58px;border:2px solid #1F1B17;border-radius:3px;background:${GLASS_LOWER};overflow:hidden;cursor:pointer">` +
      `<div data-fabric="${slot}" data-axis="x" style="position:absolute;top:0;left:0;bottom:0;width:0;background:${FABRIC};border-right:3px solid ${HEM};transition:width .45s ease"></div>${flash(slot)}${offline(slot)}` +
    `</div>` +
    `<span data-label="${slot}" style="font:700 10px ui-monospace,Menlo,monospace;color:#6E6558"></span>` +
  `</div>`;
// In-motion flash CSS shared by both layouts.
const FLASH_CSS = `
  @keyframes sd-pulse { 0%,100% { outline-color: rgba(198,123,59,.95); } 50% { outline-color: rgba(198,123,59,.15); } }
  .sd-moving { outline: 3px solid rgba(198,123,59,.95); outline-offset: 1px; border-radius: 3px; animation: sd-pulse .95s ease-in-out infinite; }
  .sd-flash-ov { position:absolute; inset:0; background:${ACCENT}; opacity:0; pointer-events:none; }
  @keyframes sd-flash-anim { 0%,100% { opacity:0; } 50% { opacity:.34; } }
  .sd-flash-on { animation: sd-flash-anim .95s ease-in-out infinite; }
  @keyframes sd-ring-pulse { 0%,100% { stroke-opacity:.95; } 50% { stroke-opacity:.12; } }
  .sd-flash-ring-on { animation: sd-ring-pulse .95s ease-in-out infinite; }
  @keyframes sd-blink { 0%,100% { opacity: 1; } 50% { opacity: .5; } }
  .sd-moving-label { color:${ACCENT} !important; animation: sd-blink .95s ease-in-out infinite; }`;
// --- Solar position + wall projection (Sun tab & live sun dot) --------------
// NOAA solar position algorithm (~0.1 deg). Validated against the sun2
// integration's sensors for this house (tests/js/solar.test.mjs pins reference
// values computed independently). Exported so the Node test can import it.
export function solarPos(dateMs, lat, lon) {
  const rad = Math.PI / 180;
  const d = new Date(dateMs);
  let y = d.getUTCFullYear(), m = d.getUTCMonth() + 1;
  const day = d.getUTCDate() + (d.getUTCHours() + d.getUTCMinutes() / 60 + d.getUTCSeconds() / 3600) / 24;
  if (m <= 2) { y -= 1; m += 12; }
  const A = Math.floor(y / 100), B = 2 - A + Math.floor(A / 4);
  const jd = Math.floor(365.25 * (y + 4716)) + Math.floor(30.6001 * (m + 1)) + day + B - 1524.5;
  const T = (jd - 2451545.0) / 36525.0;
  const L0 = (280.46646 + T * (36000.76983 + 0.0003032 * T)) % 360;
  const M = 357.52911 + T * (35999.05029 - 0.0001537 * T);
  const e = 0.016708634 - T * (0.000042037 + 0.0000001267 * T);
  const Mr = M * rad;
  const C = (1.914602 - T * (0.004817 + 0.000014 * T)) * Math.sin(Mr)
    + (0.019993 - 0.000101 * T) * Math.sin(2 * Mr) + 0.000289 * Math.sin(3 * Mr);
  const omega = 125.04 - 1934.136 * T;
  const lam = (L0 + C - 0.00569 - 0.00478 * Math.sin(omega * rad)) * rad;
  const eps0 = 23 + (26 + (21.448 - T * (46.815 + T * (0.00059 - T * 0.001813))) / 60) / 60;
  const eps = (eps0 + 0.00256 * Math.cos(omega * rad)) * rad;
  const decl = Math.asin(Math.sin(eps) * Math.sin(lam));
  const yv = Math.tan(eps / 2) ** 2;
  const L0r = L0 * rad;
  const eot = 4 / rad * (yv * Math.sin(2 * L0r) - 2 * e * Math.sin(Mr) + 4 * e * yv * Math.sin(Mr) * Math.cos(2 * L0r)
    - 0.5 * yv * yv * Math.sin(4 * L0r) - 1.25 * e * e * Math.sin(2 * Mr));
  const mins = d.getUTCHours() * 60 + d.getUTCMinutes() + d.getUTCSeconds() / 60;
  const tst = (((mins + eot + 4 * lon) % 1440) + 1440) % 1440;
  const ha = (tst / 4 < 0 ? tst / 4 + 180 : tst / 4 - 180) * rad;
  const latr = lat * rad;
  const zen = Math.acos(Math.sin(latr) * Math.sin(decl) + Math.cos(latr) * Math.cos(decl) * Math.cos(ha));
  let el = 90 - zen / rad;
  if (el > -0.575 && el < 85) el += (1.02 / Math.tan((el + 10.3 / (el + 5.11)) * rad)) / 60; // refraction
  let az = Math.acos(((Math.sin(latr) * Math.cos(zen)) - Math.sin(decl)) / (Math.cos(latr) * Math.sin(zen))) / rad;
  az = ha > 0 ? (180 + az) % 360 : (540 - az) % 360;
  return { az, el };
}

// Project the sun onto a wall plane from the configured viewer eye point.
// Returns wall coordinates in feet (x across the run, z above the floor) and
// `behind` when the sun is on the other side of the wall plane.
export function sunOnWall(wall, az, el) {
  const rad = Math.PI / 180;
  let d = az - wall.az;
  d = ((d + 540) % 360) - 180; // normalize to [-180, 180)
  if (Math.abs(d) >= 88 || el <= -1.5) return { behind: true, rel: d };
  const x = wall.viewer_x + wall.viewer_d * Math.tan(d * rad);
  const z = wall.eye_h + (wall.viewer_d * Math.tan(el * rad)) / Math.cos(d * rad);
  return { x, z, rel: d, behind: false };
}

// Wall elevations for the Sun tab, in real feet (x: 0 -> run right, z: floor up).
// West-wall dimensions taken off the calibration photo: 4 bays on a 4.75 ft
// pitch, lower glass to 8 ft, angled clerestories following the roofline
// (drops 1.94 ft per bay). South wall mirrors the drawn layout (door bay,
// chimney bay). Upstairs is schematic: the five west-facing windows.
const SIM_BAYS = [[0.3, 4.45], [5.05, 9.2], [9.8, 13.95], [14.55, 18.7]];
const SIM_ROOF = (x) => 18.4 - 0.408 * x; // west roofline: z at wall-x
const WALL_ELEV = {
  west: {
    label: "West wall", az: 295, run: 19, sky: 26, ridge: true,
    windows: [
      ...SIM_BAYS.map(([a, b], i) => ({ slot: ["u4", "u5", "u6", "u7"][i], pts: [[a, 9], [a, SIM_ROOF(a)], [b, SIM_ROOF(b)], [b, 9]] })),
      ...SIM_BAYS.map(([a, b], i) => ({ slot: ["l3", "l4", "l5", "l6"][i], rect: [a, 0.3, b - a, 7.7] })),
    ],
  },
  south: {
    label: "South wall", az: 201, run: 19, sky: 26,
    windows: [
      { slot: "u1", rect: [SIM_BAYS[0][0], 9, 4.15, 9.4] },
      { slot: "u2", rect: [SIM_BAYS[1][0], 9, 4.15, 9.4] },
      { slot: "u3", rect: [SIM_BAYS[3][0], 9, 4.15, 9.4] },
      { slot: "l1", rect: [SIM_BAYS[1][0], 0.3, 4.15, 7.7] },
      { slot: "l2", rect: [SIM_BAYS[3][0], 0.3, 4.15, 7.7] },
      { deco: "door", rect: [SIM_BAYS[0][0], 0, 4.15, 6.8] },
      { deco: "chimney", rect: [SIM_BAYS[2][0], 0, 4.15, 18.5] },
    ],
  },
  up_west: {
    label: "Upstairs · west-facing", az: 295, run: 16.6, sky: 14, ridge: true,
    windows: [
      { slot: "uh1", rect: [0.25, 2, 2.7, 5] }, { slot: "uh2", rect: [3.45, 2, 2.7, 5] }, { slot: "uh3", rect: [6.65, 2, 2.7, 5] },
      { slot: "ko1", rect: [10.45, 2, 2.7, 5] }, { slot: "ko2", rect: [13.65, 2, 2.7, 5] },
    ],
  },
};
// Fallback WNW ridge height (deg); normally derived live from the sun2 sunset time.
const RIDGE_EL_FALLBACK = 2.2;

// SVG path for a rounded polygon (corner radius r) through the given [x,y] points.
const roundedPath = (pts, r) => {
  const n = pts.length;
  let d = "";
  const q = (v) => Math.round(v * 100) / 100;
  for (let i = 0; i < n; i++) {
    const [ax, ay] = pts[(i - 1 + n) % n];
    const [bx, by] = pts[i];
    const [cx, cy] = pts[(i + 1) % n];
    const b1 = Math.hypot(ax - bx, ay - by) || 1;
    const b2 = Math.hypot(cx - bx, cy - by) || 1;
    const rr = Math.min(r, b1 / 2, b2 / 2);
    const p1x = bx + ((ax - bx) / b1) * rr, p1y = by + ((ay - by) / b1) * rr;
    const p2x = bx + ((cx - bx) / b2) * rr, p2y = by + ((cy - by) / b2) * rr;
    d += `${i === 0 ? "M" : "L"}${q(p1x)},${q(p1y)}Q${q(bx)},${q(by)} ${q(p2x)},${q(p2y)}`;
  }
  return d + "Z";
};

// Angled clerestory window: the SAME window as a rectangle (rounded 3px frame,
// glass, animated fabric) but with the top sliced at the shared angle (40px drop
// over the 84px width). CSS clip-path can't keep rounded corners, so the frame +
// glass are drawn as a rounded SVG trapezoid (outer = #1F1B17, inset 3px = glass),
// and the fabric stays a plain div clipped to the glass shape — so _setFabric and
// the 0.45s animation are unchanged. Top glass corners drop to y=4.75/41.9 so the
// sliced top border reads a true, uniform 3px like the sides and bottom.
const winAngled = (slot, h) => {
  // Outer frame corners are rounded (3px, like the rectangle windows); the inner
  // glass corners stay sharp (r=0) — a 3px border on a 3px radius leaves a square
  // glass edge, matching the rectangles.
  const outer = roundedPath([[0, 0], [84, 40], [84, h], [0, h]], 3);
  const inner = roundedPath([[3, 4.75], [81, 41.9], [81, h - 3], [3, h - 3]], 0);
  // Selection ring that follows the trapezoid: an accent outset (5px) with a
  // 2px canvas-colored gap outset, drawn UNDER the frame (like the rectangle's
  // 2px-gap + accent box-shadow). Offsets: left/right/bottom by d; the sliced
  // top edge offsets to y=-1.584d (left) / 40-0.631d (right).
  // Matches the rectangle windows' box-shadow ring exactly: a 2px canvas gap then
  // 3px accent, outside the frame. A box-shadow of spread s rounds corners to
  // (border-radius 3 + s), so the accent (out to 5px) rounds at 8 and the gap
  // (out to 2px) at 5.
  const ring = (d, r) => roundedPath([[-d, -1.584 * d], [84 + d, 40 - 0.631 * d], [84 + d, h + d], [-d, h + d]], r);
  return (
    `<div data-slot="${slot}" title="${slot}" style="position:relative;width:84px;height:${h}px;cursor:pointer">` +
      `<svg width="84" height="${h}" viewBox="0 0 84 ${h}" style="position:absolute;inset:0;display:block;overflow:visible">` +
        `<defs>` +
          `<linearGradient id="sd-g-${slot}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#CBD6DC"/><stop offset="1" stop-color="#E2E2D6"/></linearGradient>` +
          `<clipPath id="sd-clip-${slot}" clipPathUnits="userSpaceOnUse"><path d="${inner}"/></clipPath>` +
        `</defs>` +
        `<path data-ring="${slot}" d="${ring(5, 8)}" fill="${ACCENT}" style="display:none"/>` +
        `<path data-ring="${slot}" d="${ring(2, 5)}" fill="#F5F1EA" style="display:none"/>` +
        `<path d="${outer}" fill="#1F1B17"/>` +
        `<path d="${inner}" fill="url(#sd-g-${slot})"/>` +
        // in-motion flash ring, following the trapezoid (pulses via .sd-flash-ring-on)
        `<path data-flash-ring="${slot}" d="${ring(2.5, 6)}" fill="none" stroke="${ACCENT}" stroke-width="3" stroke-linejoin="round" stroke-opacity="0"/>` +
      `</svg>` +
      // Fabric lives in a clipped container inset 3px at the bottom, so at fully
      // closed its hem sits right on top of the bottom frame (like the rectangle
      // windows) instead of being clipped away.
      `<div style="position:absolute;top:0;left:0;right:0;bottom:3px;clip-path:url(#sd-clip-${slot})">` +
        `<div data-fabric="${slot}" style="position:absolute;top:0;left:0;right:0;height:0;background:${FABRIC};border-bottom:4px solid ${HEM};transition:height .45s ease"></div>` +
      `</div>` +
      flash(slot, true) +
    `</div>`
  );
};
const angledCol = (slot, h) =>
  `<div style="display:flex;flex-direction:column;align-items:center;gap:6px">${winAngled(slot, h)}${label(slot)}</div>`;
// Live sun dot overlaid on a wall drawing (positioned by _updateSunOverlays).
const sunDot = (key) =>
  `<div data-sunov="${key}" style="display:none;position:absolute;left:-100px;top:-100px;width:20px;height:20px;margin:-10px 0 0 -10px;border-radius:50%;pointer-events:auto;background:radial-gradient(circle,#FFE0AC 0%,#F0A94F 48%,rgba(240,169,79,0) 74%);box-shadow:0 0 16px 5px rgba(232,163,79,.5);z-index:3"></div>`;
const chip = (group, text) =>
  `<div style="display:flex;align-items:center;gap:6px"><span style="font-size:10px;letter-spacing:1.2px;color:#8A8177;font-weight:600">${text}</span>` +
    `<button data-group="${group}" data-dir="up" title="Open" style="width:30px;height:26px;border:1px solid #DFD7C9;background:#FFFDF9;border-radius:7px;cursor:pointer;font-size:10px;color:#4A4237;padding:0">▲</button>` +
    `<button data-group="${group}" data-dir="down" title="Close" style="width:30px;height:26px;border:1px solid #DFD7C9;background:#FFFDF9;border-radius:7px;cursor:pointer;font-size:10px;color:#4A4237;padding:0">▼</button></div>`;
const divider = () => `<div style="width:1px;align-self:stretch;background:#E0D8C9"></div>`;
const sceneBtn = (key, s) =>
  `<button data-scene="${key}" style="text-align:left;padding:12px 14px;border:1px solid #E2DACB;border-radius:12px;background:#FFFDF9;cursor:pointer;display:flex;flex-direction:column;gap:3px">` +
    `<span style="font-weight:600;font-size:14px;color:#26211B">${s.title}</span><span style="font-size:11px;color:#8A8177">${s.desc}</span></button>`;
const toggleRow = (key, t) =>
  `<button data-toggle="${key}" style="display:flex;align-items:center;justify-content:space-between;gap:10px;padding:12px 14px;border:1px solid #E2DACB;border-radius:12px;background:#FFFDF9;cursor:pointer">` +
    `<span style="display:flex;flex-direction:column;gap:3px;text-align:left"><span style="font-weight:600;font-size:14px;color:#26211B">${t.title}</span><span data-toggle-desc="${key}" style="font-size:11px;color:#8A8177"></span></span>` +
    `<span data-toggle-switch="${key}" style="flex-shrink:0;width:40px;height:23px;border-radius:999px;background:#D9D2C4;position:relative;transition:background .2s"><span data-toggle-knob="${key}" style="position:absolute;top:2px;left:2px;width:19px;height:19px;border-radius:50%;background:#FFF;box-shadow:0 1px 3px rgba(0,0,0,.25);transition:left .2s"></span></span>` +
  `</button>`;

// In Node (tests/js/solar.test.mjs imports this module for the solar math)
// there is no DOM — stub the base class; HA always provides the real one.
const BaseElement = typeof HTMLElement !== "undefined" ? HTMLElement : class {};

class ShadeDashboardCard extends BaseElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._built = false;
    this._selected = null;
    this._dragging = false;
    this._lastScene = null;
    this._tab = "main";
    this._layout = DEFAULT_LAYOUT;
    // The unified cover.shade_* entities (see the integration's cover.py) now own
    // all live-position tracking server-side: their current_position is already
    // the display-ready live value (gateway feed for PowerView, source for RYSE)
    // and their opening/closing state drives the in-motion flash. So the card
    // just reads them. entity_id -> Date.now() at last tap keeps the flash
    // instant before the gateway confirms motion (~5s for a scene); _movedSince
    // marks that the cover has actually started moving, so the flash hands off to
    // the cover's opening/closing state and stops exactly when the shade stops.
    this._commanded = {};
    this._movedSince = {};
    // Sun simulation state: live follows the clock until scrubbed/played.
    this._simLive = true;
    this._simPlaying = false;
    this._simSeason = "today";
    this._simMin = 720;
    this._simStaticKey = null;
  }

  setConfig(config) {
    if (config && config.layout) this._layout = config.layout;
    this._maybeBuild();
    this._update();
  }
  set panel(panel) {
    if (panel && panel.config && panel.config.layout) this._layout = panel.config.layout;
    this._maybeBuild();
    this._update();
  }
  set narrow(_v) {}
  set route(_v) {}
  set hass(hass) {
    this._hass = hass;
    this._maybeBuild();
    this._update();
  }
  get hass() { return this._hass; }

  getCardSize() { return 12; }

  _entity(slot) {
    const s = this._layout.shades[slot];
    return s ? s.entity : null;
  }
  _stateObj(slot) {
    const e = this._entity(slot);
    return e && this._hass ? this._hass.states[e] : undefined;
  }
  // Position (0=closed..100=open) straight from the unified cover. The cover
  // owns all live tracking, so its current_position is already the real,
  // display-ready value — no client-side gateway logic needed anymore.
  _pos(slot) {
    const st = this._stateObj(slot);
    if (!st || st.state === "unavailable" || st.state === "unknown") return null;
    const p = st.attributes.current_position;
    if (p != null) return Math.round(p);
    return st.state === "open" ? 100 : 0; // no position support -> binary
  }
  _dispPos(slot) {
    return this._pos(slot);
  }
  // Readout for a closed-% value: word at the extremes, number in between.
  _posLabel(closed) {
    if (closed <= 0) return "Open";
    if (closed >= 100) return "Closed";
    return `${closed}%`;
  }
  // In motion when the unified cover reports opening/closing, or briefly right
  // after a tap so the flash is instant before the cover's state round-trips.
  _isMoving(slot) {
    const st = this._stateObj(slot);
    const e = this._entity(slot);
    // Once the gateway sees real motion the cover reports opening/closing — hand
    // the flash off to it and remember it started (so we stop exactly when it does).
    if (st && (st.state === "opening" || st.state === "closing")) {
      this._movedSince[e] = true;
      return true;
    }
    // It moved and has now stopped -> done, clear the tap-flash.
    if (this._movedSince[e]) {
      delete this._movedSince[e];
      delete this._commanded[e];
      return false;
    }
    // Just tapped, gateway hasn't confirmed motion yet — keep flashing to bridge
    // the ~5s gap (a scene takes a few seconds to start). Cleared above the moment
    // the cover actually moves, so a generous window can't linger past a short move.
    return Date.now() - (this._commanded[e] || 0) < 12000;
  }

  // Flash a shade the instant it's tapped (the cover's opening/closing state
  // takes over within a beat).
  _mark(entity) {
    if (entity) this._commanded[entity] = Date.now();
  }

  _maybeBuild() {
    if (this._built || !this.shadowRoot) return;
    try {
      if (!document.getElementById("shade-dash-font")) {
        const l = document.createElement("link");
        l.id = "shade-dash-font";
        l.rel = "stylesheet";
        l.href = "https://fonts.googleapis.com/css2?family=Instrument+Sans:wght@400;500;600;700&display=swap";
        document.head.appendChild(l);
      }
    } catch (_e) { /* CSP may block; system font fallback is fine */ }
    const mobile = this._isMobile();
    this._builtMobile = mobile;
    // Keep _tab valid for the layout being built (panels differ per layout;
    // "settings" and "sun" exist in both).
    if (mobile && this._tab !== "settings" && this._tab !== "sun") this._tab = "home";
    if (!mobile && this._tab === "home") this._tab = "main";
    this._simStaticKey = null; // template rebuilt -> redraw the sim walls
    this.shadowRoot.innerHTML = mobile ? this._mobileTemplate() : this._template();
    this._built = true;
    this._wire();
    this._installResize();
  }

  // Phone vs tablet by available width (the HA mobile app panel is full-viewport).
  _isMobile() {
    const w = this.clientWidth || (typeof window !== "undefined" && window.innerWidth) || 1024;
    return w < 640;
  }
  // Rebuild the appropriate layout when the width crosses the breakpoint.
  _installResize() {
    if (this._ro || typeof ResizeObserver === "undefined") return;
    this._ro = new ResizeObserver(() => {
      if (this._built && this._isMobile() !== this._builtMobile) {
        this._built = false;
        this._maybeBuild();
        this._update();
      }
    });
    try { this._ro.observe(this); } catch (_e) { /* ignore */ }
  }

  // Settings view: which shades each bulk button moves. Groups move in sync via
  // one direct gateway call (shade_dashboard.move_group) — no PowerView scenes.
  // Read-only for now.
  _settingsHtml() {
    const groups = this._layout.groups || {};
    const LABELS = {
      all: "Whole House — Open All / Close All",
      main_floor: "Main Floor — Open / Close floor",
      south: "South Wall",
      west: "West Wall",
      north: "North Wall",
      hallway: "Main Hallway",
      upstairs: "Upstairs — Open / Close floor",
      main_bedroom: "Main Bedroom",
      upstairs_hallway: "Upstairs Hallway",
      office: "Kyle's Office",
    };
    const ORDER = ["all", "main_floor", "south", "west", "north", "hallway", "upstairs", "main_bedroom", "upstairs_hallway", "office"];
    const nameOf = (id) => {
      const st = this._hass && this._hass.states[id];
      const fn = st && st.attributes && st.attributes.friendly_name;
      return fn || id.replace(/^cover\.shade_/, "");
    };
    const chip = (id) =>
      `<span style="display:inline-block;font-size:11px;color:#4A4237;background:#F0EADE;border:1px solid #E2DACB;border-radius:7px;padding:2px 8px;margin:2px 4px 0 0">${nameOf(id)}</span>`;
    return `<div style="font-size:12px;color:#8A8177;padding:0 2px 4px">Each button moves its shades in one synchronized gateway call — no scenes involved.</div>` +
      ORDER.filter((g) => groups[g])
        .map((g) => {
          const members = groups[g] || [];
          return `<div style="border:1px solid #E2DACB;border-radius:12px;background:#FBF8F2;padding:12px 14px;display:flex;flex-direction:column;gap:6px">
            <div style="font-weight:700;font-size:13.5px;color:#26211B">${LABELS[g] || g} <span style="font-weight:500;color:#8A8177;font-size:11px">· ${members.length} shade${members.length === 1 ? "" : "s"} in sync</span></div>
            <div style="display:flex;flex-wrap:wrap">${members.map(chip).join("")}</div>
          </div>`;
        })
        .join("");
  }

  // --- Sun simulation (Sun tab) ---------------------------------------------
  // Real solar geometry projected onto scale elevations of the walls: today's
  // sun path (+ a Dec 21 ghost for seasonal contrast), the WNW ridge line, and
  // a scrubbable/playable sun. All angles come from solarPos() for the house
  // lat/lon; the wall projection is calibrated from the 2026-07-14 19:58 photo.
  _geoWalls() {
    return (this._layout.sun_geo && this._layout.sun_geo.walls) || {};
  }
  _geoLatLon() {
    const g = this._layout.sun_geo || {};
    return [g.lat, g.lon];
  }
  // WNW ridge height: the sun's elevation at the sun2 (terrain-corrected)
  // sunset instant — i.e. how high the mountains it sets behind are.
  _ridgeEl() {
    const [lat, lon] = this._geoLatLon();
    const ms = this._sunTime((this._layout.sun || {}).setting_entity);
    if (ms == null || lat == null) return RIDGE_EL_FALLBACK;
    const el = solarPos(ms, lat, lon).el;
    return el > 0 && el < 8 ? el : RIDGE_EL_FALLBACK;
  }
  _simDate(minutes) {
    const now = new Date();
    const MONTH = { jun: [5, 21], sep: [8, 21], dec: [11, 21] };
    const md = MONTH[this._simSeason];
    const base = md ? new Date(now.getFullYear(), md[0], md[1]) : new Date(now.getFullYear(), now.getMonth(), now.getDate());
    base.setMinutes(minutes);
    return base;
  }
  _fmtMin(min) {
    const h = Math.floor(min / 60) % 24, m = Math.round(min % 60);
    const hh = ((h + 11) % 12) + 1;
    return `${hh}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
  }
  _sunSimHtml() {
    const wallBox = (key) => {
      const w = WALL_ELEV[key];
      return `<div style="flex:1 1 280px;min-width:0;display:flex;flex-direction:column;gap:4px">
        <div style="display:flex;justify-content:space-between;align-items:baseline"><span style="font-weight:700;font-size:13px">${w.label}</span><span style="font-size:11px;color:#8A8177">faces ${w.az}°</span></div>
        <svg data-sim-svg="${key}" viewBox="-1 0 ${w.run + 2} ${w.sky + 0.8}" style="width:100%;height:auto;display:block;background:#FBF8F2;border:1px solid #E2DACB;border-radius:12px"></svg>
        <div data-sim-note="${key}" style="font-size:11px;color:#8A8177;text-align:center;min-height:15px"></div>
      </div>`;
    };
    return `
      <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
        <button data-sim-play title="Play the day" style="width:38px;height:38px;border-radius:10px;border:1px solid #E2DACB;background:#FFFDF9;font-size:15px;cursor:pointer">▶</button>
        <input data-sim-scrub type="range" min="270" max="1290" step="2" style="flex:1;min-width:130px">
        <span data-sim-time style="font:600 13px ui-monospace,Menlo,monospace;min-width:66px;text-align:right"></span>
        <span data-sim-pos style="font-size:11px;color:#8A8177;min-width:120px"></span>
        <button data-sim-now style="padding:9px 14px;border-radius:10px;border:1px solid #E2DACB;background:#FFFDF9;font-weight:600;font-size:12px;cursor:pointer">Now</button>
        <select data-sim-season style="padding:8px 10px;border-radius:10px;border:1px solid #E2DACB;background:#FFFDF9;font-weight:600;font-size:12px;font-family:inherit;cursor:pointer">
          <option value="today">Today</option><option value="jun">Jun 21</option><option value="sep">Sep 21</option><option value="dec">Dec 21</option>
        </select>
      </div>
      <div style="display:flex;flex-wrap:wrap;gap:14px;align-items:flex-start">${wallBox("west")}${wallBox("south")}${wallBox("up_west")}</div>
      <div style="font-size:11px;color:#8A8177">━ sun path (${"selected day"}) · ┄ Dec 21 · ╌ mountain ridge · dots mark whole hours · positions as seen from the seating area</div>`;
  }
  // Sample a day's sun track projected onto one wall; returns on-canvas segments.
  _simTrack(wallKey, dayBase) {
    const [lat, lon] = this._geoLatLon();
    const geo = this._geoWalls()[wallKey];
    const elev = WALL_ELEV[wallKey];
    if (!geo || lat == null) return { segs: [], ticks: [] };
    const segs = [], ticks = [];
    let cur = null;
    for (let min = 270; min <= 1290; min += 6) {
      const t = new Date(dayBase.getFullYear(), dayBase.getMonth(), dayBase.getDate());
      t.setMinutes(min);
      const { az, el } = solarPos(t.getTime(), lat, lon);
      const p = el > -1 ? sunOnWall(geo, az, el) : { behind: true };
      const ok = !p.behind && Math.abs(p.rel) < 75 && p.x > -1 && p.x < elev.run + 1 && p.z > -0.4 && p.z < elev.sky - 0.5;
      if (ok) {
        (cur || segs[segs.push(cur = []) - 1]).push([p.x, p.z]);
        if (min % 60 === 0) ticks.push({ x: p.x, z: p.z, h: min / 60 });
      } else cur = null;
    }
    return { segs, ticks };
  }
  _drawSimWall(key, dayBase, ridge) {
    const w = WALL_ELEV[key];
    const Y = (z) => w.sky - z; // feet -> svg y (z up, y down)
    const seg2path = (s) => "M" + s.map(([x, z]) => `${x.toFixed(2)},${Y(z).toFixed(2)}`).join("L");
    let out = `<line x1="-1" y1="${Y(0)}" x2="${w.run + 1}" y2="${Y(0)}" stroke="#CDC3B2" stroke-width=".1"/>`;
    for (const win of w.windows) {
      if (win.deco === "chimney") { out += `<rect x="${win.rect[0]}" y="${Y(win.rect[1] + win.rect[3])}" width="${win.rect[2]}" height="${win.rect[3]}" fill="#D3CCBE"/>`; continue; }
      if (win.deco === "door") { out += `<rect x="${win.rect[0]}" y="${Y(win.rect[1] + win.rect[3])}" width="${win.rect[2]}" height="${win.rect[3]}" fill="#4A423A" opacity=".6" rx=".1"/>`; continue; }
      const shape = win.rect
        ? `<rect x="${win.rect[0]}" y="${Y(win.rect[1] + win.rect[3])}" width="${win.rect[2]}" height="${win.rect[3]}" fill="#DCE3E4" stroke="#1F1B17" stroke-width=".18"/>`
        : `<polygon points="${win.pts.map(([x, z]) => `${x},${Y(z).toFixed(2)}`).join(" ")}" fill="#D3DCE0" stroke="#1F1B17" stroke-width=".18"/>`;
      out += shape;
      if (win.slot && win.rect && win.rect[1] < 8.5) out += `<text x="${win.rect[0] + win.rect[2] / 2}" y="${Y(-0.75)}" text-anchor="middle" font-size=".78" fill="#8A8177" font-family="ui-monospace,Menlo,monospace">${win.slot}</text>`;
    }
    const geo = this._geoWalls()[key];
    if (w.ridge && geo) {
      const zr = geo.eye_h + geo.viewer_d * Math.tan((ridge * Math.PI) / 180);
      out += `<line x1="-1" y1="${Y(zr).toFixed(2)}" x2="${w.run + 1}" y2="${Y(zr).toFixed(2)}" stroke="#9C9484" stroke-width=".09" stroke-dasharray=".6 .45"/><text x="${w.run + 0.9}" y="${Y(zr + 0.35).toFixed(2)}" text-anchor="end" font-size=".7" fill="#9C9484">ridge</text>`;
    }
    // Dec 21 ghost (seasonal contrast) under today's path
    if (this._simSeason !== "dec") {
      const dec = this._simTrack(key, new Date(new Date().getFullYear(), 11, 21));
      out += dec.segs.map((s) => `<path d="${seg2path(s)}" fill="none" stroke="#8A93B8" stroke-width=".14" stroke-dasharray=".5 .4" opacity=".75"/>`).join("");
      const first = dec.segs[0] && dec.segs[0][0];
      if (first) out += `<text x="${first[0] + 0.3}" y="${Y(first[1] + 0.5).toFixed(2)}" font-size=".7" fill="#8A93B8">Dec 21</text>`;
    }
    const day = this._simTrack(key, dayBase);
    out += day.segs.map((s) => `<path d="${seg2path(s)}" fill="none" stroke="#C67B3B" stroke-width=".16" opacity=".85"/>`).join("");
    for (const t of day.ticks) {
      out += `<circle cx="${t.x.toFixed(2)}" cy="${Y(t.z).toFixed(2)}" r=".17" fill="#C67B3B"/><text x="${t.x.toFixed(2)}" y="${Y(t.z + 0.65).toFixed(2)}" text-anchor="middle" font-size=".68" fill="#A08B72">${((t.h + 11) % 12) + 1}${t.h < 12 ? "a" : "p"}</text>`;
    }
    out += `<g data-sim-dot style="display:none">
      <circle r="1.05" fill="#F0A94F" opacity=".14"/><circle r=".62" fill="#F0A94F" opacity=".3"/>
      <circle r=".36" fill="#F3B25C"/><circle r=".22" fill="#E8963C"/>
    </g>`;
    return { svg: out, hasToday: day.segs.length > 0 };
  }
  _updateSunSim() {
    const root = this.shadowRoot;
    if (!root || !root.querySelector("[data-sim-svg]")) return;
    const [lat, lon] = this._geoLatLon();
    if (lat == null) return;
    if (this._simLive) {
      const n = new Date();
      this._simMin = n.getHours() * 60 + n.getMinutes();
    }
    const min = Math.min(1290, Math.max(270, this._simMin));
    const dayBase = this._simDate(0);
    const ridge = this._ridgeEl();
    const staticKey = `${this._simSeason}|${dayBase.toDateString()}|${ridge.toFixed(2)}`;
    if (this._simStaticKey !== staticKey) {
      this._simStaticKey = staticKey;
      for (const key of Object.keys(WALL_ELEV)) {
        const svg = root.querySelector(`[data-sim-svg="${key}"]`);
        if (!svg) continue;
        const drawn = this._drawSimWall(key, dayBase, ridge);
        svg.innerHTML = drawn.svg;
        svg._hasToday = drawn.hasToday;
      }
    }
    const t = this._simDate(min);
    const { az, el } = solarPos(t.getTime(), lat, lon);
    const scrub = root.querySelector("[data-sim-scrub]");
    if (scrub && !this._simScrubbing) scrub.value = String(min);
    const timeEl = root.querySelector("[data-sim-time]");
    if (timeEl) timeEl.textContent = this._fmtMin(min);
    const posEl = root.querySelector("[data-sim-pos]");
    if (posEl) posEl.textContent = el > -1 ? `az ${az.toFixed(0)}° · el ${el.toFixed(1)}°` : "sun below horizon";
    const playBtn = root.querySelector("[data-sim-play]");
    if (playBtn) playBtn.textContent = this._simPlaying ? "⏸" : "▶";
    for (const key of Object.keys(WALL_ELEV)) {
      const svg = root.querySelector(`[data-sim-svg="${key}"]`);
      const note = root.querySelector(`[data-sim-note="${key}"]`);
      if (!svg) continue;
      const dot = svg.querySelector("[data-sim-dot]");
      const w = WALL_ELEV[key];
      const geo = this._geoWalls()[key];
      const p = geo && el > -0.9 ? sunOnWall(geo, az, el) : { behind: true };
      let noteTxt = "";
      if (el <= -0.9) noteTxt = "Night — sun below the horizon";
      else if (p.behind) noteTxt = "Sun is behind this wall";
      else if (w.ridge && el < ridge - 0.25) noteTxt = "Sun set behind the ridge";
      if (dot) {
        if (!p.behind && el > -0.9 && !(w.ridge && el < ridge - 0.25) && p.x > -1 && p.x < w.run + 1) {
          const clamped = p.z > w.sky - 0.7;
          const z = clamped ? w.sky - 0.7 : Math.max(-0.3, p.z);
          dot.style.display = "";
          dot.style.opacity = clamped ? "0.45" : "1";
          dot.setAttribute("transform", `translate(${p.x.toFixed(2)},${(w.sky - z).toFixed(2)})`);
          if (clamped) noteTxt = `Sun is above these windows (el ${el.toFixed(0)}°)`;
        } else dot.style.display = "none";
      }
      if (note) note.textContent = noteTxt || (svg._hasToday === false ? "No direct sun on this glass today — see the Dec 21 path" : "");
    }
  }
  _wireSim() {
    const root = this.shadowRoot;
    const scrub = root.querySelector("[data-sim-scrub]");
    if (!scrub) return;
    const seasonSel = root.querySelector("[data-sim-season]");
    scrub.addEventListener("input", () => {
      this._simLive = false;
      this._simScrubbing = true;
      this._simMin = Number(scrub.value);
      this._updateSunSim();
      this._simScrubbing = false;
    });
    root.querySelector("[data-sim-now]").addEventListener("click", () => {
      this._simLive = true;
      this._simPlaying = false;
      this._simSeason = "today";
      if (seasonSel) seasonSel.value = "today";
      this._updateSunSim();
    });
    if (seasonSel) seasonSel.addEventListener("change", () => {
      this._simSeason = seasonSel.value;
      if (this._simSeason !== "today") this._simLive = false;
      this._updateSunSim();
    });
    root.querySelector("[data-sim-play]").addEventListener("click", () => {
      this._simPlaying = !this._simPlaying;
      if (this._simPlaying) {
        this._simLive = false;
        if (this._simMin >= 1288) this._simMin = 270; // restart from dawn
        const step = () => {
          if (!this._simPlaying || !this.isConnected) return;
          this._simMin += 1.6;
          if (this._simMin >= 1290) { this._simMin = 1290; this._simPlaying = false; }
          this._updateSunSim();
          if (this._simPlaying) requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
      }
      this._updateSunSim();
    });
  }
  // Live sun dot over the interactive wall drawings (desktop tabs). Maps the
  // sun2 sensor az/el through the same projection, then anchors feet -> pixels
  // on two known window edges so it adapts to the drawn layout automatically.
  _updateSunOverlays(az, el) {
    const root = this.shadowRoot;
    if (!root || !root.querySelector("[data-sunov]")) return;
    const ridge = this._ridgeEl();
    const ANCHORS = {
      west: { wall: "west", left: ["l3", 0.3], right: ["l6", 18.7], top: ["u4", 18.39], bot: ["l3", 0.3] },
      south: { wall: "south", left: ["u1", 0.3], right: ["u3", 18.7], top: ["u1", 18.4], bot: ["l1", 0.3] },
      uphall: { wall: "up_west", left: ["uh1", 0.25], right: ["uh3", 9.35], top: ["uh1", 7.0], bot: ["uh1", 2.0] },
      office: { wall: "up_west", left: ["ko1", 10.45], right: ["ko2", 16.35], top: ["ko1", 7.0], bot: ["ko1", 2.0] },
    };
    for (const [key, a] of Object.entries(ANCHORS)) {
      const ov = root.querySelector(`[data-sunov="${key}"]`);
      if (!ov) continue;
      const geo = this._geoWalls()[a.wall];
      const w = WALL_ELEV[a.wall];
      const p = geo && az != null && el != null && el > -0.5 ? sunOnWall(geo, az, el) : { behind: true };
      const blocked = p.behind || (w && w.ridge && el < ridge - 0.25)
        || p.x < a.left[1] - 1.2 || p.x > a.right[1] + 1.2 || p.z < a.bot[1] - 1.2 || p.z > a.top[1] + 1.6;
      if (blocked) { ov.style.display = "none"; continue; }
      const box = ov.parentElement.getBoundingClientRect();
      const rect = (slot) => { const elx = root.querySelector(`[data-slot="${slot}"]`); return elx && elx.getBoundingClientRect(); };
      const L = rect(a.left[0]), R = rect(a.right[0]), T = rect(a.top[0]), Bo = rect(a.bot[0]);
      if (!L || !R || !T || !Bo || !box.width) { ov.style.display = "none"; continue; }
      const xPx = L.left + ((p.x - a.left[1]) / (a.right[1] - a.left[1])) * (R.right - L.left);
      const yPx = Bo.bottom - ((p.z - a.bot[1]) / (a.top[1] - a.bot[1])) * (Bo.bottom - T.top);
      ov.style.display = "block";
      ov.style.left = `${(((xPx - box.left) / box.width) * 100).toFixed(2)}%`;
      ov.style.top = `${(((yPx - box.top) / box.height) * 100).toFixed(2)}%`;
      ov.title = `Sun · az ${az.toFixed(0)}° el ${el.toFixed(1)}°`;
    }
  }

  _template() {
    const sc = this._layout.scenes;
    const tg = this._layout.toggles || {};
    // South wall: three columns against the chimney
    const south =
      `<div style="display:flex;flex-direction:column;align-items:center;gap:10px">` +
        `<div style="position:relative;display:flex;align-items:stretch;gap:14px">` +
          sunDot("south") +
          // col 1: upper 1 over the front door
          `<div style="display:flex;flex-direction:column;justify-content:space-between;align-items:center;height:470px">` +
            lowerCol("u1", GLASS_UPPER) +
            `<div style="display:flex;flex-direction:column;align-items:center;gap:6px"><div title="Front door (no shade)" style="width:84px;height:190px;border:3px solid #1F1B17;border-radius:3px;background:linear-gradient(180deg,#3A342C 0%,#4A423A 60%,#5A5044 100%);opacity:.75;position:relative"><div style="position:absolute;left:10px;right:10px;top:12px;bottom:44%;background:linear-gradient(180deg,#8FA0A8,#B9BDB0);border-radius:2px"></div></div><span style="font:700 12px ui-monospace,Menlo,monospace;color:#9B9284">DOOR</span></div>` +
          `</div>` +
          // col 2: upper 2 over lower 1
          `<div style="display:flex;flex-direction:column;justify-content:space-between;align-items:center;height:470px">${lowerCol("u2", GLASS_UPPER)}${lowerCol("l1")}</div>` +
          // chimney
          `<div style="width:84px;height:448px;align-self:flex-start;border-radius:3px 3px 0 0;background:repeating-linear-gradient(180deg,#D3CCBE 0 8px,#C6BDAD 8px 10px)"></div>` +
          // col 3: upper 3 over lower 2 (the offline one)
          `<div style="display:flex;flex-direction:column;justify-content:space-between;align-items:center;height:470px">${lowerCol("u3", GLASS_UPPER)}${lowerCol("l2")}</div>` +
        `</div>` +
        chip("south", "SOUTH WALL") +
      `</div>`;
    // West wall: 4 angled uppers over 4 lowers
    const west =
      `<div style="display:flex;flex-direction:column;align-items:center;gap:10px">` +
        // gap sized so the angled uppers' bottoms line up with the south-wall uppers'
        // bottoms (the angled columns now include a label row below each window)
        `<div style="position:relative;display:flex;flex-direction:column;gap:48px;align-items:center">` +
          sunDot("west") +
          `<div style="display:flex;align-items:flex-end;gap:14px">${angledCol("u4", 190)}${angledCol("u5", 150)}${angledCol("u6", 110)}${angledCol("u7", 70)}</div>` +
          `<div style="display:flex;align-items:flex-end;gap:14px">${lowerCol("l3")}${lowerCol("l4")}${lowerCol("l5")}${lowerCol("l6")}</div>` +
        `</div>` +
        chip("west", "WEST WALL") +
      `</div>`;
    const north =
      `<div style="display:flex;flex-direction:column;align-items:center;gap:10px">` +
        `<div style="display:flex;align-items:flex-end;gap:14px">${lowerCol("l7")}${lowerCol("l8")}</div>` +
        chip("north", "NORTH WALL") +
      `</div>`;
    const hallway =
      `<div style="display:flex;flex-direction:column;align-items:center;gap:10px">` +
        `<div style="display:flex;flex-direction:column;align-items:center;gap:6px">${winRect("lrh1", GLASS_LOWER)}${label("lrh1")}</div>` +
        chip("hallway", "HALLWAY") +
      `</div>`;

    const mainBedroom =
      `<div style="display:flex;flex-direction:column;align-items:center;gap:14px">` +
        `<span style="font-size:12px;font-weight:700;letter-spacing:1.6px;color:#4A4237">MAIN BEDROOM</span>` +
        `<div style="display:flex;align-items:flex-end;gap:14px">${doorCol("mbr1")}</div>` +
        chip("main_bedroom", "SLIDING DOORS") +
      `</div>`;
    const upHall =
      `<div style="display:flex;flex-direction:column;align-items:center;gap:14px">` +
        `<span style="font-size:12px;font-weight:700;letter-spacing:1.6px;color:#4A4237">UPSTAIRS HALLWAY</span>` +
        `<div style="position:relative;display:flex;align-items:flex-end;gap:14px">${sunDot("uphall")}${lowerCol("uh1")}${divider()}${lowerCol("uh2")}${lowerCol("uh3")}</div>` +
        chip("upstairs_hallway", "ALL HALLWAY") +
      `</div>`;
    const office =
      `<div style="display:flex;flex-direction:column;align-items:center;gap:14px">` +
        `<span style="font-size:12px;font-weight:700;letter-spacing:1.6px;color:#4A4237">KYLE'S OFFICE</span>` +
        `<div style="position:relative;display:flex;align-items:flex-end;gap:14px">${sunDot("office")}${lowerCol("ko1")}${lowerCol("ko2")}</div>` +
        chip("office", "ALL OFFICE") +
      `</div>`;

    return `
<style>
  /* Scale the whole panel up for easier touch control on the small wall tablet. */
  :host { display:block; height:100%; zoom:1.15; font-family:'Instrument Sans',system-ui,sans-serif; color:#26211B; }
  * { box-sizing:border-box; }
  button { font-family:inherit; }
  .frame { width:100%; height:100%; min-height:640px; background:#F5F1EA; display:flex; overflow:hidden; }
  .rail { width:210px; flex-shrink:0; background:#FFFDF9; border-right:1px solid #EAE2D4; padding:20px 18px; display:flex; flex-direction:column; gap:14px; overflow-y:auto; }
  .main { flex:1; position:relative; padding:20px 22px; display:flex; flex-direction:column; gap:14px; min-width:0; }
  input[type=range]{ accent-color:${ACCENT}; }
  .pill { padding:9px 18px; border-radius:999px; border:1px solid #E2DACB; cursor:pointer; font-weight:600; font-size:13px; }
  ${FLASH_CSS}
</style>
<div class="frame">
  <div class="rail">
    <div>
      <div style="font-size:19px;font-weight:700;letter-spacing:.3px">Shades</div>
      <div style="font-size:11px;color:#8A8177;margin-top:2px">22 shades</div>
    </div>
    ${this._sunCardHtml()}
    <div style="font-size:10px;letter-spacing:1.4px;color:#8A8177;font-weight:600;margin-top:6px">SCENES</div>
    ${sceneBtn("open_all", sc.open_all)}
    ${sceneBtn("close_all", sc.close_all)}
    <div style="font-size:10px;letter-spacing:1.4px;color:#8A8177;font-weight:600;margin-top:6px">MODES</div>
    ${Object.keys(tg).map((k) => toggleRow(k, tg[k])).join("")}
    <div style="flex:1"></div>
    <div data-summary style="font-size:11px;color:#8A8177"></div>
  </div>
  <div class="main">
    <div style="display:flex;gap:8px;align-items:center">
      <button data-tab="main" class="pill">Main Floor</button>
      <button data-tab="up" class="pill">Upstairs</button>
      <button data-tab="sun" class="pill">Sun</button>
      <button data-tab="settings" class="pill" title="Settings" aria-label="Settings" style="margin-left:auto;width:38px;height:38px;padding:0;display:inline-flex;align-items:center;justify-content:center;font-size:17px">⚙</button>
    </div>

    <div data-panel="main" style="flex-direction:column;gap:8px;flex:1;min-height:0;min-width:0">
      <div style="display:flex;align-items:center;justify-content:space-between">
        <div style="display:flex;align-items:baseline;gap:10px"><span style="font-size:18px;font-weight:700">Main Floor</span><span style="font-size:12px;color:#8A8177">Living room + hallway · 16 shades · scroll →</span></div>
        <div style="display:flex;gap:8px"><button data-group="main_floor" data-dir="up" style="padding:8px 14px;border-radius:10px;border:1px solid #E2DACB;background:#FFFDF9;font-weight:600;font-size:12px;cursor:pointer;color:#26211B">Open floor</button><button data-group="main_floor" data-dir="down" style="padding:8px 14px;border-radius:10px;border:1px solid #E2DACB;background:#FFFDF9;font-weight:600;font-size:12px;cursor:pointer;color:#26211B">Close floor</button></div>
      </div>
      <div style="flex:1;overflow-x:auto;overflow-y:hidden;display:flex;align-items:center">
        <div style="display:flex;align-items:flex-end;gap:16px;padding:4px 10px 12px;margin:auto;flex-shrink:0">
          ${south}${divider()}${west}${divider()}${north}${divider()}${hallway}
        </div>
      </div>
    </div>

    <div data-panel="up" style="flex-direction:column;gap:8px;flex:1">
      <div style="display:flex;align-items:center;justify-content:space-between">
        <div style="display:flex;align-items:baseline;gap:10px"><span style="font-size:18px;font-weight:700">Upstairs</span><span style="font-size:12px;color:#8A8177">Main bedroom + hallway + office · 6 shades</span></div>
        <div style="display:flex;gap:8px"><button data-group="upstairs" data-dir="up" style="padding:8px 14px;border-radius:10px;border:1px solid #E2DACB;background:#FFFDF9;font-weight:600;font-size:12px;cursor:pointer;color:#26211B">Open floor</button><button data-group="upstairs" data-dir="down" style="padding:8px 14px;border-radius:10px;border:1px solid #E2DACB;background:#FFFDF9;font-weight:600;font-size:12px;cursor:pointer;color:#26211B">Close floor</button></div>
      </div>
      <div style="flex:1;display:flex;align-items:center;justify-content:center;gap:48px">
        ${mainBedroom}${divider()}${upHall}${divider()}${office}
      </div>
    </div>

    <div data-panel="sun" style="flex-direction:column;gap:12px;flex:1;min-height:0;overflow-y:auto">
      <div style="display:flex;align-items:baseline;gap:10px"><span style="font-size:18px;font-weight:700">Sun</span><span style="font-size:12px;color:#8A8177">Where the sun crosses your windows — real solar geometry for this house</span></div>
      ${this._sunSimHtml()}
    </div>

    <div data-panel="settings" style="flex-direction:column;gap:8px;flex:1;min-height:0">
      <div style="display:flex;align-items:baseline;gap:10px"><span style="font-size:18px;font-weight:700">Settings</span><span style="font-size:12px;color:#8A8177">Which shades each button moves</span></div>
      <div style="flex:1;overflow-y:auto;display:flex;flex-direction:column;gap:10px;padding:2px 2px 8px">
        ${this._settingsHtml()}
      </div>
    </div>

    <div data-bar style="position:absolute;left:22px;right:22px;bottom:16px;display:none;align-items:center;gap:14px;padding:12px 16px;background:#26211B;color:#F5F1EA;border-radius:14px;box-shadow:0 10px 30px rgba(30,25,18,.3)">
      <button data-bar-close style="width:26px;height:26px;border-radius:50%;border:none;background:rgba(255,255,255,.12);color:#F5F1EA;cursor:pointer;flex-shrink:0">✕</button>
      <div style="min-width:200px"><div data-bar-name style="font-weight:600;font-size:14px"></div><div data-bar-sub style="font-size:11px;color:#B8AF9F"></div></div>
      <div data-bar-ctl style="display:flex;align-items:center;gap:12px;flex:1">
        <input data-bar-slider type="range" min="0" max="100" value="0" style="flex:1">
        <span data-bar-pct style="font:600 13px ui-monospace,Menlo,monospace;min-width:62px;text-align:right"></span>
        <button data-bar-action="close" style="padding:8px 14px;border-radius:9px;border:1px solid rgba(255,255,255,.25);background:transparent;color:#F5F1EA;cursor:pointer;font-weight:600;font-size:12px">Close</button>
        <button data-bar-action="open" style="padding:8px 14px;border-radius:9px;border:none;background:${ACCENT};color:#FFF;cursor:pointer;font-weight:600;font-size:12px">Open</button>
        <button data-bar-recal title="Re-teach this shade's travel limits" style="display:none;padding:8px 12px;border-radius:9px;border:1px solid rgba(255,255,255,.25);background:transparent;color:#B8AF9F;cursor:pointer;font-weight:600;font-size:12px;flex-shrink:0">Recalibrate</button>
      </div>
      <div data-bar-unavail style="display:none;flex:1;font-size:12px;color:#E4B7A0">Unavailable in Home Assistant — check shade power or the PowerView gateway.</div>
    </div>
  </div>
</div>`;
  }

  // Phone layout: one vertical scroll — whole-house buttons, a card per section
  // (open/close chip + compact tiles), modes, settings. Reuses every data hook
  // (data-slot/fabric/flash/label, data-group/scene/toggle, data-bar-*) so
  // _update/_wire/_setFabric/control-bar work unchanged.
  _mobileTemplate() {
    const tg = this._layout.toggles || {};
    const isUpper = (s) => /^u\d/.test(s);
    const SECTIONS = [
      { label: "South Wall", group: "south", slots: ["u1", "u2", "u3", "l1", "l2"] },
      { label: "West Wall", group: "west", slots: ["u4", "u5", "u6", "u7", "l3", "l4", "l5", "l6"] },
      { label: "North Wall", group: "north", slots: ["l7", "l8"] },
      { label: "Main Hallway", group: "hallway", slots: ["lrh1"] },
      { label: "Main Bedroom", group: "main_bedroom", slots: ["mbr1"], door: true },
      { label: "Upstairs Hallway", group: "upstairs_hallway", slots: ["uh1", "uh2", "uh3"] },
      { label: "Kyle's Office", group: "office", slots: ["ko1", "ko2"] },
    ];
    const btn = (g, dir, txt) =>
      `<button data-group="${g}" data-dir="${dir}" style="padding:7px 14px;border-radius:9px;border:1px solid #DFD7C9;background:#FBF8F2;font-weight:600;font-size:12px;color:#4A4237;cursor:pointer">${txt}</button>`;
    const section = (s) =>
      `<div style="border:1px solid #EAE2D4;border-radius:14px;background:#FFFDF9;padding:12px 12px 14px">` +
        `<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px"><span style="font-weight:700;font-size:14px">${s.label}</span><div style="display:flex;gap:8px">${btn(s.group, "up", "Open")}${btn(s.group, "down", "Close")}</div></div>` +
        `<div style="display:flex;flex-wrap:wrap;gap:12px 14px">${s.slots.map((slot) => (s.door ? mobileDoorTile(slot) : mobileWin(slot, isUpper(slot) ? GLASS_UPPER : GLASS_LOWER))).join("")}</div>` +
      `</div>`;
    const bigBtn = (scene, txt) =>
      `<button data-scene="${scene}" style="flex:1;padding:15px;border-radius:12px;border:1px solid #E2DACB;background:#FFFDF9;font-weight:700;font-size:14px;color:#26211B;cursor:pointer">${txt}</button>`;
    return `
<style>
  :host { display:block; height:100%; font-family:'Instrument Sans',system-ui,sans-serif; color:#26211B; }
  * { box-sizing:border-box; }
  button { font-family:inherit; }
  input[type=range]{ accent-color:${ACCENT}; height:28px; }
  .mframe { position:relative; width:100%; height:100%; background:#F5F1EA; display:flex; flex-direction:column; overflow:hidden; }
  ${FLASH_CSS}
</style>
<div class="mframe">
  <div style="display:flex;align-items:center;justify-content:space-between;padding:14px 16px 8px;flex-shrink:0">
    <div><div style="font-size:20px;font-weight:700">Shades</div><div data-summary style="font-size:11px;color:#8A8177;margin-top:1px"></div></div>
    <div style="display:flex;gap:8px">
      <button data-tab="sun" title="Sun simulation" aria-label="Sun simulation" style="width:40px;height:40px;border-radius:999px;border:1px solid #E2DACB;background:#FFFDF9;font-size:18px;cursor:pointer;display:inline-flex;align-items:center;justify-content:center">☀</button>
      <button data-tab="settings" title="Settings" aria-label="Settings" style="width:40px;height:40px;border-radius:999px;border:1px solid #E2DACB;background:#FFFDF9;font-size:18px;cursor:pointer;display:inline-flex;align-items:center;justify-content:center">⚙</button>
    </div>
  </div>

  <div data-panel="home" style="flex:1;overflow-y:auto;padding:4px 14px 150px;display:flex;flex-direction:column;gap:14px">
    ${this._sunCardHtml()}
    <div style="display:flex;gap:10px">${bigBtn("open_all", "Open All")}${bigBtn("close_all", "Close All")}</div>
    ${SECTIONS.map(section).join("")}
    <div style="font-size:10px;letter-spacing:1.4px;color:#8A8177;font-weight:600;margin-top:4px">MODES</div>
    ${Object.keys(tg).map((k) => toggleRow(k, tg[k])).join("")}
  </div>

  <div data-panel="sun" style="flex:1;overflow-y:auto;padding:4px 14px 150px;display:none;flex-direction:column;gap:12px">
    <button data-tab="home" style="align-self:flex-start;padding:9px 16px;border-radius:9px;border:1px solid #E2DACB;background:#FFFDF9;font-weight:600;font-size:13px;color:#26211B;cursor:pointer">← Back</button>
    <div style="font-size:18px;font-weight:700">Sun</div>
    ${this._sunSimHtml()}
  </div>

  <div data-panel="settings" style="flex:1;overflow-y:auto;padding:4px 14px 150px;display:none;flex-direction:column;gap:10px">
    <button data-tab="home" style="align-self:flex-start;padding:9px 16px;border-radius:9px;border:1px solid #E2DACB;background:#FFFDF9;font-weight:600;font-size:13px;color:#26211B;cursor:pointer">← Back</button>
    <div style="font-size:18px;font-weight:700">Settings</div>
    ${this._settingsHtml()}
  </div>

  <div data-bar style="position:absolute;left:10px;right:10px;bottom:12px;display:none;flex-direction:column;gap:10px;padding:12px 14px;background:#26211B;color:#F5F1EA;border-radius:16px;box-shadow:0 12px 34px rgba(30,25,18,.4)">
    <div style="display:flex;align-items:center;gap:10px">
      <button data-bar-close style="width:28px;height:28px;border-radius:50%;border:none;background:rgba(255,255,255,.12);color:#F5F1EA;font-size:14px;cursor:pointer;flex-shrink:0">✕</button>
      <div style="flex:1;min-width:0"><div data-bar-name style="font-weight:600;font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis"></div><div data-bar-sub style="font-size:11px;color:#B8AF9F"></div></div>
      <span data-bar-pct style="font:600 14px ui-monospace,Menlo,monospace;flex-shrink:0"></span>
    </div>
    <div data-bar-ctl style="display:flex;flex-wrap:wrap;align-items:center;gap:10px">
      <input data-bar-slider type="range" min="0" max="100" value="0" style="flex:1 1 100%">
      <button data-bar-action="close" style="flex:1;padding:12px;border-radius:10px;border:1px solid rgba(255,255,255,.25);background:transparent;color:#F5F1EA;font-weight:600;font-size:13px;cursor:pointer">Close</button>
      <button data-bar-action="open" style="flex:1;padding:12px;border-radius:10px;border:none;background:${ACCENT};color:#FFF;font-weight:600;font-size:13px;cursor:pointer">Open</button>
      <button data-bar-recal title="Re-teach this shade's travel limits" style="display:none;flex:1;padding:12px;border-radius:10px;border:1px solid rgba(255,255,255,.25);background:transparent;color:#B8AF9F;font-weight:600;font-size:13px;cursor:pointer">Recalibrate</button>
    </div>
    <div data-bar-unavail style="display:none;font-size:12px;color:#E4B7A0">Unavailable in Home Assistant — check shade power or the PowerView gateway.</div>
  </div>
</div>`;
  }

  _wire() {
    const root = this.shadowRoot;
    // window selection
    root.querySelectorAll("[data-slot]").forEach((el) =>
      el.addEventListener("click", () => this._select(el.getAttribute("data-slot")))
    );
    // tabs
    root.querySelectorAll("[data-tab]").forEach((el) =>
      el.addEventListener("click", () => { this._tab = el.getAttribute("data-tab"); this._update(); })
    );
    // sun simulation controls (scrubber/play/now/season)
    this._wireSim();
    // group chips + floor buttons
    root.querySelectorAll("[data-group]").forEach((el) =>
      el.addEventListener("click", () => this._group(el.getAttribute("data-group"), el.getAttribute("data-dir")))
    );
    // scenes
    root.querySelectorAll("[data-scene]").forEach((el) =>
      el.addEventListener("click", () => this._scene(el.getAttribute("data-scene")))
    );
    root.querySelectorAll("[data-toggle]").forEach((el) =>
      el.addEventListener("click", () => this._toggle(el.getAttribute("data-toggle")))
    );
    // control bar
    root.querySelector("[data-bar-close]").addEventListener("click", () => { this._selected = null; this._update(); });
    // The UI shows a CLOSED percentage (0% = open, 100% = closed); HA's
    // current_position is the inverse (100 = open), so convert on read/write.
    const slider = root.querySelector("[data-bar-slider]");
    slider.addEventListener("input", () => {
      this._dragging = true;
      const closed = Number(slider.value);
      root.querySelector("[data-bar-pct]").textContent = this._posLabel(closed);
      if (this._selected) this._setFabric(this._selected, 100 - closed);
    });
    slider.addEventListener("change", () => {
      this._dragging = false;
      if (!this._selected || this._calibrating(this._selected)) return;
      const target = 100 - Number(slider.value);
      this._mark(this._entity(this._selected), target);
      this._callCover("set_cover_position", this._entity(this._selected), { position: target });
      this._update();
    });
    root.querySelector('[data-bar-action="open"]').addEventListener("click", () => this._commandSelected("open_cover", 100));
    root.querySelector('[data-bar-action="close"]').addEventListener("click", () => this._commandSelected("close_cover", 0));
    root.querySelector("[data-bar-recal]").addEventListener("click", () => this._recalSelected());
  }

  // --- actions ---------------------------------------------------------------
  _callCover(service, entity, extra) {
    if (!entity || !this._hass) return;
    this._hass.callService("cover", service, Object.assign({ entity_id: entity }, extra || {}));
  }
  _commandSelected(service, target) {
    if (!this._selected || this._calibrating(this._selected)) return;
    this._mark(this._entity(this._selected), target);
    this._callCover(service, this._entity(this._selected));
    this._update();
  }
  // Recalibrate re-teaches the shade's limits and drives it to both hard stops
  // (~1 min), so it takes two taps: the first arms a 4s confirm.
  _recalSelected() {
    if (!this._selected || !this._hass || this._calibrating(this._selected)) return;
    const entity = this._entity(this._selected);
    if (this._recalArmed !== this._selected) {
      this._recalArmed = this._selected;
      clearTimeout(this._recalTimer);
      this._recalTimer = setTimeout(() => { this._recalArmed = null; this._update(); }, 4000);
      this._update();
      return;
    }
    clearTimeout(this._recalTimer);
    this._recalArmed = null;
    this._hass.callService("shade_dashboard", "recalibrate", { entity_id: entity });
    this._mark(entity); // flash it — it's about to cycle its limits
    this._update();
  }
  _group(group, dir) {
    // Refuse bulk moves while any shade is calibrating (skip only that one? a
    // group move should wait until it finishes).
    if (this._anyCalibrating()) return;
    const entities = (this._layout.groups[group] || []).filter((e) => {
      const st = this._hass && this._hass.states[e];
      return st && st.state !== "unavailable";
    });
    if (!entities.length) return;
    const position = dir === "up" ? 100 : 0;
    // Flash every member at once, then move them all in one synchronized call
    // (no PowerView scene — see shade_dashboard.move_group).
    entities.forEach((e) => this._mark(e));
    this._hass.callService("shade_dashboard", "move_group", { entity_id: entities, position });
    this._update();
  }
  _scene(key) {
    const s = this._layout.scenes[key];
    if (!s) return;
    if (s.kind === "group") {
      this._lastScene = key;
      this._group(s.group, s.dir);
      return;
    }
    if (s.script) {
      this._hass.callService("script", "turn_on", { entity_id: s.script });
      this._lastScene = key;
      this._update();
    }
  }
  _toggle(key) {
    const t = (this._layout.toggles || {})[key];
    if (!t || !this._hass) return;
    const st = this._hass.states[t.entity];
    const on = st && st.state === "on";
    if (t.enable_script || t.disable_script) {
      // Drive via scripts (they set the boolean AND do side effects e.g. reset timers)
      const script = on ? t.disable_script : t.enable_script;
      if (script) this._hass.callService("script", "turn_on", { entity_id: script });
    } else {
      this._hass.callService("input_boolean", on ? "turn_off" : "turn_on", { entity_id: t.entity });
    }
  }
  _select(slot) {
    this._selected = this._selected === slot ? null : slot;
    this._update();
  }

  // --- live update -----------------------------------------------------------
  _setFabric(slot, pos) {
    const f = this.shadowRoot.querySelector(`[data-fabric="${slot}"]`);
    if (!f) return;
    const v = `${Math.max(0, Math.min(100, 100 - pos))}%`;
    if (f.dataset.axis === "x") f.style.width = v;
    else f.style.height = v;
  }

  _update() {
    if (!this._built || !this._hass) return;
    const root = this.shadowRoot;

    // Flash every moving shade in UNISON: pin each pulse animation's startTime to
    // a shared origin (0) via the Web Animations API, so they all ride the one
    // document timeline at the same phase regardless of when each shade started.
    // (A Date.now()-based animation-delay drifts because the animation actually
    // starts on the next paint frame, not the JS tick — badly under throttling.)
    const flashToggle = (el, cls, on) => {
      if (!el) return;
      const has = el.classList.contains(cls);
      if (on && !has) {
        el.classList.add(cls);
        for (const a of el.getAnimations()) {
          if (a.animationName && a.animationName.indexOf("sd-") === 0) {
            try { a.startTime = 0; } catch (_e) { /* pre-WAAPI fallback: no sync */ }
          }
        }
      } else if (!on && has) {
        el.classList.remove(cls);
      }
    };

    // per-shade: fabric, label, offline, ring, in-motion flash
    for (const slot of Object.keys(this._layout.shades)) {
      const st = this._stateObj(slot);
      const unavailable = !st || st.state === "unavailable";
      const moving = !unavailable && this._isMoving(slot);
      const win = root.querySelector(`[data-slot="${slot}"]`);
      const off = root.querySelector(`[data-offline="${slot}"]`);
      const fl = root.querySelector(`[data-flash="${slot}"]`);
      const lab = root.querySelector(`[data-label="${slot}"]`);
      const selected = this._selected === slot;
      const flashRing = win ? win.querySelectorAll("[data-flash-ring]") : []; // angled: SVG motion ring
      if (win) {
        const rings = win.querySelectorAll("[data-ring]"); // angled windows draw the selection ring in SVG
        if (rings.length) {
          win.style.boxShadow = "none";
          rings.forEach((p) => (p.style.display = selected ? "" : "none"));
        } else {
          win.style.boxShadow = selected ? RING : "none";
        }
        // Motion outline: angled -> pulse the SVG trapezoid ring; rect/door -> CSS outline.
        if (flashRing.length) {
          flashRing.forEach((p) => flashToggle(p, "sd-flash-ring-on", moving));
        } else {
          flashToggle(win, "sd-moving", moving);
        }
      }
      flashToggle(fl, "sd-flash-on", moving);
      if (off) off.style.display = unavailable ? "flex" : "none";
      if (win) win.style.borderColor = unavailable ? "#B5AC9D" : "#1F1B17";
      // Render the display position (commanded target while moving) unless the
      // user is actively dragging this slot's slider.
      if (!unavailable && !this._dragging) this._setFabric(slot, this._dispPos(slot));
      if (lab) {
        flashToggle(lab, "sd-moving-label", moving); // accent-tint the % while in motion
        if (unavailable) {
          lab.textContent = "—";
          lab.style.color = "#B0563C";
        } else {
          // Open/Closed at the extremes, closed % in between; target while moving.
          lab.textContent = this._posLabel(100 - this._dispPos(slot));
          if (!moving) lab.style.color = "#6E6558";
        }
      }
    }

    // tabs
    root.querySelectorAll("[data-tab]").forEach((el) => {
      const active = el.getAttribute("data-tab") === this._tab;
      el.style.background = active ? "#26211B" : "#FFFDF9";
      el.style.color = active ? "#F5F1EA" : "#4A4237";
    });
    // Show the panel matching the active tab (works for both tablet + mobile layouts).
    root.querySelectorAll("[data-panel]").forEach((p) => {
      p.style.display = p.getAttribute("data-panel") === this._tab ? "flex" : "none";
    });

    // scenes highlight
    root.querySelectorAll("[data-scene]").forEach((el) => {
      el.style.background = this._lastScene === el.getAttribute("data-scene") ? SCENE_ACTIVE_BG : "#FFFDF9";
    });

    // toggle states (movie mode, auto shades)
    for (const key of Object.keys(this._layout.toggles || {})) {
      const t = this._layout.toggles[key];
      const sw = root.querySelector(`[data-toggle-switch="${key}"]`);
      if (!sw) continue;
      const st = this._hass.states[t.entity];
      const on = st && st.state === "on";
      sw.style.background = on ? ACCENT : "#D9D2C4";
      root.querySelector(`[data-toggle-knob="${key}"]`).style.left = on ? "19px" : "2px";
      const desc = root.querySelector(`[data-toggle-desc="${key}"]`);
      if (desc) desc.textContent = on ? t.desc_on : t.desc_off;
    }

    // summary
    const slots = Object.keys(this._layout.shades);
    let open = 0, avail = 0, offlineN = 0;
    for (const slot of slots) {
      const st = this._stateObj(slot);
      if (!st || st.state === "unavailable") { offlineN++; continue; }
      avail++;
      if (this._dispPos(slot) > 0) open++;
    }
    const sEl = root.querySelector("[data-summary]");
    if (sEl) sEl.textContent = `${open} of ${avail} shades open${offlineN ? ` · ${offlineN} offline` : ""}`;

    // While any shade is calibrating, disable bulk buttons (a scene would move
    // the calibrating shade, which we can't exclude from a gateway scene).
    const anyCal = this._anyCalibrating();
    root.querySelectorAll("[data-group],[data-scene]").forEach((el) => {
      el.style.pointerEvents = anyCal ? "none" : "";
      el.style.opacity = anyCal ? "0.45" : "";
      el.title = anyCal ? "A shade is calibrating — bulk controls are paused" : "";
    });

    this._updateSun();
    this._updateBar();
  }

  _num(entity) {
    const st = entity && this._hass.states[entity];
    if (!st) return null;
    const n = Number(st.state);
    return Number.isFinite(n) ? n : null;
  }
  // Read a sun value from the configured (sun2) sensor, falling back to the
  // core sun.sun attribute so the widget works with or without sun2 enabled.
  _sunVal(entity, attr) {
    const v = this._num(entity);
    if (v != null) return v;
    const sun = this._hass.states["sun.sun"];
    if (sun && sun.attributes[attr] != null) {
      const n = Number(sun.attributes[attr]);
      return Number.isFinite(n) ? n : null;
    }
    return null;
  }
  // Format a sun2 timestamp sensor (ISO datetime) as a short local time, e.g. "8:11 PM".
  _sunTimeStr(entity) {
    const ms = this._sunTime(entity);
    return ms == null ? null : new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  }
  // Parse a sun2 timestamp sensor to epoch milliseconds (or null).
  _sunTime(entity) {
    const st = entity && this._hass.states[entity];
    if (!st) return null;
    const ms = Date.parse(st.state);
    return Number.isFinite(ms) ? ms : null;
  }
  // Shared sun tracker widget — used by both the desktop sidebar and the mobile
  // home panel. Sunrise/sunset come from sun2; the dot/day-night from sun2 elevation+azimuth.
  _sunCardHtml() {
    return `
    <div data-sun-card style="display:flex;flex-direction:column;gap:6px;padding:12px;border:1px solid #E2DACB;border-radius:12px;background:#FBF8F2">
      <div style="position:relative;width:150px;height:66px;overflow:hidden;margin:0 auto">
        <div style="position:absolute;left:8px;top:8px;width:134px;height:134px;border-radius:50%;border:1.5px dashed #CDC3B2"></div>
        <div style="position:absolute;left:0;right:0;bottom:0;height:2px;background:#CDC3B2"></div>
        <div data-sun-dot style="position:absolute;width:12px;height:12px;border-radius:50%;background:${ACCENT};opacity:0;left:69px;top:0;box-shadow:0 0 10px 2px rgba(198,123,59,.45)"></div>
      </div>
      <div style="display:flex;justify-content:space-between;align-items:center;font-size:11px;color:#8A8177">
        <span title="Sunrise (sun2)">↑&nbsp;<span data-sun-rise style="color:#26211B;font-weight:600">—</span></span>
        <span data-sun-time style="color:#26211B;font-weight:600"></span>
        <span title="Sunset (sun2)"><span data-sun-set style="color:#26211B;font-weight:600">—</span>&nbsp;↓</span>
      </div>
      <div data-sun-label style="text-align:center;font-size:11px;color:#8A8177"></div>
    </div>`;
  }

  _updateSun() {
    const root = this.shadowRoot;
    const cfg = this._layout.sun || {};
    const elev = this._sunVal(cfg.elevation_entity, "elevation");
    const az = this._sunVal(cfg.azimuth_entity, "azimuth");
    const dot = root.querySelector("[data-sun-dot]");
    const timeEl = root.querySelector("[data-sun-time]");
    const labelEl = root.querySelector("[data-sun-label]");
    const riseEl = root.querySelector("[data-sun-rise]");
    const setEl = root.querySelector("[data-sun-set]");
    if (timeEl) timeEl.textContent = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    const rise = this._sunTimeStr(cfg.rising_entity);
    const set = this._sunTimeStr(cfg.setting_entity);
    if (riseEl && rise) riseEl.textContent = rise;
    if (setEl && set) setEl.textContent = set;

    // Place the sun by fraction of daylight elapsed (sun2 sunrise -> sunset) so it
    // rides the visible arc all the way to the west horizon at sunset. A raw-azimuth
    // mapping puts the low evening/morning sun on the horizon corners, which fall
    // below the 66px arc window and clip the dot out of view entirely.
    const sunriseMs = this._sunTime(cfg.rising_entity);
    const sunsetMs = this._sunTime(cfg.setting_entity);
    let frac = null;
    if (sunriseMs != null && sunsetMs != null && sunsetMs > sunriseMs) {
      frac = (Date.now() - sunriseMs) / (sunsetMs - sunriseMs);
    }
    // Fall back to elevation when sun2 isn't available.
    const night = frac != null ? frac <= 0 || frac >= 1 : elev == null || elev < 0;
    if (dot) {
      if (night || frac == null) {
        dot.style.opacity = "0";
      } else {
        // Arc: center (75,75) r67; g0 is where it meets the horizon inside the window.
        const g0 = 0.1345;
        const g = g0 + Math.min(1, Math.max(0, frac)) * (Math.PI - 2 * g0);
        const x = 75 - 67 * Math.cos(g);
        const y = 75 - 67 * Math.sin(g);
        dot.style.left = `${x - 6}px`;
        dot.style.top = `${y - 6}px`;
        dot.style.opacity = "1";
      }
    }
    if (labelEl) {
      const westLux = cfg.west_lux ? this._num(cfg.west_lux) : null;
      let text;
      if (night) text = "Night · sun below horizon";
      else if (az != null && az < 135) text = "Morning · sun in the east";
      else if (az != null && az > 225) text = westLux != null && westLux > 30 ? "Evening · glare on west wall" : "Evening · sun in the west";
      else text = "Midday · sun high south";
      labelEl.textContent = text;
    }
    // Sun tab + the live sun dot over the wall drawings ride the same tick.
    this._updateSunSim();
    this._updateSunOverlays(az, elev);
  }

  _updateBar() {
    const root = this.shadowRoot;
    const bar = root.querySelector("[data-bar]");
    if (!bar) return;
    if (!this._selected || this._tab === "settings") { bar.style.display = "none"; return; }
    bar.style.display = "flex";
    const slot = this._selected;
    const st = this._stateObj(slot);
    const meta = SLOT_META[slot] || {};
    const name = st && st.attributes.friendly_name ? st.attributes.friendly_name : this._entity(slot);
    root.querySelector("[data-bar-name]").textContent = name;
    const unavailable = !st || st.state === "unavailable";
    const moving = !unavailable && this._isMoving(slot);
    const dirWord =
      st && st.state === "opening" ? "Opening…"
      : st && st.state === "closing" ? "Closing…"
      : "Moving…"; // just tapped, before the cover reports a direction
    const calibrating = !unavailable && this._calibrating(slot);
    root.querySelector("[data-bar-sub]").textContent = calibrating ? "Calibrating… controls locked" : moving ? dirWord : meta.sub || "";
    root.querySelector("[data-bar-ctl]").style.display = unavailable ? "none" : "flex";
    root.querySelector("[data-bar-unavail]").style.display = unavailable ? "block" : "none";
    const pctEl = root.querySelector("[data-bar-pct]");
    pctEl.classList.toggle("sd-moving-label", moving || calibrating);
    if (!unavailable && !this._dragging) {
      const closed = 100 - this._dispPos(slot); // slider + readout are closed % (target while moving)
      root.querySelector("[data-bar-slider]").value = String(closed);
      pctEl.textContent = this._posLabel(closed);
    }
    // While calibrating, lock out the shade's own controls (slider + open/close).
    const slider = root.querySelector("[data-bar-slider]");
    slider.disabled = calibrating;
    ["open", "close"].forEach((a) => {
      const b = root.querySelector(`[data-bar-action="${a}"]`);
      b.disabled = calibrating;
      b.style.opacity = calibrating ? "0.4" : "";
      b.style.pointerEvents = calibrating ? "none" : "";
    });
    // Recalibrate button: only for gateway-tracked shades (the RYSE main-bedroom
    // shade has no recalibrate). Two-tap confirm; hidden while already calibrating.
    const recalBtn = root.querySelector("[data-bar-recal]");
    const canRecal = !unavailable && !calibrating && (this._layout.recal_slots || []).includes(slot);
    recalBtn.style.display = canRecal ? "" : "none";
    if (canRecal) {
      const armed = this._recalArmed === slot;
      recalBtn.textContent = armed ? "Tap to confirm" : "Recalibrate";
      recalBtn.style.color = armed ? "#FFF" : "#B8AF9F";
      recalBtn.style.background = armed ? "#8A3B1E" : "transparent";
      recalBtn.style.borderColor = armed ? "#8A3B1E" : "rgba(255,255,255,.25)";
    }
  }

  // Whether a shade is locked mid-calibration (from the cover's attribute).
  _calibrating(slot) {
    const st = this._stateObj(slot);
    return !!(st && st.attributes && st.attributes.calibrating);
  }
  _anyCalibrating() {
    return Object.keys(this._layout.shades).some((s) => this._calibrating(s));
  }
}

// Browser-only registration (skipped when imported by the Node solar test).
if (typeof customElements !== "undefined") {
  customElements.define("shade-dashboard-card", ShadeDashboardCard);

  window.customCards = window.customCards || [];
  window.customCards.push({
    type: "shade-dashboard-card",
    name: "Shade Dashboard",
    description: "Spatial PowerView shade control dashboard",
    preview: false,
  });

  // eslint-disable-next-line no-console
  console.info("%c SHADE-DASHBOARD-CARD %c loaded ", "background:#26211B;color:#F5F1EA;border-radius:3px 0 0 3px;padding:2px 4px", "background:#C67B3B;color:#fff;border-radius:0 3px 3px 0;padding:2px 4px");
}
