# Changelog

## [1.0.1] - 2026-10-26

- Fix HTTP 400 when syncing from Memos 0.31 by replacing the removed `display_time` sort field with `create_time`.
- Match the incremental pagination cutoff to the API sort order while preserving legacy display times and block IDs.
- Include the existing second sync pass for edits to older memos.
- Add regression tests for pagination, deduplication, edited memos and authenticated attachments.
- Publish verified Obsidian plugin files and SHA-256 checksums through GitHub Releases.

Existing installations should preserve `data.json`, update `main.js` and `manifest.json`, reload the plugin, then run normal sync twice to check for duplicates.
