import { App, Notice, TFile, normalizePath } from "obsidian";
import {
  getAllDailyNotes,
  getDailyNote,
  createDailyNote,
} from "obsidian-daily-notes-interface";
import { MemosClient } from "./api";
import {
  Memo,
  MemosSettings,
  Resource,
  FormattedMemo,
  UrlRewriteRule,
} from "./types";

// --- Resource helpers ---

function resourceId(resource: Resource): string {
  // v0.27.1 uses "attachments/{id}", older versions used "resources/{id}"
  return resource.name.replace(/^(attachments|resources)\//, "");
}

function resourceFileName(resource: Resource): string {
  const sanitized = resource.filename.replace(/[/\\?%*:|"<>]/g, "-");
  return `${resourceId(resource)}-${sanitized}`;
}

function generateResourceLink(resource: Resource, rules: UrlRewriteRule[]): string {
  if (!resource.externalLink) {
    return `![[${resourceFileName(resource)}]]`;
  }
  let url = resource.externalLink;
  let alt = resource.filename;
  const isImage = resource.type?.includes("image");
  // Apply URL rewrite rules to external links
  for (const rule of rules) {
    if (!rule.from || !rule.to) continue;
    if (url.includes(rule.from)) {
      url = url.replace(rule.from, rule.to);
      const qIdx = url.indexOf("?");
      if (qIdx !== -1) url = url.substring(0, qIdx);
      if (isImage && rule.imageWidth) {
        alt = `${alt}|${rule.imageWidth}`;
      }
      break;
    }
  }
  const prefix = isImage ? "!" : "";
  return `${prefix}[${alt}](${url})`;
}

// --- URL rewriting ---

function applyUrlRewriteRules(content: string, rules: UrlRewriteRule[]): string {
  let result = content;
  for (const rule of rules) {
    if (!rule.from || !rule.to) continue;
    // Match markdown image links: ![alt](url)
    const imageRegex = /!\[([^\]]*)\]\(([^)]+)\)/g;
    result = result.replace(imageRegex, (match, alt, url) => {
      if (url.includes(rule.from)) {
        let newUrl = url.replace(rule.from, rule.to);
        // Strip query params
        const qIdx = newUrl.indexOf("?");
        if (qIdx !== -1) newUrl = newUrl.substring(0, qIdx);
        const newAlt = rule.imageWidth ? `${alt || "image"}|${rule.imageWidth}` : alt;
        return `![${newAlt}](${newUrl})`;
      }
      return match;
    });
    // Also handle non-image markdown links: [text](url)
    const linkRegex = /\[([^\]]*)\]\(([^)]+)\)/g;
    result = result.replace(linkRegex, (match, text, url) => {
      if (url.includes(rule.from)) {
        let newUrl = url.replace(rule.from, rule.to);
        const qIdx = newUrl.indexOf("?");
        if (qIdx !== -1) newUrl = newUrl.substring(0, qIdx);
        return `[${text}](${newUrl})`;
      }
      return match;
    });
  }
  return result;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// --- Memo formatting (ported from old plugin's transformAPIToMdItemMemo) ---

function formatMemo(
  memo: Memo,
  rules: UrlRewriteRule[]
): FormattedMemo {
  const displayTime = memo.displayTime || memo.createTime;
  const m = window.moment(displayTime);
  const date = m.format("YYYY-MM-DD");
  const time = m.format("HH:mm");
  const timestamp = String(m.unix());

  let content = applyUrlRewriteRules(memo.content.trim(), rules);

  const [firstLine, ...otherLines] = content.split("\n");
  const taskMatch = firstLine.match(/(- \[.?\])(.*)/);
  const isCode = /```/.test(firstLine);

  let targetFirstLine: string;
  const remainingLines = [...otherLines];

  if (taskMatch) {
    targetFirstLine = `${taskMatch[1]} ${time} ${taskMatch[2]}`;
  } else if (isCode) {
    targetFirstLine = `- ${time}`;
    remainingLines.unshift(firstLine);
  } else {
    targetFirstLine = `- ${time} ${firstLine.replace(/^- /, "")}`;
  }

  targetFirstLine += ` #daily-record ^${timestamp}`;

  const targetOtherLine = remainingLines.length
    ? "\n" +
      remainingLines
        .filter((line) => line.trim())
        .map((line) => `\t${line}`)
        .join("\n")
        .trimEnd()
    : "";

  const resources = memo.resources || memo.attachments || [];
  const targetResourceLine = resources.length
    ? "\n" +
      resources
        .map((r) => {
          const link = generateResourceLink(r, rules);
          return `\t- ${link}`;
        })
        .join("\n")
    : "";

  return {
    date,
    timestamp,
    content: targetFirstLine + targetOtherLine + targetResourceLine,
  };
}

// --- Header regex (ported from old plugin) ---

function generateHeaderRegExp(header: string): RegExp {
  const trimmed = header.trim();
  const formattedHeader = /^#+/.test(trimmed) ? trimmed : `## ${trimmed}`;
  return new RegExp(`(${escapeRegExp(formattedHeader)}[^\n]*)([\\s\\S]*?)(?=\n#|$)`);
}

// --- Daily note modification ---
//
// Only memo entries (a "- " line carrying a ^{10-digit} block ID plus its indented
// continuation lines) are replaced in place or inserted in timestamp order.
// Everything else in the section (callouts, comments, marker-managed blocks such
// as <!-- daily-lifelog-agent:start/end -->, hand-written notes) is kept as is.
// The first memo of a day goes before the first <!-- name:start --> block, so
// automation blocks stay below the memo list.

const MEMO_ID = /^- .*\^(\d{10})\s*$/;
const MARKER_START = /^<!--\s*[\w.-]+:start\s*-->\s*$/;

interface MemoEntry {
  id: string;
  start: number; // first line index in body
  end: number; // exclusive
}

function findMemoEntries(lines: string[]): MemoEntry[] {
  const entries: MemoEntry[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(MEMO_ID);
    if (!m) continue;
    let j = i + 1;
    while (j < lines.length && /^\s+\S/.test(lines[j])) j++;
    entries.push({ id: m[1], start: i, end: j });
    i = j - 1;
  }
  return entries;
}

function modifyDailyNote(
  originContent: string,
  header: string,
  fetchedRecords: Record<string, string>
): { content: string; newCount: number; updatedCount: number } | null {
  const reg = generateHeaderRegExp(header);
  const regMatch = originContent.match(reg);

  if (!regMatch?.length || regMatch.index === undefined) {
    return null;
  }

  const localRecordContent = regMatch[2]?.trim() || "";
  // Slice by match offsets: offsets derived from the trimmed length shifted by the
  // number of blank lines under the header and leaked memo characters into the next section.
  const prefix = originContent.slice(0, regMatch.index + regMatch[1].length);
  const suffix = originContent.slice(regMatch.index + regMatch[0].length);

  const lines = localRecordContent ? localRecordContent.split("\n") : [];
  const entries = findMemoEntries(lines);
  const existing: Record<string, string> = {};
  for (const e of entries) {
    if (!(e.id in existing)) existing[e.id] = lines.slice(e.start, e.end).join("\n");
  }

  let newCount = 0;
  let updatedCount = 0;
  for (const [key, value] of Object.entries(fetchedRecords)) {
    if (!(key in existing)) newCount++;
    else if (existing[key] !== value) updatedCount++;
  }

  // Rebuild the body: replace known entries in place, drop duplicate IDs.
  const out: string[] = [];
  const memoLine: boolean[] = [];
  const placed = new Set<string>();
  const push = (text: string, isMemo: boolean) => {
    for (const l of text.split("\n")) {
      out.push(l);
      memoLine.push(isMemo);
    }
  };
  let cursor = 0;
  for (const e of entries) {
    for (; cursor < e.start; cursor++) push(lines[cursor], false);
    cursor = e.end;
    if (placed.has(e.id)) continue;
    placed.add(e.id);
    push(fetchedRecords[e.id] ?? lines.slice(e.start, e.end).join("\n"), true);
  }
  for (; cursor < lines.length; cursor++) push(lines[cursor], false);

  // Insert new memos in timestamp order.
  const newIds = Object.keys(fetchedRecords)
    .filter((id) => !placed.has(id))
    .sort((a, b) => Number(a) - Number(b));
  for (const id of newIds) {
    const current = findMemoEntries(out);
    let at: number;
    const after = current.find((e) => Number(e.id) > Number(id));
    if (after) at = after.start;
    else if (current.length) at = current[current.length - 1].end;
    else {
      const marker = out.findIndex((l) => MARKER_START.test(l));
      at = marker >= 0 ? marker : out.length;
    }
    const block = fetchedRecords[id].split("\n");
    const before = at > 0 ? out[at - 1] : "";
    const next = at < out.length ? out[at] : "";
    const ins: string[] = [];
    if (before.trim() && !(at > 0 && memoLine[at - 1])) ins.push("");
    ins.push(...block);
    if (next.trim() && !(at < out.length && memoLine[at])) ins.push("");
    out.splice(at, 0, ...ins);
    memoLine.splice(at, 0, ...ins.map((l) => l !== "" || false));
  }

  const body = out.join("\n").trim();
  const content = prefix.trim() + `\n\n${body}\n\n` + suffix.trim() + "\n";
  return { content, newCount, updatedCount };
}

// --- Sync orchestrator ---

export class MemosSyncer {
  private client: MemosClient;
  private storageKey: string;

  constructor(
    private app: App,
    private settings: MemosSettings
  ) {
    this.client = new MemosClient(settings.memosAPIURL, settings.memosAPIToken);
    // Device-local sync state keyed by token prefix
    this.storageKey = `memos-sync-last-time-${settings.memosAPIToken.substring(0, 8)}`;
  }

  private getLastSyncTime(): number {
    const stored = localStorage.getItem(this.storageKey);
    return stored ? Number(stored) : 0;
  }

  private setLastSyncTime(ts: number): void {
    localStorage.setItem(this.storageKey, String(ts));
  }

  async testConnection(): Promise<string> {
    const user = await this.client.getMe();
    return user.displayName || user.username || user.name;
  }

  private async collectMemos(
    fetcher: (pageSize: number, pageToken?: string) => Promise<import("./types").ListMemosResponse>,
    lastSyncTime: number,
    forceAll: boolean,
    timeField: "createTime" | "updateTime",
    memosByDate: Record<string, Record<string, string>>,
    resourcesToDownload: Resource[]
  ): Promise<number> {
    let newestTimestamp = lastSyncTime;
    let pageToken: string | undefined;
    let done = false;

    while (!done) {
      const resp = await fetcher(50, pageToken);
      const memos = resp.memos || [];
      if (!memos.length) break;

      for (const memo of memos) {
        if (memo.state && memo.state !== "NORMAL") continue;

        // The cutoff must use the same field as the API's sort order.
        const timeValue = memo[timeField];
        const memoTs = window.moment(timeValue).unix();

        if (memoTs <= lastSyncTime && !forceAll) {
          done = true;
          break;
        }

        const formatted = formatMemo(memo, this.settings.urlRewriteRules);

        if (!memosByDate[formatted.date]) {
          memosByDate[formatted.date] = {};
        }
        memosByDate[formatted.date][formatted.timestamp] = formatted.content;

        const memoResources = memo.resources || memo.attachments || [];
        for (const r of memoResources) {
          if (!r.externalLink) {
            resourcesToDownload.push(r);
          }
        }

        if (memoTs > newestTimestamp) {
          newestTimestamp = memoTs;
        }
      }

      pageToken = resp.nextPageToken;
      if (!pageToken) break;
    }

    return newestTimestamp;
  }

  async sync(forceAll = false): Promise<{ newCount: number; updatedCount: number }> {
    const lastSyncTime = forceAll ? 0 : this.getLastSyncTime();

    const memosByDate: Record<string, Record<string, string>> = {};
    const resourcesToDownload: Resource[] = [];

    // Pass 1: fetch new memos by createTime (display_time was removed in v0.28).
    const newestCreateTime = await this.collectMemos(
      (ps, pt) => this.client.listMemos(ps, pt),
      lastSyncTime, forceAll, "createTime",
      memosByDate, resourcesToDownload
    );

    // Pass 2: fetch updated memos by updateTime
    const newestUpdateTime = await this.collectMemos(
      (ps, pt) => this.client.listMemosByUpdateTime(ps, pt),
      lastSyncTime, forceAll, "updateTime",
      memosByDate, resourcesToDownload
    );

    // Download attachments
    await this.downloadResources(resourcesToDownload);

    // Write to daily notes
    let totalNew = 0;
    let totalUpdated = 0;
    const allDailyNotes = getAllDailyNotes();
    for (const [date, records] of Object.entries(memosByDate)) {
      const result = await this.writeToDailyNote(date, records, allDailyNotes);
      totalNew += result.newCount;
      totalUpdated += result.updatedCount;
    }

    const newestTimestamp = Math.max(newestCreateTime, newestUpdateTime);
    if (newestTimestamp > lastSyncTime) {
      this.setLastSyncTime(newestTimestamp);
    }

    return { newCount: totalNew, updatedCount: totalUpdated };
  }

  private async writeToDailyNote(
    date: string,
    records: Record<string, string>,
    allDailyNotes: Record<string, TFile>
  ): Promise<{ newCount: number; updatedCount: number }> {
    const moment = window.moment(date, "YYYY-MM-DD");
    let dailyNote = getDailyNote(moment, allDailyNotes);

    if (!dailyNote) {
      try {
        dailyNote = await createDailyNote(moment);
      } catch (e) {
        new Notice(`Failed to create daily note for ${date}: ${e}`);
        return { newCount: 0, updatedCount: 0 };
      }
    }

    let newCount = 0;
    let updatedCount = 0;
    await this.app.vault.process(dailyNote, (content) => {
      const result = modifyDailyNote(
        content,
        this.settings.dailyMemosHeader,
        records
      );
      if (result === null) {
        new Notice(
          `Failed to find header "${this.settings.dailyMemosHeader}" in ${date} daily note.`
        );
        return content;
      }
      newCount = result.newCount;
      updatedCount = result.updatedCount;
      return result.content;
    });
    return { newCount, updatedCount };
  }

  private async downloadResources(resources: Resource[]): Promise<void> {
    if (!resources.length) return;

    const folder = this.settings.attachmentFolder || "Attachments";
    const folderPath = normalizePath(folder);

    // Ensure folder exists
    if (!this.app.vault.getAbstractFileByPath(folderPath)) {
      try {
        await this.app.vault.createFolder(folderPath);
      } catch {
        // Folder may have been created concurrently
      }
    }

    for (const resource of resources) {
      const fileName = resourceFileName(resource);
      const filePath = normalizePath(`${folderPath}/${fileName}`);

      // Skip if already exists
      if (this.app.vault.getAbstractFileByPath(filePath)) continue;

      try {
        const data = await this.client.fetchResourceBinary(resource);
        await this.app.vault.createBinary(filePath, data);
      } catch (e) {
        console.warn(`Failed to download resource ${resource.name}: ${e}`);
      }
    }
  }
}
