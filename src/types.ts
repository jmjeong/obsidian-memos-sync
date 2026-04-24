export interface UrlRewriteRule {
  from: string;
  to: string;
  imageWidth?: number;
}

export interface MemosSettings {
  memosAPIURL: string;
  memosAPIToken: string;
  dailyMemosHeader: string;
  attachmentFolder: string;
  autoSyncOnLoad: boolean;
  syncIntervalMinutes: number;
  urlRewriteRules: UrlRewriteRule[];
  // legacy field from old plugin, ignored
  memosAPIVersion?: string;
}

export const DEFAULT_SETTINGS: MemosSettings = {
  memosAPIURL: "",
  memosAPIToken: "",
  dailyMemosHeader: "Daily Record",
  attachmentFolder: "",
  autoSyncOnLoad: false,
  syncIntervalMinutes: 0,
  urlRewriteRules: [
    {
      from: "https://jmjeong-memos.52214ff3f9d0d5304a4af5986e9ddeb5.r2.cloudflarestorage.com/assets/",
      to: "https://r2.jmjeong.com/assets/",
      imageWidth: 500,
    },
  ],
};

export interface Memo {
  name: string;
  uid: string;
  state: string;
  creator: string;
  createTime: string;
  updateTime: string;
  displayTime: string;
  content: string;
  visibility: string;
  tags: string[];
  pinned: boolean;
  resources?: Resource[];
  attachments?: Resource[];
  property?: MemoProperty;
  snippet?: string;
}

export interface Resource {
  name: string;
  filename: string;
  type: string;
  size: string;
  externalLink: string;
  memo: string;
  createTime?: string;
  content?: string;
}

export interface MemoProperty {
  hasLink: boolean;
  hasTaskList: boolean;
  hasCode: boolean;
  hasIncompleteTasks: boolean;
}

export interface ListMemosResponse {
  memos: Memo[];
  nextPageToken: string;
}

export interface FormattedMemo {
  date: string;
  timestamp: string;
  content: string;
}
