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
}
_GROUP_SLOTS["main_floor"] = (
    _GROUP_SLOTS["south"] + _GROUP_SLOTS["west"] + _GROUP_SLOTS["north"] + _GROUP_SLOTS["hallway"]
)
_GROUP_SLOTS["upstairs"] = _GROUP_SLOTS["upstairs_hallway"] + _GROUP_SLOTS["office"]
_GROUP_SLOTS["all"] = _GROUP_SLOTS["main_floor"] + _GROUP_SLOTS["upstairs"]

# --- Scenes ------------------------------------------------------------------
# Only Movie Mode is wired for now (per owner). ``script`` is the entity fired
# on click; ``None`` renders the button as a not-yet-configured placeholder.
# Fill these in as the corresponding HA scripts are created.
SCENES: dict[str, dict] = {
    "movie": {"title": "Movie Mode", "desc": "Close everything", "script": "script.movie_mode"},
    "sunset": {"title": "Sunset Mode", "desc": "View open, uppers cut glare", "script": None},
    "open_all": {"title": "Open All", "desc": "Every shade up", "script": None},
    "close_all": {"title": "Close All", "desc": "Every shade down", "script": None},
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


def build_panel_config() -> dict:
    """Resolve the slot layout into the JSON config handed to the card."""
    shades = {slot: {"entity": entity} for slot, entity in SHADES.items()}
    groups = {name: [SHADES[slot] for slot in slots] for name, slots in _GROUP_SLOTS.items()}
    return {"shades": shades, "groups": groups, "scenes": SCENES, "sun": SUN}
