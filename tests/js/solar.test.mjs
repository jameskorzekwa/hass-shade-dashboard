// Solar-math tests for the card's sun simulation.
//
// Reference azimuth/elevation values were computed independently (NOAA solar
// position algorithm in Python) and cross-checked against the sun2
// integration's live sensors for this house on 2026-07-14 (19:53 MDT sensor
// read: az 293.70 / el 5.4). The card module is imported through a data: URL
// so Node treats it as ESM without needing a package.json; browser-only
// registration is skipped via typeof guards inside the module.
//
// Run: node --test tests/js

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const cardPath = fileURLToPath(
  new URL("../../custom_components/shade_dashboard/shade-dashboard-card.js", import.meta.url)
);
const src = await readFile(cardPath);
const cardSource = src.toString();
const { loadDevicePreferences, loadSessionFloor, normalizeDevicePreferences, resolveSelectableFloor, skyPalette, solarPos, sunOnWall } = await import(
  "data:text/javascript;base64," + src.toString("base64")
);

const LAT = 39.582804;
const LON = -105.249572;
const close = (got, want, tol, label) =>
  assert.ok(Math.abs(got - want) <= tol, `${label}: got ${got.toFixed(2)}, want ${want} ±${tol}`);

test("matches the sun2 sensors at the calibration-photo evening", () => {
  // 19:53 MDT — sensors read az 293.70 / el 5.4 moments earlier
  const p = solarPos(Date.UTC(2026, 6, 15, 1, 53), LAT, LON);
  close(p.az, 293.76, 0.25, "az @19:53");
  close(p.el, 5.37, 0.25, "el @19:53");
  // 19:58 MDT — the photo: sun almost exactly on the west wall normal (295)
  const q = solarPos(Date.UTC(2026, 6, 15, 1, 58), LAT, LON);
  close(q.az, 294.52, 0.25, "az @photo");
  close(q.el, 4.52, 0.25, "el @photo");
});

test("winter solstice noon (south-wall season)", () => {
  const p = solarPos(Date.UTC(2026, 11, 21, 19, 0), LAT, LON); // 12:00 MST
  close(p.az, 180.2, 0.3, "az dec noon");
  close(p.el, 27.0, 0.3, "el dec noon");
});

test("summer morning sanity", () => {
  const p = solarPos(Date.UTC(2026, 6, 14, 17, 0), LAT, LON); // 11:00 MDT
  close(p.az, 114.2, 0.3, "az 11am");
  close(p.el, 57.6, 0.3, "el 11am");
});

test("photo projection lands the sun in lower bay 2 (l4), upper glass", () => {
  // West wall viewer calibrated from the 2026-07-14 19:58 photo.
  const west = { az: 295.0, viewer_x: 8.34, viewer_d: 18.0, eye_h: 5.4 };
  const { az, el } = solarPos(Date.UTC(2026, 6, 15, 1, 58), LAT, LON);
  const p = sunOnWall(west, az, el);
  assert.equal(p.behind, false);
  assert.ok(p.x > 5.05 && p.x < 9.2, `x ${p.x.toFixed(2)} within bay 2 (5.05..9.2)`);
  assert.ok(p.z > 6.2 && p.z < 7.4, `z ${p.z.toFixed(2)} in the upper part of the lower glass`);
});

test("sun behind a wall is flagged", () => {
  const west = { az: 295.0, viewer_x: 8.34, viewer_d: 18.0, eye_h: 5.4 };
  const morning = solarPos(Date.UTC(2026, 6, 14, 14, 0), LAT, LON); // 8:00 MDT, ENE sun
  assert.equal(sunOnWall(west, morning.az, morning.el).behind, true);
});

test("blue hour overtakes the clear sky before cloud warmth fades", () => {
  const sunset = skyPalette(0);
  const earlyTwilight = skyPalette(-2.5);
  const lateTwilight = skyPalette(-5);

  assert.ok(earlyTwilight.twilight > 0.55, "open sky should turn substantially blue soon after sunset");
  assert.ok(earlyTwilight.skyWarm < sunset.skyWarm * 0.2, "warm sky wash should fall away quickly");
  assert.ok(earlyTwilight.cloudWarm > 0.7, "clouds should retain strong orange light during early blue hour");
  assert.ok(lateTwilight.cloudWarm > lateTwilight.skyWarm * 10, "cloud color should outlast the warm sky");
  assert.ok(lateTwilight.cloudAlpha > 0.2, "orange cloud banks should remain visible against deep twilight");
});

test("sun test shade controls are simulation-only", () => {
  assert.equal((cardSource.match(/data-suntest-shades=/g) || []).length, 2);
  assert.match(cardSource, /this\._sunTest\.shadePos = button\.getAttribute/);
  assert.doesNotMatch(cardSource, /data-group="all" data-dir="(?:up|down)" title="(?:Open|Close) every shade"/);
});

test("settings buttons use the Home Assistant Material Design icon", () => {
  assert.equal((cardSource.match(/<ha-icon icon="mdi:cog"/g) || []).length, 2);
  assert.doesNotMatch(cardSource, /⚙/);
});

test("sun test offers display-independent playback speeds", () => {
  assert.match(cardSource, /data-suntest-speed[\s\S]*value="96">Fast[\s\S]*value="24">Medium[\s\S]*value="6">Slow/);
  assert.match(cardSource, /t\.min \+ \(t\.speed \|\| 96\) \* dt/);
});

test("device preferences normalize defaults and forward-compatible hidden groups", () => {
  assert.deepEqual(normalizeDevicePreferences(null), { defaultFloor: "main", hiddenGroups: [] });
  assert.deepEqual(
    normalizeDevicePreferences({ defaultFloor: "up", hiddenGroups: ["west", "office", "west", "unknown"] }),
    { defaultFloor: "up", hiddenGroups: ["west", "office"] }
  );
});

test("device preferences and refresh floor tolerate unavailable or corrupt storage", () => {
  const values = new Map([
    ["shade-dashboard:device-preferences:v1", "{bad"],
    ["shade-dashboard:active-floor:v1", "up"],
  ]);
  const storage = { getItem: (key) => values.get(key) || null };
  assert.deepEqual(loadDevicePreferences(storage), { defaultFloor: "main", hiddenGroups: [] });
  assert.equal(loadSessionFloor(storage), "up");
  assert.equal(loadSessionFloor({ getItem: () => "settings" }), null);
  assert.deepEqual(loadDevicePreferences({ getItem: () => { throw new Error("blocked"); } }), { defaultFloor: "main", hiddenGroups: [] });
});

test("settings expose device floor and per-group visibility controls", () => {
  const groups = ["south", "west", "north", "hallway", "main_bedroom", "upstairs_hallway", "office"];
  assert.match(cardSource, /data-pref-default-floor/);
  assert.match(cardSource, /data-pref-group="\$\{group\}"/);
  assert.deepEqual(normalizeDevicePreferences({ hiddenGroups: groups }).hiddenGroups, groups);
  assert.match(cardSource, /this\._tab === "settings"[\s\S]*this\._settingsReturnTab/);
});

test("floors with no visible groups are not selectable", () => {
  const mainHidden = { defaultFloor: "main", hiddenGroups: ["south", "west", "north", "hallway"] };
  assert.equal(normalizeDevicePreferences(mainHidden).defaultFloor, "up");
  assert.equal(resolveSelectableFloor(mainHidden, "main"), "up");
  const allHidden = { hiddenGroups: ["south", "west", "north", "hallway", "main_bedroom", "upstairs_hallway", "office"] };
  assert.equal(resolveSelectableFloor(allHidden, "main", "up"), null);
  assert.match(cardSource, /tab\.style\.display = disabled \? "none" : ""/);
});

test("main-floor groups align with the lower window row", () => {
  for (const [group, variable] of [["south", "south"], ["west", "west"], ["north", "north"], ["hallway", "hallway"]]) {
    assert.match(cardSource, new RegExp(`viewGroup\\("${group}", ${variable}, "flex-end"\\)`));
  }
});

test("clouds retain date-and-window seeded painterly geometry", () => {
  assert.match(cardSource, /date\.getFullYear\(\) \* 366/);
  assert.match(cardSource, /slot\.charCodeAt\(i\)/);
  assert.match(cardSource, /const n = 2 \+ Math\.floor\(rng\(\) \* 2\)/);
  assert.doesNotMatch(cardSource, /data-clouds=/);
});

test("sunset palette follows the real sky color progression", () => {
  const rgb = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
  const warmth = (h) => rgb(h)[0] - rgb(h)[2]; // red minus blue
  const lum = (h) => { const [r, g, b] = rgb(h); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
  const day = skyPalette(10), peak = skyPalette(-1.5), late = skyPalette(-3.5), blue = skyPalette(-5.5);
  assert.ok(lum(day.hor) > 180, "daytime horizon stays bright and neutral");
  assert.ok(warmth(peak.hor) > 100, "afterglow horizon should burn orange-red");
  assert.ok(warmth(peak.zen) < 0, "zenith stays cool while the horizon burns");
  assert.ok(lum(peak.mid) > lum(peak.zen), "the sky brightens toward the sunset horizon");
  assert.ok(lum(blue.zen) < 60 && warmth(blue.zen) < -20, "blue hour zenith turns deep blue");
  assert.ok(warmth(late.cloudHi.lit) > warmth(late.cloudLo.lit), "high clouds hold warm light longest");
});

test("cloud banks render lit rims, silhouette bodies, and back-glow", () => {
  assert.match(cardSource, /const puffs = big \? 3 \+ Math\.floor\(rng\(\) \* 2\) : 2/);
  assert.match(cardSource, /band\("glow", alt\)/);
  assert.match(cardSource, /<stop offset="\.55"/);
});
