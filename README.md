# Memos Sync for Obsidian

Sync memos from [Memos](https://github.com/usememos/memos) (v0.27.1) to your Obsidian daily notes. One-way sync — Memos → Obsidian.

## Features

- **Incremental sync** — only fetches new memos since last sync
- **Force sync** — re-sync all memos from scratch
- **Auto sync** — sync on Obsidian startup and/or at a configurable interval
- **Daily note integration** — inserts memos under a configurable heading (e.g. `## Daily Record`)
- **Block ID dedup** — each memo gets a `^{unix_timestamp}` block ID to prevent duplicates
- **Attachment download** — downloads non-external resources to your vault
- **Image URL shortening** — rewrites long storage URLs (e.g. Cloudflare R2 signed URLs) to short public URLs with optional image width

## Memo Format

Memos are formatted as list items under the configured heading in your daily notes:

```markdown
## Daily Record

- 09:30 Had a great meeting today #daily-record ^1714012200
	- Follow up on action items
	- ![[abc123-photo.jpg]]
- 14:15 - [x] Completed the report #daily-record ^1714029300
```

- Time prefix (`HH:mm`) from the memo's display time
- Task items (`- [ ]`, `- [x]`) are preserved
- Continuation lines are tab-indented
- Attachments appear as indented wikilinks or markdown links
- `#daily-record` tag and `^{timestamp}` block ID appended to first line

## Installation

### Manual

1. Download `main.js` and `manifest.json` from the [latest release](https://github.com/jmjeong/obsidian-memos-sync/releases)
2. Create a folder `memos-sync` in your vault's `.obsidian/plugins/` directory
3. Copy `main.js` and `manifest.json` into that folder
4. Restart Obsidian and enable "Memos Sync" in Settings → Community Plugins

### Build from Source

```bash
git clone https://github.com/jmjeong/obsidian-memos-sync.git
cd obsidian-memos-sync
npm install
npm run build
```

Copy `main.js` and `manifest.json` to your plugin directory, or set `OBSIDIAN_PLUGIN_DIR` and run:

```bash
npm run deploy
```

## Configuration

Open Settings → Memos Sync.

### Connection

| Setting | Description |
|---------|-------------|
| **Server URL** | Your Memos server address (e.g. `https://memo.example.com`) |
| **Access token** | Generate in Memos: Settings → Access Tokens. Connection is auto-tested when you enter the token. |

### Sync

| Setting | Description |
|---------|-------------|
| **Auto sync on startup** | Sync when Obsidian opens |
| **Sync interval** | Run sync periodically in background (minutes, 0 to disable) |

### Daily Notes

| Setting | Description |
|---------|-------------|
| **Section header** | Heading in daily notes where memos are inserted (e.g. `Daily Record` matches `## Daily Record`) |
| **Attachment folder** | Where to save downloaded files (relative to vault root) |

### Image URL Shortening

Memos may store images with long storage URLs (e.g. Cloudflare R2 signed URLs). You can add rules to replace long URL prefixes with shorter public ones. Each rule has:

- **Find** — long URL prefix from Memos storage
- **Replace with** — short public URL
- **Image width** — optional, resizes images in Obsidian (e.g. `500`)

## Commands

- **Sync memos** — incremental sync (new memos since last sync)
- **Force sync all memos** — re-fetch and re-sync all memos

## Compatibility

- **Memos**: v0.27.1 (REST API via gRPC-Gateway)
- **Obsidian**: 1.5.0+
- Works with the [Periodic Notes](https://github.com/liamcain/obsidian-periodic-notes) plugin for daily note management

## License

MIT
