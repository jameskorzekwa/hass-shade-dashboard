"""Constants and the baked-in window -> entity layout for the shade dashboard.

This module is the single source of truth for which Home Assistant ``cover``
entity backs each window in the design, plus the group and scene wiring. The
Lovelace card renders geometry only; it receives this layout from the panel
config (see ``__init__.async_setup_entry``) so the entity IDs live in exactly
one place. ``tests/test_layout_sync.py`` guards the JS fallback copy against
drift.

Entity IDs were verified against the live server (friendly-name -> entity_id is
irregular: several shades carry a ``_2`` suffix, some do not — do not "fix"
these to a tidy pattern; they are correct as written).
"""

from __future__ import annotations

DOMAIN = "shade_dashboard"

# --- PowerView Gen3 gateway (live position tracking) -------------------------
# The card only gets endpoint positions from the hunterdouglas_powerview
# integration (jumpy/slow during travel). The gateway's local API reports live
# position + velocity, so a poller (gateway.py) reads it during motion and fires
# ``shade_dashboard_live_position`` events the card follows. Gateway room id ->
# slot prefix (ptName is appended, except the single Downstairs Hall shade).
GATEWAY_HOST = "192.168.1.25"
GATEWAY_ROOM_SLOT: dict[int, str] = {
    165: "u",  # Family Upper  -> u1..u7
    64: "l",  # Family Lower  -> l1..l8
    1: "uh",  # Hallway       -> uh1..uh3
    21: "ko",  # Office        -> ko1..ko2
    146: "lrh1",  # Downstairs Hall -> lrh1 (single shade)
}
# The live-position event the poller fires and the card subscribes to.
LIVE_EVENT = "shade_dashboard_live_position"

# hass.data key for the process-global gateway tracker.
TRACKER_KEY = f"{DOMAIN}_tracker"

# Recalibrate a shade via the gateway's generic BLE relay: POST
# /home/shades/exec?shades=<bleName> with this frame (sid 0xF7 motion service,
# cid 0xD4 = calibrate). Captured from the PowerView app; the gateway encrypts
# and forwards it to the shade over Bluetooth (no BLE proxy / home key needed).
CALIBRATE_HEX = "F7D40303000001"
# Fired when calibration drift is detected (and auto-recalibrated).
CALIBRATE_EVENT = "shade_dashboard_calibration"
# Fired when a shade starts (seconds>0) / stops (seconds=0) calibrating, so the
# covers can lock out commands and the card can disable its controls.
CALIBRATING_EVENT = "shade_dashboard_calibrating"
# Fired when a verified group move leaves shades that never reached the target
# after a retry — {entities:[...], target:0-100}. Automations can react to it.
MOVE_FAILED_EVENT = "shade_dashboard_move_failed"
# Optional kill switch for the auto-recalibrate behavior (drift is still
# detected + notified when this is off; it just won't move the shade).
AUTO_RECAL_ENTITY = "input_boolean.shade_auto_recalibrate"

# --- Window slots -> real cover entity IDs (verified live) -------------------
# Slot keys match the geometry keys in shade-dashboard-card.js.
SHADES: dict[str, str] = {
    # South wall: uppers 1-3, lowers 1-2 (l2 is the physically broken/offline one)
    "u1": "cover.living_room_upper_shade_1",
    "u2": "cover.living_room_upper_shade_2_2",
    "u3": "cover.living_room_upper_shade_3_2",
    "l1": "cover.living_room_lower_shade_1",
    "l2": "cover.living_room_lower_shade_2",
    # West wall: angled clerestory uppers 4-7 (tallest->shortest), lowers 3-6
    "u4": "cover.living_room_upper_shade_4_2",
    "u5": "cover.living_room_upper_shade_5_2",
    "u6": "cover.living_room_upper_shade_6_2",
    "u7": "cover.living_room_upper_shade_7",
    "l3": "cover.living_room_lower_shade_3",
    "l4": "cover.living_room_lower_shade_4_2",
    "l5": "cover.living_room_lower_shade_5_2",
    "l6": "cover.living_room_lower_shade_6_2",
    # North wall: lowers 7-8
    "l7": "cover.living_room_lower_shade_7_2",
    "l8": "cover.living_room_lower_shade_8_2",
    # Main-floor hallway (single window, far right of the strip)
    "lrh1": "cover.living_room_hallway_shade_1_2",
    # Upstairs hallway 1-3
    "uh1": "cover.hallway_shade_1_2",
    "uh2": "cover.hallway_shade_2_2",
    "uh3": "cover.hallway_shade_3_2",
    # Kyle's office 1-2
    "ko1": "cover.kyle_s_office_shade_1",
    "ko2": "cover.kyle_s_office_shade_2",
    # Main bedroom sliding-door shade (horizontal travel: left=open, right=closed)
    "mbr1": "cover.main_bedroom_shades",
}

# --- Groups (chip ▲▼, floor open/close, scenes) --------------------------
# Values are lists of slot keys; resolved to entity IDs in build_panel_config().
_GROUP_SLOTS: dict[str, list[str]] = {
    "south": ["u1", "u2", "u3", "l1", "l2"],
    "west": ["u4", "u5", "u6", "u7", "l3", "l4", "l5", "l6"],
    "north": ["l7", "l8"],
    "hallway": ["lrh1"],
    "upstairs_hallway": ["uh1", "uh2", "uh3"],
    "office": ["ko1", "ko2"],
    "main_bedroom": ["mbr1"],
}
_GROUP_SLOTS["main_floor"] = (
    _GROUP_SLOTS["south"] + _GROUP_SLOTS["west"] + _GROUP_SLOTS["north"] + _GROUP_SLOTS["hallway"]
)
_GROUP_SLOTS["upstairs"] = _GROUP_SLOTS["main_bedroom"] + _GROUP_SLOTS["upstairs_hallway"] + _GROUP_SLOTS["office"]
_GROUP_SLOTS["all"] = _GROUP_SLOTS["main_floor"] + _GROUP_SLOTS["upstairs"]

# --- Left-rail scene buttons -------------------------------------------------
# Open All / Close All route to the "all" group (which fires the whole-house
# PowerView scene). ``kind`` tells the card how to act. (Movie Mode is a toggle,
# see TOGGLES.)
SCENES: dict[str, dict] = {
    "open_all": {"title": "Open All", "desc": "Every shade up", "kind": "group", "group": "all", "dir": "up"},
    "close_all": {"title": "Close All", "desc": "Every shade down", "kind": "group", "group": "all", "dir": "down"},
}

# Group open/close no longer uses PowerView scenes at all. The card calls
# shade_dashboard.move_group, which moves every gateway-tracked member in ONE
# synchronized `PUT /home/shades/positions?ids=<all ids>` call (verified in-sync)
# and moves untracked members (the RYSE main bedroom) via their cover — so the
# dashboard has zero dependency on the app-created scenes.

# --- Left-rail toggles -------------------------------------------------------
# Each reflects an input_boolean and flips it on tap. ``automation`` uses the
# enable/disable scripts (which set the boolean AND reset the glare debounce
# timers); ``movie`` toggles input_boolean.movie_mode directly (HA's "Control
# Movie Mode" automation runs the movie/disable-movie scripts off that boolean).
TOGGLES: dict[str, dict] = {
    "movie": {
        "title": "Movie Mode",
        "desc_on": "On · everything closed",
        "desc_off": "Off",
        "entity": "input_boolean.movie_mode",
    },
    "automation": {
        "title": "Auto shades",
        "desc_on": "On · sun & sunset control",
        "desc_off": "Off · manual only",
        "entity": "input_boolean.shade_automation",
        "enable_script": "script.enable_shade_automation",
        "disable_script": "script.disable_shade_automation",
    },
}

# --- Sun widget sources ------------------------------------------------------
# elevation/azimuth come from the sun2 integration's sensors (numeric state).
# The card falls back to core ``sun.sun`` elevation/azimuth attributes if these
# are unavailable, so the widget works whether or not the sun2 sensors are
# enabled. The glare hint reads the living-room lux sensors.
SUN: dict[str, str] = {
    "elevation_entity": "sensor.home2_sun_elevation",
    "azimuth_entity": "sensor.home2_sun_azimuth",
    "west_lux": "sensor.west_light_level",
    "south_lux": "sensor.south_light_level",
}


def _tracked_entities() -> list[str]:
    """Cover entities on the G3 gateway (everything with live tracking) — i.e.
    every shade whose slot prefix is a gateway room. The main bedroom shade is on
    a different device and isn't tracked."""
    prefixes = {p for p in GATEWAY_ROOM_SLOT.values() if p != "lrh1"}
    out = []
    for slot, entity in SHADES.items():
        base = slot.rstrip("0123456789")
        if slot == "lrh1" or base in prefixes:
            out.append(entity)
    return out


# --- Unified abstraction covers ---------------------------------------------
# The integration owns one cover.shade_<slot> per shade (see cover.py). It
# presents a consistent interface and routes to the real device behind it — the
# card talks only to these, so it doesn't care whether a shade is Hunter Douglas
# (PowerView gateway) or RYSE (HomeKit). SHADES stays the real-device map (the
# adapter target); ABSTRACT_PREFIX + abstract_entity() derive the front entity.
ABSTRACT_PREFIX = "cover.shade_"
_SOURCE_TO_SLOT = {entity: slot for slot, entity in SHADES.items()}


def abstract_entity(slot: str) -> str:
    """The integration-owned unified cover for a slot (front interface)."""
    return f"{ABSTRACT_PREFIX}{slot}"


def source_for_abstract(entity: str) -> str | None:
    """Map an abstraction cover (cover.shade_<slot>) to its real source cover."""
    if entity.startswith(ABSTRACT_PREFIX):
        return SHADES.get(entity[len(ABSTRACT_PREFIX) :])
    return entity if entity in _SOURCE_TO_SLOT else None


def build_panel_config() -> dict:
    """Resolve the slot layout into the JSON config handed to the card.

    Everything the card commands/reads is the abstract cover; bulk group moves go
    through shade_dashboard.move_group (direct in-sync gateway calls, no scenes).
    """
    shades = {slot: {"entity": abstract_entity(slot)} for slot in SHADES}
    groups = {name: [abstract_entity(slot) for slot in slots] for name, slots in _GROUP_SLOTS.items()}
    tracked = set(_tracked_entities())
    return {
        "shades": shades,
        "groups": groups,
        "scenes": SCENES,
        "sun": SUN,
        "toggles": TOGGLES,
        "tracked": _tracked_entities(),
        # slots whose shade supports recalibration (PowerView; excludes RYSE mbr1)
        "recal_slots": [slot for slot, entity in SHADES.items() if entity in tracked],
    }
