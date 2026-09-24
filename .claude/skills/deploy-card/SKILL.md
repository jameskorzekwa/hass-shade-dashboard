---
name: deploy-card
description: Deploy the shade-dashboard card to the live Home Assistant server (both copies + www) with checksum verification and an integration reload. Manual, side-effecting — invoke with /deploy-card.
disable-model-invocation: true
---

# Deploy the shade-dashboard card to the live HA server

Side-effecting: touches the live HA host. Confirm with the user before running
if not already authorized.

Read current `home-assistant/access.md` and `home-assistant/gotchas.md` from
agent-config before deployment. Commands execute on bee2, a headless Linux
host, even when the session is displayed on a Mac laptop.

Use `ssh -o BatchMode=yes -o ConnectTimeout=10 ha`. The configured `ha` alias
targets `root@192.168.1.126`, enforces the pinned key in `~/.ssh/ha_known_hosts`,
and lands in the SSH add-on container with `/config` mounted. Keep host-key
checking enabled; do not substitute a raw hostname that loses the pin.

The Core API is `http://192.168.1.126:8123`. Its long-lived token is service
`ha_token`, account `jkorzekwa`, in bee2's live Secret Service on
`unix:path=/run/user/1000/bus`. The requesting process must retrieve and use
the token in memory, or receive it through an approved inherited descriptor.
Never expose it in shell variables, argv, environment, logs, files, or output.
The repository does not ship a credential adapter: use the verified host
consumer from the canonical access procedure, and stop if it is unavailable.
Verify authentication with `GET /api/` before the authorized mutation. The
Supervisor token is not a Core API token.

## Steps

1. **Sync + verify locally**
   - `cp custom_components/shade_dashboard/shade-dashboard-card.js shade-dashboard-card.js`
   - `node --check custom_components/shade_dashboard/shade-dashboard-card.js`
   - `diff -q` the two copies → must be byte-identical.
   - `sha256sum` the local file; note the hash.

2. **Deploy both server targets**
   - Use `scp -o BatchMode=yes -o ConnectTimeout=10` with the pinned `ha` alias.
   - Copy the card to `ha:/config/custom_components/shade_dashboard/shade-dashboard-card.js`.
   - Copy it to `ha:/config/www/shade-dashboard-card.js` (fallback resource path).

3. **Verify on server**
   - Through `ssh ha`, run `sha256sum` on both server copies → must equal the
     local SHA-256 and each other.
   - Abort and report if any hash mismatches.

4. **Activate**
   - Reload the integration via the HA REST API
     (`POST /api/services/homeassistant/reload_config_entry` with the shade_dashboard
     entry id) through the in-process Core API consumer described above.
   - Note: a config-entry reload does NOT re-stamp the card cache-bust `?v=` query
     (only a full HA restart re-reads the file mtime). Tell the user to hard-refresh
     the browser (Cmd/Ctrl+Shift+R) to pick up the new card.

5. **Report** the local hash, both server hashes (confirm equal), reload HTTP
   status, and the hard-refresh reminder.

Do not restart the whole HA server for a card-only change — reload + hard refresh
is sufficient. A full restart is only needed for Python changes (`__init__.py`,
`const.py`, etc.) and requires explicit user approval.
