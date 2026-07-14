---
name: deploy-card
description: Deploy the shade-dashboard card to the live Home Assistant server (both copies + www) with checksum verification and an integration reload. Manual, side-effecting — invoke with /deploy-card.
disable-model-invocation: true
---

# Deploy the shade-dashboard card to the live HA server

Side-effecting: touches the live HA host. Confirm with the user before running
if not already authorized.

Host/SSH access and the HA REST token are NOT in this repo. Read them from agent
memory / the agent-config repo (`home-assistant/access.md`): SSH is
`root@homeassistant.local` (key-based); the long-lived token is in the macOS
Keychain — fetch inline, never echo it:
`security find-generic-password -a "$USER" -s ha_token -w`.

## Steps

1. **Sync + verify locally**
   - `cp custom_components/shade_dashboard/shade-dashboard-card.js shade-dashboard-card.js`
   - `node --check custom_components/shade_dashboard/shade-dashboard-card.js`
   - `diff -q` the two copies → must be byte-identical.
   - `shasum` the local file; note the hash.

2. **Deploy both server targets**
   - `scp` the card to `/config/custom_components/shade_dashboard/shade-dashboard-card.js`
   - `scp` the card to `/config/www/shade-dashboard-card.js` (fallback resource path)

3. **Verify on server**
   - `sha1sum` both server copies → must equal the local hash and each other.
   - Abort and report if any hash mismatches.

4. **Activate**
   - Reload the integration via the HA REST API
     (`POST /api/services/homeassistant/reload_config_entry` with the shade_dashboard
     entry id) using the Keychain token.
   - Note: a config-entry reload does NOT re-stamp the card cache-bust `?v=` query
     (only a full HA restart re-reads the file mtime). Tell the user to hard-refresh
     the browser (Cmd/Ctrl+Shift+R) to pick up the new card.

5. **Report** the local hash, both server hashes (confirm equal), reload HTTP
   status, and the hard-refresh reminder.

Do not restart the whole HA server for a card-only change — reload + hard refresh
is sufficient. A full restart is only needed for Python changes (`__init__.py`,
`const.py`, etc.) and requires explicit user approval.
