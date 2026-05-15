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

// --- Daily note modification (ported from old plugin's DailyNoteModifier) ---

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
  const from = regMatch.index + regMatch[1].length + 1;
  const to = from + localRecordContent.length + 1;
  const prefix = originContent.slice(0, from);
  const suffix = originContent.slice(to);

  // Parse existing entries by ^{timestamp} block IDs
  const localRecordList = localRecordContent
    ? localRecordContent.split(/\n(?=- )/)
    : [];
  const existedRecords: Record<string, string> = {};
  for (const record of localRecordList) {
    const match = record.match(/.*\^(\d{10})/);
    if (match?.[1]) {
      existedRecords[match[1].trim()] = record;
    }
  }

  // Count new and updated memos
  let newCount = 0;
  let updatedCount = 0;
  for (const [key, value] of Object.entries(fetchedRecords)) {
    if (!(key in existedRecords)) {
      newCount++;
    } else if (existedRecords[key] !== value) {
      updatedCount++;
    }
  }

  // Merge: fetched overwrites existing with same timestamp
  const merged = { ...existedRecords, ...fetchedRecords };

  const sortedContent = Object.entries(merged)
    .sort((a, b) => Number(a[0]) - Number(b[0]))
    .map(([, content]) => content)
    .join("\n");

  const content = prefix.trim() + `\n\n${sortedContent}\n\n` + suffix.trim() + "\n";
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
    timeField: "displayTime" | "updateTime",
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

        const timeValue = timeField === "updateTime"
          ? memo.updateTime
          : (memo.displayTime || memo.createTime);
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

    // Pass 1: fetch new memos by displayTime
    const newestDisplayTime = await this.collectMemos(
      (ps, pt) => this.client.listMemos(ps, pt),
      lastSyncTime, forceAll, "displayTime",
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

    const newestTimestamp = Math.max(newestDisplayTime, newestUpdateTime);
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
