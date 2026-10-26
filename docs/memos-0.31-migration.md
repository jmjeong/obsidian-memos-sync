# Memos 0.31 compatibility patch

Memos 0.28 removed `display_time`. Older plugin bundles request
`orderBy=display_time desc`, causing HTTP 400 after a server upgrade.
This patch queries new memos by `create_time desc` and uses `createTime`
for the pagination cutoff. The existing `update_time` pass still handles edits.
Legacy `displayTime` values remain supported for note dates and block IDs.

## Check the other Mac first

Find the actual LifeOS vault path on that Mac. Do not copy another machine's
absolute path. Syncthing may already have propagated the patched bundle.
The manifest version remains `1.0.0`, so check the bundle hash:

```bash
shasum -a 256 "/path/to/LifeOS/.obsidian/plugins/memos-sync/main.js"
```

Validated bundle SHA-256:

```text
2bca71ffd6013dbe4b660fe8c89c879d270857eb2e320f922834672ec8c0f4bd
```

If it matches, skip the build and replacement steps; reload the plugin and
verify sync. If a newer bundle is installed, review its source before replacing
it with this patch.

## Build from the pinned commit

Use the exact compatibility commit linked in the tracking issue. In a fresh
checkout of `https://github.com/jmjeong/obsidian-memos-sync.git`:

```bash
git checkout --detach <compatibility-commit>
npm ci --registry=https://registry.npmjs.org
node --test tests/memos-sync.test.cjs
npx --no-install tsc --noEmit
npm run build
shasum -a 256 main.js
```

The lockfile uses public npm URLs so this procedure does not require the
original machine's corporate npm registry. The output should match the hash
above. Investigate a mismatch before installing it.

## Install while preserving settings

Pause automatic sync or disable the plugin while replacing the bundle.
Back up the existing `main.js` outside the synced vault, then copy only the
built `main.js` into `.obsidian/plugins/memos-sync/` using a temporary file
and rename. Keep `manifest.json` and `data.json` unchanged. Do not publish
or attach `data.json`; it contains the API token.

For example, run this in the verified source checkout, replacing the vault path:

```bash
set -e
plugin_dir="/path/to/LifeOS/.obsidian/plugins/memos-sync"
expected_sha="2bca71ffd6013dbe4b660fe8c89c879d270857eb2e320f922834672ec8c0f4bd"
test "$(shasum -a 256 main.js | cut -d ' ' -f 1)" = "$expected_sha"
test -f "$plugin_dir/main.js"
test -f "$plugin_dir/data.json"
settings_sha=$(shasum -a 256 "$plugin_dir/data.json" | cut -d ' ' -f 1)
backup_dir=$(mktemp -d "$HOME/.memos-sync-backup.XXXXXX")
chmod 700 "$backup_dir"
cp "$plugin_dir/main.js" "$backup_dir/main.js"
cp main.js "$plugin_dir/main.js.pending"
mv "$plugin_dir/main.js.pending" "$plugin_dir/main.js"
shasum -a 256 "$plugin_dir/main.js"
test "$(shasum -a 256 "$plugin_dir/data.json" | cut -d ' ' -f 1)" = "$settings_sha"
```

Reload with Obsidian CLI, or enable/reload the plugin in Obsidian settings:

```bash
obsidian vault=LifeOS plugin:reload id=memos-sync
obsidian vault=LifeOS command id=memos-sync:sync-memos
```

If the plugin was disabled, enable it before using its commands.

## Verify on each Mac

- Confirm normal sync completes without API errors.
- If there are unsynced memos, confirm they appear once under `Daily Record`.
- Run normal sync again and confirm there are no duplicates or unexpected edits.
- Confirm `Work`, `Personal`, existing block IDs and plugin settings are preserved.
- Each device has its own localStorage cursor; do not assume another Mac's
  successful sync validates this device.

Do not use **Force sync all memos** as the default recovery step.
The previous bundle's `display_time` request remains incompatible with Memos
0.31, so restoring that bundle alone does not fix the original error.
