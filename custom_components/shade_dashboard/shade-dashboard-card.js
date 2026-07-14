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
const SCENE_ACTIVE_BG = "color-mix(in oklab, #C67B3B 18%, #FFFDF9)";

// Mirror of const.py (build_panel_config). Kept in sync by test_layout_sync.py.
const DEFAULT_LAYOUT = {
  shades: {
    u1: { entity: "cover.living_room_upper_shade_1" },
    u2: { entity: "cover.living_room_upper_shade_2_2" },
    u3: { entity: "cover.living_room_upper_shade_3_2" },
    l1: { entity: "cover.living_room_lower_shade_1" },
    l2: { entity: "cover.living_room_lower_shade_2" },
    u4: { entity: "cover.living_room_upper_shade_4_2" },
    u5: { entity: "cover.living_room_upper_shade_5_2" },
    u6: { entity: "cover.living_room_upper_shade_6_2" },
    u7: { entity: "cover.living_room_upper_shade_7" },
    l3: { entity: "cover.living_room_lower_shade_3" },
    l4: { entity: "cover.living_room_lower_shade_4_2" },
    l5: { entity: "cover.living_room_lower_shade_5_2" },
    l6: { entity: "cover.living_room_lower_shade_6_2" },
    l7: { entity: "cover.living_room_lower_shade_7_2" },
    l8: { entity: "cover.living_room_lower_shade_8_2" },
    lrh1: { entity: "cover.living_room_hallway_shade_1_2" },
    uh1: { entity: "cover.hallway_shade_1_2" },
    uh2: { entity: "cover.hallway_shade_2_2" },
    uh3: { entity: "cover.hallway_shade_3_2" },
    ko1: { entity: "cover.kyle_s_office_shade_1" },
    ko2: { entity: "cover.kyle_s_office_shade_2" },
    mbr1: { entity: "cover.main_bedroom_shades" },
  },
  groups: {
    south: ["cover.living_room_upper_shade_1", "cover.living_room_upper_shade_2_2", "cover.living_room_upper_shade_3_2", "cover.living_room_lower_shade_1", "cover.living_room_lower_shade_2"],
    west: ["cover.living_room_upper_shade_4_2", "cover.living_room_upper_shade_5_2", "cover.living_room_upper_shade_6_2", "cover.living_room_upper_shade_7", "cover.living_room_lower_shade_3", "cover.living_room_lower_shade_4_2", "cover.living_room_lower_shade_5_2", "cover.living_room_lower_shade_6_2"],
    north: ["cover.living_room_lower_shade_7_2", "cover.living_room_lower_shade_8_2"],
    hallway: ["cover.living_room_hallway_shade_1_2"],
    upstairs_hallway: ["cover.hallway_shade_1_2", "cover.hallway_shade_2_2", "cover.hallway_shade_3_2"],
    office: ["cover.kyle_s_office_shade_1", "cover.kyle_s_office_shade_2"],
    main_bedroom: ["cover.main_bedroom_shades"],
  },
  scenes: {
    movie: { title: "Movie Mode", desc: "Close everything", script: "script.movie_mode" },
    sunset: { title: "Sunset Mode", desc: "View open, uppers cut glare", script: null },
    open_all: { title: "Open All", desc: "Every shade up", script: null },
    close_all: { title: "Close All", desc: "Every shade down", script: null },
  },
  sun: {
    elevation_entity: "sensor.home2_sun_elevation",
    azimuth_entity: "sensor.home2_sun_azimuth",
    west_lux: "sensor.west_light_level",
    south_lux: "sensor.south_light_level",
  },
};
DEFAULT_LAYOUT.groups.main_floor = [...DEFAULT_LAYOUT.groups.south, ...DEFAULT_LAYOUT.groups.west, ...DEFAULT_LAYOUT.groups.north, ...DEFAULT_LAYOUT.groups.hallway];
DEFAULT_LAYOUT.groups.upstairs = [...DEFAULT_LAYOUT.groups.main_bedroom, ...DEFAULT_LAYOUT.groups.upstairs_hallway, ...DEFAULT_LAYOUT.groups.office];
DEFAULT_LAYOUT.groups.all = [...DEFAULT_LAYOUT.groups.main_floor, ...DEFAULT_LAYOUT.groups.upstairs];

// Presentation metadata (label number + control-bar subtitle). Card-side only.
const SLOT_META = {
  u1: { sub: "Living room · south wall" }, u2: { sub: "Living room · south wall" }, u3: { sub: "Living room · south wall" },
  l1: { num: "1", sub: "Living room · south wall" }, l2: { num: "2", sub: "Living room · south wall" },
  u4: { sub: "Living room · west wall" }, u5: { sub: "Living room · west wall" }, u6: { sub: "Living room · west wall" }, u7: { sub: "Living room · west wall" },
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
  `<div data-fabric="${slot}" style="position:absolute;top:0;left:0;right:0;height:0;background:${FABRIC};border-bottom:${hem}px solid #C2B9A9;transition:height .45s ease"></div>`;
const offline = (slot) =>
  `<div data-offline="${slot}" style="display:none;position:absolute;inset:0;align-items:center;justify-content:center;background:${HATCH}"><span style="writing-mode:vertical-rl;font:700 10px ui-monospace,Menlo,monospace;letter-spacing:2px;color:#A2988A">OFFLINE</span></div>`;
const flash = (slot, clip) =>
  `<div data-flash="${slot}" class="sd-flash-ov" style="${clip ? `clip-path:url(#sd-clip-${slot})` : "border-radius:3px"}"></div>`;
const winRect = (slot, glass) =>
  `<div data-slot="${slot}" title="${slot}" style="position:relative;width:84px;height:190px;border:3px solid #1F1B17;border-radius:3px;background:${glass};overflow:hidden;cursor:pointer">${fabric(slot, 4)}${flash(slot)}${offline(slot)}</div>`;
const label = (slot) =>
  `<span data-label="${slot}" style="font:600 10px ui-monospace,Menlo,monospace;color:#8A8177"></span>`;
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
    `<div data-fabric="${slot}" data-axis="x" style="position:absolute;top:0;left:0;bottom:0;width:0;background:${FABRIC};border-right:4px solid #C2B9A9;transition:width .45s ease"></div>` +
    flash(slot) +
    offline(slot) +
  `</div>`;
const doorCol = (slot) =>
  `<div style="display:flex;flex-direction:column;align-items:center;gap:6px">${winDoor(slot)}${label(slot)}</div>`;
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
  return (
    `<div data-slot="${slot}" title="${slot}" style="position:relative;width:84px;height:${h}px;cursor:pointer">` +
      `<svg width="84" height="${h}" viewBox="0 0 84 ${h}" style="position:absolute;inset:0;display:block">` +
        `<defs>` +
          `<linearGradient id="sd-g-${slot}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#CBD6DC"/><stop offset="1" stop-color="#E2E2D6"/></linearGradient>` +
          `<clipPath id="sd-clip-${slot}" clipPathUnits="userSpaceOnUse"><path d="${inner}"/></clipPath>` +
        `</defs>` +
        `<path d="${outer}" fill="#1F1B17"/>` +
        `<path d="${inner}" fill="url(#sd-g-${slot})"/>` +
      `</svg>` +
      `<div data-fabric="${slot}" style="position:absolute;top:0;left:0;right:0;height:0;background:${FABRIC};border-bottom:4px solid #C2B9A9;transition:height .45s ease;clip-path:url(#sd-clip-${slot})"></div>` +
      flash(slot, true) +
    `</div>`
  );
};
const chip = (group, text) =>
  `<div style="display:flex;align-items:center;gap:6px"><span style="font-size:10px;letter-spacing:1.2px;color:#8A8177;font-weight:600">${text}</span>` +
    `<button data-group="${group}" data-dir="up" title="Open" style="width:30px;height:26px;border:1px solid #DFD7C9;background:#FFFDF9;border-radius:7px;cursor:pointer;font-size:10px;color:#4A4237;padding:0">▲</button>` +
    `<button data-group="${group}" data-dir="down" title="Close" style="width:30px;height:26px;border:1px solid #DFD7C9;background:#FFFDF9;border-radius:7px;cursor:pointer;font-size:10px;color:#4A4237;padding:0">▼</button></div>`;
const divider = () => `<div style="width:1px;align-self:stretch;background:#E0D8C9"></div>`;
const sceneBtn = (key, s) =>
  `<button data-scene="${key}" style="text-align:left;padding:12px 14px;border:1px solid #E2DACB;border-radius:12px;background:#FFFDF9;cursor:pointer;display:flex;flex-direction:column;gap:3px">` +
    `<span style="font-weight:600;font-size:14px;color:#26211B">${s.title}</span><span style="font-size:11px;color:#8A8177">${s.desc}</span></button>`;

class ShadeDashboardCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._built = false;
    this._selected = null;
    this._dragging = false;
    this._lastScene = null;
    this._tab = "main";
    this._layout = DEFAULT_LAYOUT;
    // Optimistic targets: entity_id -> {target(HA pos 0-100), moving(bool)}.
    // Set on command so the fabric jumps to the target immediately and the
    // in-motion flash stays on until HA settles (current_position is stale while
    // a shade is opening/closing). Reconciled/cleared in _reconcileOptimistic.
    this._optimistic = {};
    this._optTimers = {};
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
  _pos(slot) {
    const st = this._stateObj(slot);
    if (!st || st.state === "unavailable" || st.state === "unknown") return null;
    const p = st.attributes.current_position;
    if (p != null) return Math.round(p);
    return st.state === "open" ? 100 : 0; // no position support -> binary
  }
  // Display position: the commanded target while a command is in flight, else
  // the live current_position — so the shade jumps to where it's going and holds.
  _dispPos(slot) {
    const e = this._entity(slot);
    if (e && this._optimistic[e]) return this._optimistic[e].target;
    return this._pos(slot);
  }
  _isMoving(slot) {
    const st = this._stateObj(slot);
    const e = this._entity(slot);
    if (st && (st.state === "opening" || st.state === "closing")) return true;
    return !!(e && this._optimistic[e]);
  }

  // Record a commanded target for an entity and (re)arm a safety timeout.
  _setOptimistic(entity, target) {
    if (!entity) return;
    this._optimistic[entity] = { target, moving: false };
    clearTimeout(this._optTimers[entity]);
    this._optTimers[entity] = setTimeout(() => {
      delete this._optimistic[entity];
      delete this._optTimers[entity];
      this._update();
    }, 45000);
  }
  _clearOptimistic(entity) {
    delete this._optimistic[entity];
    clearTimeout(this._optTimers[entity]);
    delete this._optTimers[entity];
  }
  // Clear an optimistic target once HA has actually moved and settled (or the
  // shade already sits at the target). Keeps showing the target across the brief
  // gap before HA flips to opening/closing.
  _reconcileOptimistic() {
    for (const e of Object.keys(this._optimistic)) {
      const st = this._hass.states[e];
      if (!st) continue;
      if (st.state === "opening" || st.state === "closing") {
        this._optimistic[e].moving = true;
        continue;
      }
      const cur = st.attributes.current_position;
      const reached = cur == null || Math.abs(cur - this._optimistic[e].target) <= 2;
      if (this._optimistic[e].moving || reached) this._clearOptimistic(e);
    }
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
    this.shadowRoot.innerHTML = this._template();
    this._built = true;
    this._wire();
  }

  _template() {
    const sc = this._layout.scenes;
    // South wall: three columns against the chimney
    const south =
      `<div style="display:flex;flex-direction:column;align-items:center;gap:10px">` +
        `<div style="display:flex;align-items:stretch;gap:14px">` +
          // col 1: upper 1 over the front door
          `<div style="display:flex;flex-direction:column;justify-content:space-between;align-items:center;height:470px">` +
            winRect("u1", GLASS_UPPER) +
            `<div style="display:flex;flex-direction:column;align-items:center;gap:6px"><div title="Front door (no shade)" style="width:84px;height:210px;border:3px solid #1F1B17;border-radius:3px;background:linear-gradient(180deg,#3A342C 0%,#4A423A 60%,#5A5044 100%);opacity:.75;position:relative"><div style="position:absolute;left:10px;right:10px;top:12px;bottom:44%;background:linear-gradient(180deg,#8FA0A8,#B9BDB0);border-radius:2px"></div></div><span style="font:600 10px ui-monospace,Menlo,monospace;color:#B9B0A2">DOOR</span></div>` +
          `</div>` +
          // col 2: upper 2 over lower 1
          `<div style="display:flex;flex-direction:column;justify-content:space-between;align-items:center;height:470px">${winRect("u2", GLASS_UPPER)}${lowerCol("l1")}</div>` +
          // chimney
          `<div style="width:84px;height:448px;align-self:flex-start;border-radius:3px 3px 0 0;background:repeating-linear-gradient(180deg,#D3CCBE 0 8px,#C6BDAD 8px 10px);position:relative"><div style="position:absolute;left:11px;right:11px;top:218px;height:42px;background:#26211B;border-radius:2px"></div><div style="position:absolute;left:8px;right:8px;bottom:12px;height:30px;background:#33291F;border-radius:2px"></div></div>` +
          // col 3: upper 3 over lower 2 (the offline one)
          `<div style="display:flex;flex-direction:column;justify-content:space-between;align-items:center;height:470px">${winRect("u3", GLASS_UPPER)}${lowerCol("l2")}</div>` +
        `</div>` +
        chip("south", "SOUTH WALL") +
      `</div>`;
    // West wall: 4 angled uppers over 4 lowers
    const west =
      `<div style="display:flex;flex-direction:column;align-items:center;gap:10px">` +
        // gap sized so the angled uppers' bottoms line up with the south-wall uppers' bottoms
        `<div style="display:flex;flex-direction:column;gap:72px;align-items:center">` +
          `<div style="display:flex;align-items:flex-end;gap:14px">${winAngled("u4", 190)}${winAngled("u5", 150)}${winAngled("u6", 110)}${winAngled("u7", 70)}</div>` +
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
        `<div style="display:flex;align-items:flex-end;gap:14px">${lowerCol("uh1")}${divider()}${lowerCol("uh2")}${lowerCol("uh3")}</div>` +
        chip("upstairs_hallway", "ALL HALLWAY") +
      `</div>`;
    const office =
      `<div style="display:flex;flex-direction:column;align-items:center;gap:14px">` +
        `<span style="font-size:12px;font-weight:700;letter-spacing:1.6px;color:#4A4237">KYLE'S OFFICE</span>` +
        `<div style="display:flex;align-items:flex-end;gap:14px">${lowerCol("ko1")}${lowerCol("ko2")}</div>` +
        chip("office", "ALL OFFICE") +
      `</div>`;

    return `
<style>
  :host { display:block; height:100%; font-family:'Instrument Sans',system-ui,sans-serif; color:#26211B; }
  * { box-sizing:border-box; }
  button { font-family:inherit; }
  .frame { width:100%; height:100%; min-height:640px; background:#F5F1EA; display:flex; overflow:hidden; }
  .rail { width:210px; flex-shrink:0; background:#FFFDF9; border-right:1px solid #EAE2D4; padding:20px 18px; display:flex; flex-direction:column; gap:14px; overflow-y:auto; }
  .main { flex:1; position:relative; padding:20px 22px; display:flex; flex-direction:column; gap:14px; min-width:0; }
  input[type=range]{ accent-color:${ACCENT}; }
  .pill { padding:9px 18px; border-radius:999px; border:1px solid #E2DACB; cursor:pointer; font-weight:600; font-size:13px; }
  /* In-motion feedback: the whole window flashes accent + a pulsing accent
     outline. Uses outline (not box-shadow) so it composes with the selection
     ring. The flash is a full-cover accent overlay (pointer-events:none). */
  @keyframes sd-pulse { 0%,100% { outline-color: rgba(198,123,59,.95); } 50% { outline-color: rgba(198,123,59,.15); } }
  .sd-moving { outline: 3px solid rgba(198,123,59,.95); outline-offset: 1px; border-radius: 3px; animation: sd-pulse .95s ease-in-out infinite; }
  .sd-flash-ov { position:absolute; inset:0; background:${ACCENT}; opacity:0; pointer-events:none; }
  @keyframes sd-flash-anim { 0%,100% { opacity:0; } 50% { opacity:.34; } }
  .sd-flash-on { animation: sd-flash-anim .95s ease-in-out infinite; }
  @keyframes sd-blink { 0%,100% { opacity: 1; } 50% { opacity: .5; } }
  .sd-moving-label { color:${ACCENT} !important; animation: sd-blink .95s ease-in-out infinite; }
</style>
<div class="frame">
  <div class="rail">
    <div>
      <div style="font-size:19px;font-weight:700;letter-spacing:.3px">Shades</div>
      <div style="font-size:11px;color:#8A8177;margin-top:2px">22 shades</div>
    </div>
    <div data-sun-card style="display:flex;flex-direction:column;gap:6px;padding:12px;border:1px solid #E2DACB;border-radius:12px;background:#FBF8F2">
      <div style="position:relative;width:150px;height:66px;overflow:hidden;margin:0 auto">
        <div style="position:absolute;left:8px;top:8px;width:134px;height:134px;border-radius:50%;border:1.5px dashed #CDC3B2"></div>
        <div style="position:absolute;left:0;right:0;bottom:0;height:2px;background:#CDC3B2"></div>
        <div data-sun-dot style="position:absolute;width:12px;height:12px;border-radius:50%;background:${ACCENT};opacity:0;left:69px;top:0;box-shadow:0 0 10px 2px rgba(198,123,59,.45)"></div>
      </div>
      <div style="display:flex;justify-content:space-between;font-size:11px;color:#8A8177"><span>E</span><span data-sun-time style="color:#26211B;font-weight:600"></span><span>W</span></div>
      <div data-sun-label style="text-align:center;font-size:11px;color:#8A8177"></div>
    </div>
    <div style="font-size:10px;letter-spacing:1.4px;color:#8A8177;font-weight:600;margin-top:6px">SCENES</div>
    ${sceneBtn("movie", sc.movie)}
    ${sceneBtn("sunset", sc.sunset)}
    ${sceneBtn("open_all", sc.open_all)}
    ${sceneBtn("close_all", sc.close_all)}
    <div style="flex:1"></div>
    <div data-summary style="font-size:11px;color:#8A8177"></div>
  </div>
  <div class="main">
    <div style="display:flex;gap:8px">
      <button data-tab="main" class="pill">Main Floor</button>
      <button data-tab="up" class="pill">Upstairs</button>
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

    <div data-bar style="position:absolute;left:22px;right:22px;bottom:16px;display:none;align-items:center;gap:14px;padding:12px 16px;background:#26211B;color:#F5F1EA;border-radius:14px;box-shadow:0 10px 30px rgba(30,25,18,.3)">
      <button data-bar-close style="width:26px;height:26px;border-radius:50%;border:none;background:rgba(255,255,255,.12);color:#F5F1EA;cursor:pointer;flex-shrink:0">✕</button>
      <div style="min-width:200px"><div data-bar-name style="font-weight:600;font-size:14px"></div><div data-bar-sub style="font-size:11px;color:#B8AF9F"></div></div>
      <div data-bar-ctl style="display:flex;align-items:center;gap:12px;flex:1">
        <input data-bar-slider type="range" min="0" max="100" value="0" style="flex:1">
        <span data-bar-pct style="font:600 13px ui-monospace,Menlo,monospace;min-width:44px;text-align:right"></span>
        <button data-bar-action="close" style="padding:8px 14px;border-radius:9px;border:1px solid rgba(255,255,255,.25);background:transparent;color:#F5F1EA;cursor:pointer;font-weight:600;font-size:12px">Close</button>
        <button data-bar-action="open" style="padding:8px 14px;border-radius:9px;border:none;background:${ACCENT};color:#FFF;cursor:pointer;font-weight:600;font-size:12px">Open</button>
      </div>
      <div data-bar-unavail style="display:none;flex:1;font-size:12px;color:#E4B7A0">Unavailable in Home Assistant — check shade power or the PowerView gateway.</div>
    </div>
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
    // group chips + floor buttons
    root.querySelectorAll("[data-group]").forEach((el) =>
      el.addEventListener("click", () => this._group(el.getAttribute("data-group"), el.getAttribute("data-dir")))
    );
    // scenes
    root.querySelectorAll("[data-scene]").forEach((el) =>
      el.addEventListener("click", () => this._scene(el.getAttribute("data-scene")))
    );
    // control bar
    root.querySelector("[data-bar-close]").addEventListener("click", () => { this._selected = null; this._update(); });
    // The UI shows a CLOSED percentage (0% = open, 100% = closed); HA's
    // current_position is the inverse (100 = open), so convert on read/write.
    const slider = root.querySelector("[data-bar-slider]");
    slider.addEventListener("input", () => {
      this._dragging = true;
      const closed = Number(slider.value);
      root.querySelector("[data-bar-pct]").textContent = `${closed}%`;
      if (this._selected) this._setFabric(this._selected, 100 - closed);
    });
    slider.addEventListener("change", () => {
      this._dragging = false;
      if (!this._selected) return;
      const target = 100 - Number(slider.value);
      this._setOptimistic(this._entity(this._selected), target);
      this._callCover("set_cover_position", this._entity(this._selected), { position: target });
      this._update();
    });
    root.querySelector('[data-bar-action="open"]').addEventListener("click", () => this._commandSelected("open_cover", 100));
    root.querySelector('[data-bar-action="close"]').addEventListener("click", () => this._commandSelected("close_cover", 0));
  }

  // --- actions ---------------------------------------------------------------
  _callCover(service, entity, extra) {
    if (!entity || !this._hass) return;
    this._hass.callService("cover", service, Object.assign({ entity_id: entity }, extra || {}));
  }
  _commandSelected(service, target) {
    if (!this._selected) return;
    this._setOptimistic(this._entity(this._selected), target);
    this._callCover(service, this._entity(this._selected));
    this._update();
  }
  _group(group, dir) {
    const entities = (this._layout.groups[group] || []).filter((e) => {
      const st = this._hass && this._hass.states[e];
      return st && st.state !== "unavailable";
    });
    if (!entities.length) return;
    const target = dir === "up" ? 100 : 0;
    // Optimistically target EVERY shade in the group so they all jump + flash at
    // once (one service call fires them together; the gateway may still move them
    // sequentially, but the dashboard shows the whole group in motion).
    entities.forEach((e) => this._setOptimistic(e, target));
    this._callCover(dir === "up" ? "open_cover" : "close_cover", entities);
    this._update();
  }
  _scene(key) {
    const s = this._layout.scenes[key];
    if (s && s.script) {
      this._hass.callService("script", "turn_on", { entity_id: s.script });
      this._lastScene = key;
      this._update();
    } else {
      fireEvent(this, "hass-notification", { message: `"${s ? s.title : key}" isn't set up yet — create its HA script, then wire it in const.py.` });
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
    this._reconcileOptimistic();

    // per-shade: fabric, label, offline, ring, in-motion flash
    for (const slot of Object.keys(this._layout.shades)) {
      const st = this._stateObj(slot);
      const unavailable = !st || st.state === "unavailable";
      const moving = !unavailable && this._isMoving(slot);
      const win = root.querySelector(`[data-slot="${slot}"]`);
      const off = root.querySelector(`[data-offline="${slot}"]`);
      const fl = root.querySelector(`[data-flash="${slot}"]`);
      const lab = root.querySelector(`[data-label="${slot}"]`);
      const meta = SLOT_META[slot] || {};
      if (win) win.style.boxShadow = this._selected === slot ? RING : "none";
      if (win) win.classList.toggle("sd-moving", moving);
      if (fl) fl.classList.toggle("sd-flash-on", moving);
      if (off) off.style.display = unavailable ? "flex" : "none";
      if (win) win.style.borderColor = unavailable ? "#B5AC9D" : "#1F1B17";
      // Render the display position (commanded target while moving) unless the
      // user is actively dragging this slot's slider.
      if (!unavailable && !this._dragging) this._setFabric(slot, this._dispPos(slot));
      if (lab) {
        lab.classList.toggle("sd-moving-label", moving); // accent-tint the % while in motion
        if (unavailable) {
          lab.textContent = meta.num != null ? `${meta.num} · —`.replace(/^ · /, "") : "—";
          lab.style.color = "#B0563C";
        } else {
          const closed = 100 - this._dispPos(slot); // closed %: 100 = closed, 0 = open (target while moving)
          const num = meta.num;
          lab.textContent = num ? `${num} · ${closed}%` : `${closed}%`;
          if (!moving) lab.style.color = "#8A8177";
        }
      }
    }

    // tabs
    root.querySelectorAll("[data-tab]").forEach((el) => {
      const active = el.getAttribute("data-tab") === this._tab;
      el.style.background = active ? "#26211B" : "#FFFDF9";
      el.style.color = active ? "#F5F1EA" : "#4A4237";
    });
    root.querySelector('[data-panel="main"]').style.display = this._tab === "main" ? "flex" : "none";
    root.querySelector('[data-panel="up"]').style.display = this._tab === "up" ? "flex" : "none";

    // scenes highlight
    root.querySelectorAll("[data-scene]").forEach((el) => {
      el.style.background = this._lastScene === el.getAttribute("data-scene") ? SCENE_ACTIVE_BG : "#FFFDF9";
    });

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

  _updateSun() {
    const root = this.shadowRoot;
    const cfg = this._layout.sun || {};
    const elev = this._sunVal(cfg.elevation_entity, "elevation");
    const az = this._sunVal(cfg.azimuth_entity, "azimuth");
    const dot = root.querySelector("[data-sun-dot]");
    const timeEl = root.querySelector("[data-sun-time]");
    const labelEl = root.querySelector("[data-sun-label]");
    if (timeEl) timeEl.textContent = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

    const night = elev == null || elev < 0;
    if (dot) {
      if (night || az == null) {
        dot.style.opacity = "0";
      } else {
        // azimuth 90(E)->270(W) across a semicircle; center (75,75), r=67
        const t = Math.PI * (Math.min(270, Math.max(90, az)) - 90) / 180;
        const x = 75 - 67 * Math.cos(t);
        const y = 75 - 67 * Math.sin(t);
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
  }

  _updateBar() {
    const root = this.shadowRoot;
    const bar = root.querySelector("[data-bar]");
    if (!this._selected) { bar.style.display = "none"; return; }
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
      : this._dispPos(slot) >= this._pos(slot) ? "Opening…" : "Closing…";
    root.querySelector("[data-bar-sub]").textContent = moving ? dirWord : meta.sub || "";
    root.querySelector("[data-bar-ctl]").style.display = unavailable ? "none" : "flex";
    root.querySelector("[data-bar-unavail]").style.display = unavailable ? "block" : "none";
    const pctEl = root.querySelector("[data-bar-pct]");
    pctEl.classList.toggle("sd-moving-label", moving);
    if (!unavailable && !this._dragging) {
      const closed = 100 - this._dispPos(slot); // slider + readout are closed % (target while moving)
      root.querySelector("[data-bar-slider]").value = String(closed);
      pctEl.textContent = `${closed}%`;
    }
  }
}

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
