# Shade Dashboard

A Home Assistant custom integration that adds a **spatial PowerView shade
dashboard** — a wall-panel view whose controls mirror the real window elevations
of the house (including the angled clerestory windows), so it's obvious which
control maps to which physical shade.

It ships a single hand-written Lovelace card and registers it two ways: as a
`shade-dashboard-card` you can drop on any view, **and** as a dedicated **"Shades"
panel** in the sidebar. The card drives the existing PowerView `cover.*` entities
through core cover services — this integration creates no entities of its own.

![design: option 1a — Wall Panel]

## Features

- **Spatial layout** — south wall (chimney, front door, uppers over lowers),
  west wall (4 angled clerestory windows over 4 lowers), north wall, and the
  main-floor hallway, laid out left→right in a **horizontally scrollable strip**
  (the living room is wider than the tablet by design). Plus an **Upstairs** tab
  (hallway + Kyle's office).
- **Live + animated** — each shade's fabric is drawn to its real
  `current_position` from HA and animates (0.45s) on any change.
- **Per-shade control** — tap any window to select it; a control bar slides up
  with a 0–100% slider and Open/Close.
- **Group controls** — per-wall `▲▼` chips and per-floor Open/Close (unavailable
  shades are skipped).
- **Scenes** — Movie Mode (wired to `script.movie_mode`); Sunset / Open All /
  Close All are placeholders until their HA scripts exist (wire them in
  `const.py`).
- **Sun widget** — an arc positioned from the sun's elevation/azimuth, with a
  glare hint driven by the living-room lux sensors.
- **Offline state** — any `unavailable` cover renders hatched with an "OFFLINE"
  marker; its control bar explains the outage instead of showing a slider.

## Install

Via HACS (custom repository → this repo, category *Integration*), then
**Settings → Devices & Services → Add Integration → Shade Dashboard**. One click;
no configuration — the window→entity map is built in (`const.py`). A **Shades**
entry appears in the sidebar.

## Configuration

The window→entity map, groups, scenes, and sun sources live in
`custom_components/shade_dashboard/const.py` (the single source of truth; the
card mirrors it as `DEFAULT_LAYOUT`, guarded by `tests/test_layout_sync.py`).
Edit there and redeploy the card to re-wire.

## Development

- `pip install -r requirements_test.txt`
- `ruff check custom_components/ tests/` · `ruff format custom_components/ tests/`
- `pytest tests/ -v`
- Card iteration on the live server: `/deploy-card` (see `.claude/skills/`).

Standards mirror the other integrations in this account: tests + ruff + CI +
auto-release-on-merge. Every merge to `main` that passes CI cuts a `vX.Y.Z`
release automatically.

