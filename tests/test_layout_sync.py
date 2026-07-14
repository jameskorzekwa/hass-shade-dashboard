"""Guard the JS card's DEFAULT_LAYOUT against drift from const.py.

const.py is the single source of truth for the window -> entity map. The card
carries a mirror (DEFAULT_LAYOUT) so it also works standalone. This test fails
loudly if the two diverge.
"""

from __future__ import annotations

import re
from pathlib import Path

from custom_components.shade_dashboard.const import (
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


def test_group_scenes() -> None:
    cfg = build_panel_config()
    gs = cfg["group_scenes"]
    # west composes the clean upper+lower sub-scenes (avoids the polluted "West")
    assert gs["west"]["open"] == [
        "scene.living_room_gateway_west_upper_open",
        "scene.living_room_gateway_west_lower_open",
    ]
    # upstairs close avoids the uh2-missing scene; bedroom handled directly via
    # its abstraction cover
    assert gs["upstairs"]["direct"] == ["cover.shade_mbr1"]
    assert gs["all"]["open"] == ["scene.living_room_gateway_open_all_shades"]
    assert "west_upper_open" in CARD_JS.read_text()


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
