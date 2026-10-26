# Upgrade to Memos Sync 1.0.1

Memos 0.28 removed `display_time`. Older plugin bundles request
`orderBy=display_time desc`, causing HTTP 400 after a server upgrade.
Release 1.0.1 queries new memos by `create_time desc` and uses `createTime`
for the pagination cutoff. The existing `update_time` pass still handles edits.
Legacy `displayTime` values remain supported for note dates and block IDs.

## Check the other Mac first

Find the actual LifeOS vault path on that Mac. Do not copy another machine's
absolute path. Syncthing may already have propagated the patched bundle.
Check both `.obsidian/plugins/memos-sync/manifest.json` (version `1.0.1`) and
the bundle hash:

```bash
shasum -a 256 "/path/to/LifeOS/.obsidian/plugins/memos-sync/main.js"
```

Validated bundle SHA-256:

```text
2bca71ffd6013dbe4b660fe8c89c879d270857eb2e320f922834672ec8c0f4bd
```

If the version and hash both match, skip replacement; reload the plugin and
verify sync. If the hash matches but the version is still `1.0.0`, the earlier
local patch is installed; update both release files to keep the installation
consistent. If a newer version is installed, review it before downgrading.

## Download the release

No build tools are needed. Download the files from
[release 1.0.1](https://github.com/jmjeong/obsidian-memos-sync/releases/tag/1.0.1):

```bash
release_dir=$(mktemp -d)
for filename in main.js manifest.json checksums.txt; do
  curl --fail --location \
    "https://github.com/jmjeong/obsidian-memos-sync/releases/download/1.0.1/$filename" \
    --output "$release_dir/$filename" || exit 1
done
(cd "$release_dir" && shasum -a 256 -c checksums.txt) || exit 1
```

### Optional: build from the release tag

In a fresh clone of `https://github.com/jmjeong/obsidian-memos-sync.git`:

```bash
git checkout --detach 1.0.1
npm ci --registry=https://registry.npmjs.org
npm test
npm run typecheck
npm run build
shasum -a 256 main.js
release_dir="$PWD"
```

The lockfile uses public npm URLs so this procedure does not require the
original machine's corporate npm registry. The output should match the hash
above. Investigate a mismatch before installing it.

## Install while preserving settings

Pause automatic sync or disable the plugin while replacing the bundle.
Back up the existing `main.js` and `manifest.json` outside the synced vault,
then copy both release files into `.obsidian/plugins/memos-sync/` using
temporary files and rename. Keep `data.json` unchanged. Do not publish or
attach `data.json`; it contains the API token.

Use the verified `release_dir` from either path above, replacing the vault path:

```bash
set -e
plugin_dir="/path/to/LifeOS/.obsidian/plugins/memos-sync"
expected_sha="2bca71ffd6013dbe4b660fe8c89c879d270857eb2e320f922834672ec8c0f4bd"
test "$(shasum -a 256 "$release_dir/main.js" | cut -d ' ' -f 1)" = "$expected_sha"
test -f "$plugin_dir/main.js"
test -f "$plugin_dir/manifest.json"
test -f "$plugin_dir/data.json"
settings_sha=$(shasum -a 256 "$plugin_dir/data.json" | cut -d ' ' -f 1)
backup_dir=$(mktemp -d "$HOME/.memos-sync-backup.XXXXXX")
chmod 700 "$backup_dir"
cp "$plugin_dir/main.js" "$backup_dir/main.js"
cp "$plugin_dir/manifest.json" "$backup_dir/manifest.json"
cp "$release_dir/main.js" "$plugin_dir/main.js.pending"
cp "$release_dir/manifest.json" "$plugin_dir/manifest.json.pending"
mv "$plugin_dir/main.js.pending" "$plugin_dir/main.js"
mv "$plugin_dir/manifest.json.pending" "$plugin_dir/manifest.json"
shasum -a 256 "$plugin_dir/main.js"
test "$(shasum -a 256 "$plugin_dir/data.json" | cut -d ' ' -f 1)" = "$settings_sha"
```

Restart Obsidian after replacing the release files to refresh its manifest
cache, then enable the plugin if needed. Alternatively, use Obsidian CLI to
refresh the manifests before reloading only this plugin:

```bash
obsidian vault=LifeOS eval 'code=(async()=>{await app.plugins.loadManifests();return app.plugins.manifests["memos-sync"].version;})()'
obsidian vault=LifeOS plugin:reload id=memos-sync
obsidian vault=LifeOS command id=memos-sync:sync-memos
```

If the plugin was disabled, enable it before using its commands.

## Verify on each Mac

- Confirm normal sync completes without API errors.
- Confirm the installed manifest reports version `1.0.1`.
- If there are unsynced memos, confirm they appear once under `Daily Record`.
- Run normal sync again and confirm there are no duplicates or unexpected edits.
- Confirm `Work`, `Personal`, existing block IDs and plugin settings are preserved.
- Each device has its own localStorage cursor; do not assume another Mac's
  successful sync validates this device.

Do not use **Force sync all memos** as the default recovery step.
The previous bundle's `display_time` request remains incompatible with Memos
0.31, so restoring that bundle alone does not fix the original error.
