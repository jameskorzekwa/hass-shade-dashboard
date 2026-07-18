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
  // Physics for the window sunlight (mirror of const.py SUN_GEO). Wall azimuths
  // are the walls' true-north outward normals; viewer params are the eye point
  // the projection renders from (feet). Strict JSON — test_layout_sync parses it.
  sun_geo: {
    "lat": 39.582804,
    "lon": -105.249572,
    "walls": {
      "west": {"az": 295.0, "viewer_x": 8.34, "viewer_d": 18.0, "eye_h": 5.4},
      "south": {"az": 201.0, "viewer_x": 9.5, "viewer_d": 14.0, "eye_h": 5.4},
      "north": {"az": 25.0, "viewer_x": 4.75, "viewer_d": 12.0, "eye_h": 5.4},
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
const fabric = (slot, hem, glow) =>
  `<div data-fabric="${slot}" style="position:absolute;top:0;left:0;right:0;height:0;background:${FABRIC};border-bottom:${hem}px solid ${HEM};transition:height .45s ease">` +
    (glow ? `<div data-sunglow="${slot}" style="position:absolute;inset:0;pointer-events:none"></div>` : "") +
  `</div>`;
const offline = (slot) =>
  `<div data-offline="${slot}" style="display:none;position:absolute;inset:0;align-items:center;justify-content:center;background:${HATCH}"><span style="writing-mode:vertical-rl;font:700 10px ui-monospace,Menlo,monospace;letter-spacing:2px;color:#A2988A">OFFLINE</span></div>`;
const flash = (slot, clip) =>
  `<div data-flash="${slot}" class="sd-flash-ov" style="${clip ? `clip-path:url(#sd-clip-${slot})` : "border-radius:3px"}"></div>`;
const sunUnder = (slot) => `<div data-sunlit="${slot}" style="position:absolute;inset:0;pointer-events:none"></div>`;
const skyClouds = (slot) => `<div data-clouds="${slot}" style="position:absolute;inset:0;pointer-events:none"></div>`;
// Linear mix of two #RRGGBB colors (t: 0 -> a, 1 -> b), for the sky tint.
// Returns #RRGGBB so mixes can be chained (rgb() output broke the 2nd parse).
const hexMix = (a, b, t) => {
  const pa = parseInt(a.slice(1), 16), pb = parseInt(b.slice(1), 16);
  const ch = (sh) => Math.round(((pa >> sh) & 255) + (((pb >> sh) & 255) - ((pa >> sh) & 255)) * t);
  return `#${((1 << 24) + (ch(16) << 16) + (ch(8) << 8) + ch(0)).toString(16).slice(1)}`;
};
const rgba = (hex, alpha) => {
  const p = parseInt(hex.slice(1), 16);
  return `rgba(${(p >> 16) & 255},${(p >> 8) & 255},${p & 255},${alpha.toFixed(3)})`;
};

// The clear sky and cloud undersides change at different rates after sunset:
// blue hour takes over the open sky quickly, while high clouds keep catching
// orange light from below for several more degrees of solar descent.
export function skyPalette(el) {
  const sm = (x, a, b) => Math.min(1, Math.max(0, (x - a) / (b - a)));
  const elv = el == null ? 30 : el;
  const twilight = Math.pow(1 - sm(elv, -5.2, -0.2), 0.72);
  const horizonGlow = Math.exp(-Math.pow(elv - 0.8, 2) / 18);
  const skyWarm = horizonGlow * Math.pow(1 - twilight, 2.2);
  const cloudWarm = Math.exp(-Math.pow(elv - 0.3, 2) / 30);
  const cloudAlpha = (0.1 + 0.62 * cloudWarm) * sm(elv, -8, -4.5);

  let uTop = hexMix("#CBD6DC", "#17243E", twilight), uBot = hexMix("#E2E2D6", "#293B59", twilight);
  let lTop = hexMix("#D8DFE2", "#1B2944", twilight), lMid = hexMix("#E9E6DB", "#30425F", twilight);
  let lBot = hexMix("#A8B29B", "#24344A", twilight);
  uTop = hexMix(uTop, "#D9AF9B", skyWarm * 0.28); uBot = hexMix(uBot, "#F2BE7F", skyWarm * 0.72);
  lTop = hexMix(lTop, "#D9AF9B", skyWarm * 0.32); lMid = hexMix(lMid, "#F2BE7F", skyWarm * 0.76);
  lBot = hexMix(lBot, "#C9A176", skyWarm * 0.42);

  const cloudRim = hexMix(hexMix("#F3EEE5", "#71809A", twilight), "#FFD080", Math.min(1, cloudWarm * 1.05));
  const cloudBright = hexMix(hexMix("#DDE2E2", "#53627E", twilight), "#FF9E52", Math.min(1, cloudWarm * 1.12));
  const cloudShade = hexMix(hexMix("#AEB8BD", "#34435F", twilight), "#D95D38", cloudWarm * 0.88);
  const clouds = [
    `radial-gradient(ellipse 82% 12% at 22% 68%,${rgba(cloudRim, cloudAlpha)} 0%,${rgba(cloudBright, cloudAlpha * 0.9)} 42%,${rgba(cloudShade, cloudAlpha * 0.58)} 63%,transparent 78%)`,
    `radial-gradient(ellipse 74% 10% at 78% 48%,${rgba(cloudBright, cloudAlpha * 0.82)} 0%,${rgba(cloudShade, cloudAlpha * 0.52)} 58%,transparent 76%)`,
    `radial-gradient(ellipse 52% 7% at 34% 31%,${rgba(cloudRim, cloudAlpha * 0.58)} 0%,${rgba(cloudBright, cloudAlpha * 0.4)} 56%,transparent 78%)`,
  ].join(",");
  return { uTop, uBot, lTop, lMid, lBot, twilight, skyWarm, cloudWarm, cloudAlpha, clouds };
}
const winRect = (slot, glass) =>
  `<div data-slot="${slot}" title="${slot}" style="position:relative;width:84px;height:190px;border:3px solid #1F1B17;border-radius:3px;background:${glass};overflow:hidden;cursor:pointer">${skyClouds(slot)}${sunUnder(slot)}${fabric(slot, 4, true)}${flash(slot)}${offline(slot)}</div>`;
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
    skyClouds(slot) +
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
  /* Every button gives hover + press feedback: brightness composes over any
     inline background (light or dark), and the tiny press-scale reads as a
     physical click. Touch devices get the :active state on tap. */
  button { transition: filter .12s ease, transform .06s ease; }
  button:hover { filter: brightness(.94); }
  button:active { filter: brightness(.85); transform: scale(.97); }
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

// Real glass rectangles per shade, in wall feet (x across the run, z above that
// storey's floor) — this drives the per-window sunlight. West bays sit on a
// 4.75 ft pitch: lower glass 0.3-8 ft, angled clerestories following the
// roofline (z = 18.4 - 0.408x; the angled panes use their bounding box, plenty
// for a light gradient). South mirrors the drawn layout (door + chimney bays
// carry no shade). North is the west wall's +90 (az 25). Upstairs is the same
// west face one storey up, in its own floor-relative z. lrh1/mbr1 have no
// known orientation and stay unlit.
const SIM_BAYS = [[0.3, 4.45], [5.05, 9.2], [9.8, 13.95], [14.55, 18.7]];
const SLOT_GLASS = (() => {
  const roof = (x) => 18.4 - 0.408 * x;
  const out = {};
  ["u4", "u5", "u6", "u7"].forEach((s, i) => { const [a, b] = SIM_BAYS[i]; out[s] = { wall: "west", x1: a, x2: b, z1: 9, z2: roof(a) }; });
  ["l3", "l4", "l5", "l6"].forEach((s, i) => { const [a, b] = SIM_BAYS[i]; out[s] = { wall: "west", x1: a, x2: b, z1: 0.3, z2: 8 }; });
  out.u1 = { wall: "south", x1: SIM_BAYS[0][0], x2: SIM_BAYS[0][1], z1: 9, z2: 18.4 };
  out.u2 = { wall: "south", x1: SIM_BAYS[1][0], x2: SIM_BAYS[1][1], z1: 9, z2: 18.4 };
  out.u3 = { wall: "south", x1: SIM_BAYS[3][0], x2: SIM_BAYS[3][1], z1: 9, z2: 18.4 };
  out.l1 = { wall: "south", x1: SIM_BAYS[1][0], x2: SIM_BAYS[1][1], z1: 0.3, z2: 8 };
  out.l2 = { wall: "south", x1: SIM_BAYS[3][0], x2: SIM_BAYS[3][1], z1: 0.3, z2: 8 };
  out.l7 = { wall: "north", x1: 0.3, x2: 4.45, z1: 0.3, z2: 8 };
  out.l8 = { wall: "north", x1: 5.05, x2: 9.2, z1: 0.3, z2: 8 };
  [["uh1", 0.25], ["uh2", 3.45], ["uh3", 6.65], ["ko1", 10.45], ["ko2", 13.65]].forEach(([s, x]) => {
    out[s] = { wall: "up_west", x1: x, x2: x + 2.7, z1: 2, z2: 7 };
  });
  return out;
})();
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
        skyClouds(slot) +
        sunUnder(slot) +
        `<div data-fabric="${slot}" style="position:absolute;top:0;left:0;right:0;height:0;background:${FABRIC};border-bottom:4px solid ${HEM};transition:height .45s ease">` +
          `<div data-sunglow="${slot}" style="position:absolute;inset:0;pointer-events:none"></div>` +
        `</div>` +
      `</div>` +
      flash(slot, true) +
    `</div>`
  );
};
const angledCol = (slot, h) =>
  `<div style="display:flex;flex-direction:column;align-items:center;gap:6px">${winAngled(slot, h)}${label(slot)}</div>`;
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
    this._pendingTarget = {}; // entity -> {t, ts}: commanded target (untracked bridge)
    // Hidden sun-test mode (Settings): overrides the sun2 angles with
    // computed positions for a scrubbable time of day. Off = live sensors.
    // speed = simulated minutes per real second while playing.
    this._sunTest = { on: false, playing: false, season: "today", min: null, speed: 96 };
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
    // The RYSE (untracked) shade: bridge the tap -> optimistic-state round
    // trip. The unified cover reports the commanded TARGET while the device
    // travels, but for the first beat after a tap the hass state still holds
    // the stale pre-move position — without this hold the fabric moves, snaps
    // back, then jumps. Cleared the moment the cover reports (about) the
    // target; an 8s valve covers a lost command.
    if (!(this._layout.recal_slots || []).includes(slot)) {
      const e = this._entity(slot);
      const pend = this._pendingTarget[e];
      if (pend) {
        const pos = this._pos(slot);
        if (Date.now() - pend.ts > 8000 || (pos != null && Math.abs(pos - pend.t) <= 2)) {
          delete this._pendingTarget[e];
        } else {
          return pend.t;
        }
      }
    }
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
  // takes over within a beat). When the commanded target is known, remember
  // it so _dispPos can hold untracked shades on it during the round-trip.
  _mark(entity, target) {
    if (!entity) return;
    this._commanded[entity] = Date.now();
    if (target != null) this._pendingTarget[entity] = { t: target, ts: Date.now() };
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
    // Keep _tab valid for the layout being built (panels differ per layout).
    if (mobile && this._tab !== "settings") this._tab = "home";
    if (!mobile && this._tab === "home") this._tab = "main";
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
    const sunTest = this._builtMobile ? "" : `<div style="border:1px solid #E2DACB;border-radius:12px;background:#FBF8F2;padding:12px 14px;display:flex;align-items:center;gap:12px">
      <div style="flex:1"><div style="font-weight:700;font-size:13.5px;color:#26211B">Sun test</div><div style="font-size:11px;color:#8A8177">Shows a time-of-day scrubber on the main views to preview the window light</div></div>
      <button data-suntest-on style="padding:8px 16px;border-radius:9px;border:1px solid #E2DACB;background:#FFFDF9;color:#26211B;font-weight:600;font-size:12px;cursor:pointer">Off</button>
    </div>`;
    return sunTest + `<div style="font-size:12px;color:#8A8177;padding:0 2px 4px">Each button moves its shades in one synchronized gateway call — no scenes involved.</div>` +
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

  // --- Sunlight through the windows -------------------------------------------
  // The sun is not a separate view: every window carries two light layers (one
  // under the shade fabric, one — much dimmer — above it) whose radial gradient
  // is positioned at the sun's true location in THAT window's own glass
  // coordinates (real feet -> local %). Because the mapping is per-window, the
  // effect is identical in every layout, including the phone's wrapped grids.
  // Brightness falls off with the sun's distance from each pane and fades out
  // as the sun drops to the WNW ridge. Physics: solarPos + sunOnWall, config
  // in const.SUN_GEO (calibrated from the 2026-07-14 19:58 photo).
  _geoWalls() {
    return (this._layout.sun_geo && this._layout.sun_geo.walls) || {};
  }
  _geoLatLon() {
    const g = this._layout.sun_geo || {};
    return [g.lat, g.lon];
  }
  // WNW ridge height: the sun's elevation at the sun2 (terrain-corrected)
  // sunset instant — i.e. how high the mountains it sets behind are. The same
  // angular threshold applies on both storeys (the ridge is distant, so one
  // floor of height changes its apparent elevation by well under 0.1 deg).
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
    const md = MONTH[(this._sunTest || {}).season];
    const base = md ? new Date(now.getFullYear(), md[0], md[1]) : new Date(now.getFullYear(), now.getMonth(), now.getDate());
    base.setMinutes(minutes);
    return base;
  }
  _fmtMin(min) {
    const h = Math.floor(min / 60) % 24, m = Math.round(min % 60);
    const hh = ((h + 11) % 12) + 1;
    return `${hh}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
  }
  // Current sun angles: the sun2 sensors normally; the hidden test mode
  // (Settings -> Sun test) overrides them with computed positions so the
  // light can be scrubbed through any day.
  _sunAzEl() {
    const t = this._sunTest;
    if (t && t.on) {
      const [lat, lon] = this._geoLatLon();
      if (lat != null) {
        const d = this._simDate(Math.min(1290, Math.max(270, t.min == null ? 720 : t.min)));
        const p = solarPos(d.getTime(), lat, lon);
        return { az: p.az, el: p.el, test: true };
      }
    }
    const cfg = this._layout.sun || {};
    return {
      az: this._sunVal(cfg.azimuth_entity, "azimuth"),
      el: this._sunVal(cfg.elevation_entity, "elevation"),
      test: false,
    };
  }
  _updateSunLight(az, el) {
    const root = this.shadowRoot;
    if (!root) return;
    const walls = this._geoWalls();
    const ridge = this._ridgeEl();
    // Below the WNW ridge late in the day (or below the horizon any time):
    // lights out, with a soft fade over the last ~1.5 deg of descent.
    const gate = az != null && az > 240 ? ridge - 0.2 : -0.3;
    const dayFade = az == null || el == null ? 0 : Math.min(1, Math.max(0, (el - gate) / 1.5));
    // Ambient golden-hour glow: at sunrise/sunset EVERY covered shade leaks a
    // little warm light around its edges (the whole sky is lit), on top of the
    // stronger direct leak on panes the sun is actually near. Same horizon
    // bell as the sky tint, gated by daylight/ridge like the direct light.
    const ambient = 0.55 * Math.exp(-Math.pow((el == null ? 90 : el) - 1, 2) / 16) * dayFade;
    // Diffuse daylight: the sky lights every facade all day, so a fully
    // closed shade still glows through its weave and leaks at the edges
    // even when the sun is nowhere near that pane (fades out after dusk).
    const elv = el == null ? 30 : el;
    const daylight = Math.min(1, Math.max(0, (elv + 6) / 14)); // dark below -6, full by ~8 deg
    const dayGlow = 0.34 * daylight;
    // Light color temperature: amber near the horizon (sunrise/dusk), bright
    // white through the day. One blend per tick, shared by all the layers.
    const warmth = Math.exp(-Math.pow(elv - 1, 2) / 20);
    const wmix = (w, a) => w.map((c, i) => Math.round(c + (a[i] - c) * warmth)).join(",");
    const LC = {
      uCore: wmix([255, 253, 248], [255, 238, 196]),
      uIn: wmix([255, 249, 238], [255, 219, 150]),
      uMid: wmix([255, 243, 228], [255, 199, 124]),
      uOut: wmix([255, 240, 222], [255, 186, 108]),
      eCore: wmix([255, 253, 247], [255, 240, 200]),
      eMid: wmix([255, 251, 243], [255, 233, 186]),
      eOut: wmix([255, 248, 238], [255, 227, 176]),
      wCore: wmix([255, 251, 243], [255, 235, 185]),
      wMid: wmix([255, 246, 232], [255, 214, 150]),
      aTop: wmix([255, 252, 245], [255, 238, 200]),
      aBot: wmix([255, 250, 241], [255, 233, 192]),
    };
    // Admitted-light bookkeeping for the interior-brightness simulation:
    // every pane contributes (glass area) x (how open it is) x (light on it).
    let sumArea = 0, sumOpen = 0, sumBeam = 0;
    for (const slot of Object.keys(this._layout.shades)) {
      const under = root.querySelector(`[data-sunlit="${slot}"]`);
      const over = root.querySelector(`[data-sunglow="${slot}"]`);
      if (!under && !over) continue;
      const host = (under || over).parentElement;
      const w = host ? host.clientWidth || 0 : 0;
      let css = "none", cssOver = "none";
      const g = SLOT_GLASS[slot]; // panes without known orientation still get ambient
      const wall = g ? walls[g.wall] : null;
      const p = wall && dayFade > 0 && w ? sunOnWall(wall, az, el) : { behind: true };
      let I = 0, cx = 50, cy = 50, pxFt = w / 4.15;
      if (!p.behind) {
        // Distance from the sun to the nearest point of this pane (0 = on it).
        const nx = Math.min(g.x2, Math.max(g.x1, p.x));
        const nz = Math.min(g.z2, Math.max(g.z1, p.z));
        const dist = Math.hypot(p.x - nx, p.z - nz);
        I = Math.max(0, 1 - dist / 7) ** 1.15 * dayFade;
        cx = ((p.x - g.x1) / (g.x2 - g.x1)) * 100;
        cy = ((g.z2 - p.z) / (g.z2 - g.z1)) * 100;
        pxFt = w / (g.x2 - g.x1);
      }
      if (g) {
        const area = (g.x2 - g.x1) * (g.z2 - g.z1);
        const posNow = this._dispPos(slot);
        const openFrac = posNow == null ? 0 : posNow / 100;
        const admit = openFrac + (1 - openFrac) * 0.15; // weave passes ~15%
        sumArea += area;
        sumOpen += area * admit;
        sumBeam += area * admit * I;
      }
      const R = 8 * pxFt, core = 1.2 * pxFt;
      if (I > 0.02 && w) {
        css =
          `radial-gradient(circle ${R.toFixed(0)}px at ${cx.toFixed(1)}% ${cy.toFixed(1)}%,` +
          `rgba(${LC.uCore},${(0.95 * I).toFixed(3)}) 0,` +
          `rgba(${LC.uIn},${(0.85 * I).toFixed(3)}) ${core.toFixed(0)}px,` +
          `rgba(${LC.uMid},${(0.5 * I).toFixed(3)}) ${(R * 0.38).toFixed(0)}px,` +
          `rgba(${LC.uOut},0) ${R.toFixed(0)}px)`;
      }
      // Light leaking around the shade: bright slivers down the frame sides
      // (near-sun side hardest), a seep line above the hem, a whisper at the
      // top gap, and a wash through the weave. Direct-sun leak, floored by
      // the ambient golden-hour leak. The glow layer is a child of the
      // fabric, so it exactly covers the shaded region at any position.
      const G = Math.max(I, w ? Math.max(ambient, dayGlow) : 0);
      if (over && G > 0.02) {
        const pos = this._dispPos(slot);
        const covered = pos == null ? 1 : (100 - pos) / 100;
        if (covered > 0.02) {
          const direct = I > 0.02 && I >= ambient;
          const tL = direct ? Math.max(0, 1 - Math.abs(p.x - g.x1) / 5) : 0.5;
          const tR = direct ? Math.max(0, 1 - Math.abs(p.x - g.x2) / 5) : 0.5;
          const aL = Math.min(1, 1.6 * G * (0.35 + 0.9 * tL));
          const aR = Math.min(1, 1.6 * G * (0.35 + 0.9 * tR));
          const edge = (deg, a) =>
            `linear-gradient(${deg}deg,rgba(${LC.eCore},${a.toFixed(3)}) 0,rgba(${LC.eMid},${(a * 0.65).toFixed(3)}) 5px,rgba(${LC.eOut},${(a * 0.3).toFixed(3)}) 13px,rgba(${LC.eOut},0) 26px)`;
          const wash = direct
            ? `radial-gradient(circle ${R.toFixed(0)}px at ${cx.toFixed(1)}% ${(cy / Math.max(covered, 0.05)).toFixed(1)}%,` +
              `rgba(${LC.wCore},${(0.3 * G).toFixed(3)}) 0,` +
              `rgba(${LC.wMid},${(0.22 * G).toFixed(3)}) ${(R * 0.4).toFixed(0)}px,` +
              `rgba(${LC.uMid},0) ${R.toFixed(0)}px)`
            : `linear-gradient(180deg,rgba(${LC.aTop},${(0.55 * G).toFixed(3)}) 0,rgba(${LC.aBot},${(0.4 * G).toFixed(3)}) 100%)`;
          cssOver = [edge(0, Math.min(1, 0.95 * G)), edge(90, aL), edge(270, aR), edge(180, 0.45 * G), wash].join(",");
        }
      }
      if (under) under.style.background = css;
      if (over) over.style.background = cssOver;
    }
    // Interior brightness (exposure adaptation): the more daylight pours in,
    // the darker the room surfaces read; close shades (or let the sun set)
    // and the inside brightens — brightest at night. Diffuse skylight enters
    // any open pane; the direct-beam term weighs panes the sun is actually
    // hitting. Positions are live, so the room shifts as shades travel.
    const diffuseIn = sumArea ? sumOpen / sumArea : 0;
    const directIn = sumArea ? Math.min(1, sumBeam / (sumArea * 0.12)) : 0;
    const shadesTerm = Math.min(1, 1.3 * (0.6 * diffuseIn + 0.4 * directIn));
    // Daytime alone pulls the room down (bright outside = inside reads dark);
    // how far depends on how much the shades let through.
    this._setInterior(daylight * (0.35 + 0.65 * shadesTerm));
  }
  // Tint the room chrome between cozy-bright (night, nothing coming in) and
  // properly dark (bright day pouring through open glass). Instantaneous —
  // scrubbing the sun test from noon to night must snap.
  _setInterior(light) {
    const frame = this.shadowRoot && this.shadowRoot.querySelector(".frame");
    if (!frame || this._builtMobile) return;
    frame.style.transition = "none"; // deployed cards may carry an old inline fade
    frame.style.background = hexMix("#FFFDF6", "#A3937A", Math.min(1, light));
  }
  // Sky outside the windows: the glass gradients tint continuously with the
  // sun — deep blue-grey night, warm dawn/dusk horizon color on EVERY pane
  // (the whole sky takes on sunrise/sunset tones, regardless of which way a
  // wall faces — per the user), and the normal bright glass by day. Desktop
  // only (the phone layout keeps its static tiles). Live updates step
  // minute-by-minute, so the change reads as a slow drift; in test-play it
  // animates smoothly.
  _updateSky(az, el) {
    const root = this.shadowRoot;
    if (!root || this._builtMobile) return;
    const p = skyPalette(el);
    const sky = {
      upper: `linear-gradient(180deg,${p.uTop} 0%,${p.uBot} 100%)`,
      lower: `linear-gradient(180deg,${p.lTop} 0%,${p.lMid} 55%,${p.lBot} 100%)`,
      uTop: p.uTop, uBot: p.uBot,
    };
    // The front door's little window follows the same sky.
    const doorGlass = root.querySelector("[data-doorglass]");
    if (doorGlass) {
      const dTop = hexMix(p.uTop, "#1C2941", 0.18), dBot = hexMix(p.uBot, "#26364E", 0.15);
      doorGlass.style.background = `${p.clouds},linear-gradient(180deg,${dTop},${dBot})`;
    }
    for (const slot of Object.keys(this._layout.shades)) {
      const win = root.querySelector(`[data-slot="${slot}"]`);
      if (!win) continue;
      const clouds = win.querySelector(`[data-clouds="${slot}"]`);
      if (clouds) clouds.style.background = p.clouds;
      const stops = win.querySelectorAll(`#sd-g-${slot} stop`); // angled clerestories (SVG)
      if (stops.length === 2) {
        stops[0].setAttribute("stop-color", sky.uTop);
        stops[1].setAttribute("stop-color", sky.uBot);
      } else {
        win.style.background = /^u\d/.test(slot) ? sky.upper : sky.lower;
      }
    }
  }
  // Hidden test controls (Settings tab): scrub/play the sun through a day.
  _wireSunTest() {
    const root = this.shadowRoot;
    const scrub = root.querySelector("[data-suntest-scrub]");
    if (!scrub) return;
    const season = root.querySelector("[data-suntest-season]");
    const sync = () => { this._updateSunTestUi(); this._update(); };
    const setOn = (on) => {
      const t = this._sunTest;
      t.on = on;
      t.playing = false;
      if (t.on && t.min == null) { const n = new Date(); t.min = n.getHours() * 60 + n.getMinutes(); }
      sync();
    };
    root.querySelector("[data-suntest-on]").addEventListener("click", () => setOn(!this._sunTest.on));
    const offBtn = root.querySelector("[data-suntest-off]");
    if (offBtn) offBtn.addEventListener("click", () => setOn(false));
    this._sunTestWiredAt = Date.now();
    scrub.addEventListener("input", () => {
      // Chrome form-state restoration fires a trusted input on the slider
      // right after a reload (even with autocomplete=off) — don't let that
      // blip silently ENABLE test mode with a stale time.
      if (!this._sunTest.on && Date.now() - this._sunTestWiredAt < 1500) {
        this._updateSunTestUi();
        return;
      }
      this._sunTest.min = Number(scrub.value);
      this._sunTest.on = true;
      sync();
    });
    season.addEventListener("change", () => { this._sunTest.season = season.value; sync(); });
    const speedSel = root.querySelector("[data-suntest-speed]");
    if (speedSel) speedSel.addEventListener("change", () => { this._sunTest.speed = Number(speedSel.value) || 96; });
    root.querySelector("[data-suntest-play]").addEventListener("click", () => {
      const t = this._sunTest;
      t.playing = !t.playing;
      t.on = true;
      if (t.min == null) t.min = 720;
      if (t.playing) {
        if (t.min >= 1288) t.min = 270; // restart from dawn
        // Time-based stepping keeps the selected speed consistent across
        // displays; cap dt so a throttled background tab cannot jump ahead.
        let last = performance.now();
        const step = (now) => {
          if (!t.playing || !this.isConnected) return;
          const dt = Math.min(0.25, (now - last) / 1000);
          last = now;
          t.min = Math.min(1290, t.min + (t.speed || 96) * dt);
          if (t.min >= 1290) t.playing = false;
          this._updateSunTestUi();
          this._updateSun();
          if (t.playing) requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
      }
      sync();
    });
    this._updateSunTestUi();
  }
  _updateSunTestUi() {
    const root = this.shadowRoot;
    const t = this._sunTest;
    const scrub = root.querySelector("[data-suntest-scrub]");
    if (!scrub) return;
    const bar = root.querySelector("[data-suntest-bar]");
    if (bar) bar.style.display = t.on && this._tab !== "settings" ? "flex" : "none";
    if (t.min != null && !t.scrubbing) scrub.value = String(Math.round(t.min));
    const lab = root.querySelector("[data-suntest-time]");
    if (lab) lab.textContent = t.on ? this._fmtMin(Math.min(1290, Math.max(270, t.min == null ? 720 : t.min))) : "off";
    const tog = root.querySelector("[data-suntest-on]");
    if (tog) {
      tog.textContent = t.on ? "On" : "Off";
      tog.style.background = t.on ? ACCENT : "#FFFDF9";
      tog.style.color = t.on ? "#FFF" : "#26211B";
      tog.style.borderColor = t.on ? ACCENT : "#E2DACB";
    }
    const play = root.querySelector("[data-suntest-play]");
    if (play) play.textContent = t.playing ? "⏸" : "▶";
    const speedSel = root.querySelector("[data-suntest-speed]");
    if (speedSel) speedSel.value = String(t.speed || 96);
  }

  _template() {
    const sc = this._layout.scenes;
    const tg = this._layout.toggles || {};
    // South wall: three columns against the chimney
    const south =
      `<div style="display:flex;flex-direction:column;align-items:center;gap:10px">` +
        `<div style="position:relative;display:flex;align-items:stretch;gap:14px">` +
          // col 1: upper 1 over the front door
          `<div style="display:flex;flex-direction:column;justify-content:space-between;align-items:center;height:470px">` +
            lowerCol("u1", GLASS_UPPER) +
            `<div style="display:flex;flex-direction:column;align-items:center;gap:6px"><div title="Front door (no shade)" style="width:84px;height:190px;border:3px solid #1F1B17;border-radius:3px;background:linear-gradient(180deg,#3A342C 0%,#4A423A 60%,#5A5044 100%);opacity:.75;position:relative"><div data-doorglass style="position:absolute;left:10px;right:10px;top:12px;bottom:44%;background:linear-gradient(180deg,#8FA0A8,#B9BDB0);border-radius:2px"></div></div><span style="font:700 12px ui-monospace,Menlo,monospace;color:#9B9284">DOOR</span></div>` +
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
        `<div style="position:relative;display:flex;align-items:flex-end;gap:14px">${lowerCol("uh1")}${divider()}${lowerCol("uh2")}${lowerCol("uh3")}</div>` +
        chip("upstairs_hallway", "ALL HALLWAY") +
      `</div>`;
    const office =
      `<div style="display:flex;flex-direction:column;align-items:center;gap:14px">` +
        `<span style="font-size:12px;font-weight:700;letter-spacing:1.6px;color:#4A4237">KYLE'S OFFICE</span>` +
        `<div style="position:relative;display:flex;align-items:flex-end;gap:14px">${lowerCol("ko1")}${lowerCol("ko2")}</div>` +
        chip("office", "ALL OFFICE") +
      `</div>`;

    return `
<style>
  /* Scale the whole panel up for easier touch control on the small wall tablet. */
  :host { display:block; height:100%; zoom:1.15; font-family:'Instrument Sans',system-ui,sans-serif; color:#26211B; color-scheme:light; }
  * { box-sizing:border-box; }
  button { font-family:inherit; }
  .frame { width:100%; height:100%; min-height:640px; background:#F5F1EA; display:flex; overflow:hidden; }
  .rail { width:210px; flex-shrink:0; background:#F3EDDF; border-right:1px solid #E4DBC9; padding:20px 18px; display:flex; flex-direction:column; gap:14px; overflow-y:auto; }
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
      <button data-tab="settings" class="pill" title="Settings" aria-label="Settings" style="margin-left:auto;width:38px;height:38px;padding:0;display:inline-flex;align-items:center;justify-content:center;color:#4A4237"><ha-icon icon="mdi:cog" style="display:block;width:24px;height:24px;--mdc-icon-size:24px"></ha-icon></button>
    </div>

    <div data-suntest-bar style="display:none;align-items:center;gap:10px;padding:9px 12px;border:1px solid #E8C9A4;border-radius:12px;background:#FBF4E8">
      <span style="font-size:12px;font-weight:700;color:#A06B2E">☀ Sun test</span>
      <div style="display:flex;gap:6px">
        <button data-group="all" data-dir="up" title="Open every shade" style="height:32px;padding:0 10px;border-radius:9px;border:1px solid #E2DACB;background:#FFFDF9;color:#26211B;font-weight:600;font-size:11px;cursor:pointer;white-space:nowrap">Open all</button>
        <button data-group="all" data-dir="down" title="Close every shade" style="height:32px;padding:0 10px;border-radius:9px;border:1px solid #E2DACB;background:#FFFDF9;color:#26211B;font-weight:600;font-size:11px;cursor:pointer;white-space:nowrap">Close all</button>
      </div>
      <button data-suntest-play title="Play the day" style="width:32px;height:32px;border-radius:9px;border:1px solid #E2DACB;background:#FFFDF9;color:#26211B;font-size:13px;cursor:pointer">▶</button>
      <input data-suntest-scrub type="range" min="270" max="1290" step="2" autocomplete="off" style="flex:1;min-width:120px">
      <span data-suntest-time style="font:600 12px ui-monospace,Menlo,monospace;min-width:64px;text-align:right"></span>
      <select data-suntest-speed title="Sun test play speed" aria-label="Sun test play speed" style="padding:7px 9px;border-radius:9px;border:1px solid #E2DACB;background:#FFFDF9;color:#26211B;font-weight:600;font-size:12px;font-family:inherit;cursor:pointer">
        <option value="96">Fast</option><option value="24">Medium</option><option value="6">Slow</option>
      </select>
      <select data-suntest-season style="padding:7px 9px;border-radius:9px;border:1px solid #E2DACB;background:#FFFDF9;color:#26211B;font-weight:600;font-size:12px;font-family:inherit;cursor:pointer">
        <option value="today">Today</option><option value="jun">Jun 21</option><option value="sep">Sep 21</option><option value="dec">Dec 21</option>
      </select>
      <button data-suntest-off title="Exit sun test" style="width:32px;height:32px;border-radius:9px;border:1px solid #E2DACB;background:#FFFDF9;color:#8A8177;font-size:13px;cursor:pointer">✕</button>
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
      <div style="flex:1;display:flex;align-items:center;justify-content:center">
        <div style="display:flex;align-items:center;gap:16px">
          ${mainBedroom}${divider()}${upHall}${divider()}${office}
        </div>
      </div>
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
  :host { display:block; height:100%; font-family:'Instrument Sans',system-ui,sans-serif; color:#26211B; color-scheme:light; }
  * { box-sizing:border-box; }
  button { font-family:inherit; }
  input[type=range]{ accent-color:${ACCENT}; height:28px; }
  .mframe { position:relative; width:100%; height:100%; background:#F5F1EA; display:flex; flex-direction:column; overflow:hidden; }
  ${FLASH_CSS}
</style>
<div class="mframe">
  <div style="display:flex;align-items:center;justify-content:space-between;padding:14px 16px 8px;flex-shrink:0">
    <div><div style="font-size:20px;font-weight:700">Shades</div><div data-summary style="font-size:11px;color:#8A8177;margin-top:1px"></div></div>
    <button data-tab="settings" title="Settings" aria-label="Settings" style="width:40px;height:40px;border-radius:999px;border:1px solid #E2DACB;background:#FFFDF9;color:#4A4237;cursor:pointer;display:inline-flex;align-items:center;justify-content:center"><ha-icon icon="mdi:cog" style="display:block;width:24px;height:24px;--mdc-icon-size:24px"></ha-icon></button>
  </div>

  <div data-panel="home" style="flex:1;overflow-y:auto;padding:4px 14px 150px;display:flex;flex-direction:column;gap:14px">
    ${this._sunCardHtml()}
    <div style="display:flex;gap:10px">${bigBtn("open_all", "Open All")}${bigBtn("close_all", "Close All")}</div>
    ${SECTIONS.map(section).join("")}
    <div style="font-size:10px;letter-spacing:1.4px;color:#8A8177;font-weight:600;margin-top:4px">MODES</div>
    ${Object.keys(tg).map((k) => toggleRow(k, tg[k])).join("")}
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
    // hidden sun-test controls (Settings tab, desktop only)
    this._wireSunTest();
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
    entities.forEach((e) => this._mark(e, position));
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
      <div data-sun-time style="text-align:center;font:700 16px 'Instrument Sans',system-ui,sans-serif;color:#26211B;white-space:nowrap;line-height:1.2"></div>
      <div style="display:flex;justify-content:space-between;align-items:baseline;font-size:10.5px;color:#8A8177">
        <span title="Sunrise (sun2)" style="white-space:nowrap">↑ <span data-sun-rise style="color:#26211B;font-weight:600">—</span></span>
        <span title="Sunset (sun2)" style="white-space:nowrap"><span data-sun-set style="color:#26211B;font-weight:600">—</span> ↓</span>
      </div>
      <div data-sun-label style="text-align:center;font-size:11px;color:#8A8177"></div>
    </div>`;
  }

  _updateSun() {
    const root = this.shadowRoot;
    const cfg = this._layout.sun || {};
    const sunAE = this._sunAzEl();
    const elev = sunAE.el;
    const az = sunAE.az;
    // In test mode "now" is the scrubbed instant, so the tracker dot, label
    // and window light all move together.
    const nowMs = sunAE.test ? this._simDate(Math.min(1290, Math.max(270, this._sunTest.min == null ? 720 : this._sunTest.min))).getTime() : Date.now();
    const dot = root.querySelector("[data-sun-dot]");
    const timeEl = root.querySelector("[data-sun-time]");
    const labelEl = root.querySelector("[data-sun-label]");
    const riseEl = root.querySelector("[data-sun-rise]");
    const setEl = root.querySelector("[data-sun-set]");
    if (timeEl) timeEl.textContent = new Date(nowMs).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
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
      frac = (nowMs - sunriseMs) / (sunsetMs - sunriseMs);
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
      labelEl.textContent = (sunAE.test ? "☀ TEST · " : "") + text;
    }
    // The per-window sunlight + outside sky ride the same tick.
    this._updateSunLight(az, elev);
    this._updateSky(az, elev);
    this._updateSunTestUi();
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
