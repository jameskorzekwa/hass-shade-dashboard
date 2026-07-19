"""Guard the JS card's DEFAULT_LAYOUT against drift from const.py.

const.py is the single source of truth for the window -> entity map. The card
carries a mirror (DEFAULT_LAYOUT) so it also works standalone. This test fails
loudly if the two diverge.
"""

from __future__ import annotations

import re
from pathlib import Path

from custom_components.shade_dashboard.const import (
    LUX_SENSORS,
    SCENES,
    SHADES,
    TOGGLES,
    abstract_entity,
    build_panel_config,
)

CARD_JS = Path(__file__).resolve().parent.parent / "custom_components" / "shade_dashboard" / "shade-dashboard-card.js"


def _parse_js_shades() -> dict[str, str]:
    """Extract the `slot: { entity: "..." }` map from the card's DEFAULT_LAYOUT."""
    text = CARD_JS.read_text()
    block = re.search(r"shades:\s*\{(.*?)\n\s*\},\n\s*groups:", text, re.DOTALL)
    assert block, "could not locate the shades block in DEFAULT_LAYOUT"
    pairs = re.findall(r'(\w+):\s*\{\s*entity:\s*"([^"]+)"\s*\}', block.group(1))
    return dict(pairs)


def test_all_shades_present() -> None:
    # 21 PowerView shades + the main-bedroom sliding-door shade
    assert len(SHADES) == 22
    assert SHADES["mbr1"] == "cover.main_bedroom_shades"


def test_js_shade_map_matches_const() -> None:
    # The card talks to the unified abstraction covers (cover.shade_<slot>), and
    # its DEFAULT_LAYOUT must mirror what build_panel_config hands the panel.
    expected = {slot: abstract_entity(slot) for slot in SHADES}
    assert _parse_js_shades() == expected
    assert {slot: cfg["entity"] for slot, cfg in build_panel_config()["shades"].items()} == expected


def test_lux_sensor_map_matches_windows_and_card() -> None:
    expected = {
        "l3": {
            "entity": "sensor.west_light_level",
            "name": "Living Room Lux Sensor West",
            "corner": "bottom-right",
        },
        "u3": {
            "entity": "sensor.south_light_level",
            "name": "Living Room Lux Sensor South",
            "corner": "bottom-left",
        },
        "uh3": {
            "entity": "sensor.lux_sensor_3_light_level",
            "name": "Upstairs Hallway Lux Sensor West",
            "corner": "top-right",
        },
    }
    assert expected == LUX_SENSORS
    assert build_panel_config()["lux_sensors"] == expected

    import json

    text = CARD_JS.read_text()
    block = re.search(r"lux_sensors:\s*(\{.*?\n  \}),", text, re.DOTALL)
    assert block, "could not locate the lux_sensors block in DEFAULT_LAYOUT"
    assert json.loads(block.group(1)) == expected


def test_offline_shade_is_lower_2() -> None:
    # The design's known-broken shade; still must be present in the map.
    assert SHADES["l2"] == "cover.living_room_lower_shade_2"


def test_scene_buttons_wired() -> None:
    # Open/Close All route to the whole-house group (fires the gateway scene)
    assert SCENES["open_all"]["kind"] == "group" and SCENES["open_all"]["group"] == "all"
    assert SCENES["close_all"]["kind"] == "group" and SCENES["close_all"]["dir"] == "down"
    assert "movie" not in SCENES  # Movie Mode is now a toggle
    assert "sunset" not in SCENES  # Sunset Mode dropped


def test_toggles() -> None:
    cfg = build_panel_config()
    tg = cfg["toggles"]
    # movie toggles the boolean directly; auto uses the enable/disable scripts
    assert tg["movie"]["entity"] == "input_boolean.movie_mode"
    assert "enable_script" not in tg["movie"]
    assert tg["automation"]["entity"] == "input_boolean.shade_automation"
    assert TOGGLES["automation"]["enable_script"] == "script.enable_shade_automation"
    text = CARD_JS.read_text()
    assert "input_boolean.movie_mode" in text
    assert "input_boolean.shade_automation" in text


def test_gateway_room_slot_resolves() -> None:
    from custom_components.shade_dashboard.const import GATEWAY_ROOM_SLOT

    # every gateway room prefix must map onto real slots (room+ptName -> slot)
    for prefix in GATEWAY_ROOM_SLOT.values():
        if prefix == "lrh1":
            assert "lrh1" in SHADES
        else:
            assert f"{prefix}1" in SHADES  # ptName 1 always exists
    # the main bedroom is NOT on this gateway (no live tracking there)
    assert "cover.main_bedroom_shades" not in {SHADES[f"{p}1"] for p in GATEWAY_ROOM_SLOT.values() if p != "lrh1"}


def test_no_scenes_in_config() -> None:
    # Bulk moves go through shade_dashboard.move_group (direct in-sync gateway
    # calls) — the config no longer carries any PowerView scene mapping.
    cfg = build_panel_config()
    assert "group_scenes" not in cfg
    text = CARD_JS.read_text()
    assert "scene.living_room_gateway_" not in text
    assert "move_group" in text  # the card calls the sync-move service


def test_recal_slots_exclude_main_bedroom() -> None:
    cfg = build_panel_config()
    recal = cfg["recal_slots"]
    # every PowerView slot is recalibratable; the RYSE main-bedroom shade is not
    assert "mbr1" not in recal
    assert "lrh1" in recal and "ko1" in recal
    assert len(recal) == len(SHADES) - 1
    assert "DEFAULT_LAYOUT.recal_slots" in CARD_JS.read_text()


def test_groups_resolve_to_entities() -> None:
    cfg = build_panel_config()
    assert len(cfg["groups"]["main_floor"]) == 16
    assert len(cfg["groups"]["upstairs"]) == 6
    assert len(cfg["groups"]["all"]) == 22
    assert cfg["groups"]["main_bedroom"] == ["cover.shade_mbr1"]
    # every group entity is one of the integration's abstraction covers
    mapped = {abstract_entity(slot) for slot in SHADES}
    for entities in cfg["groups"].values():
        assert set(entities) <= mapped


def test_sun_geo_synced_with_card() -> None:
    """The card's sun_geo mirror (strict JSON in DEFAULT_LAYOUT) matches const.py."""
    import json

    from custom_components.shade_dashboard.const import SUN_GEO

    text = CARD_JS.read_text()
    block = re.search(r"sun_geo:\s*(\{.*?\n  \}),", text, re.DOTALL)
    assert block, "could not locate the sun_geo block in DEFAULT_LAYOUT"
    assert json.loads(block.group(1)) == SUN_GEO
    # and the panel config hands the same physics to the card
    assert build_panel_config()["sun_geo"] == SUN_GEO


def test_sun_geo_physics_sane() -> None:
    """Wall normals and viewer geometry as measured for this house."""
    from custom_components.shade_dashboard.const import SUN_GEO

    assert abs(SUN_GEO["lat"] - 39.582804) < 1e-9
    assert abs(SUN_GEO["lon"] - -105.249572) < 1e-9
    walls = SUN_GEO["walls"]
    assert walls["west"]["az"] == 295.0 and walls["south"]["az"] == 201.0
    assert walls["up_west"]["az"] == 295.0  # same face, one storey up
    assert walls["north"]["az"] == 25.0  # west + 90
    for wall in walls.values():
        assert 3 <= wall["viewer_d"] <= 40 and 3 <= wall["eye_h"] <= 7
