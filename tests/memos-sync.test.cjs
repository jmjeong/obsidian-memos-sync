const assert = require("node:assert/strict");
const { test } = require("node:test");
const path = require("node:path");
const vm = require("node:vm");
const esbuild = require("esbuild");
const moment = require("moment");

function load(entry, mocks = {}, globals = {}) {
  const { outputFiles } = esbuild.buildSync({
    entryPoints: [path.join(__dirname, "..", "src", entry)],
    bundle: true,
    write: false,
    platform: "node",
    format: "cjs",
    external: ["obsidian", "obsidian-daily-notes-interface"],
  });
  const module = { exports: {} };
  vm.runInNewContext(outputFiles[0].text, {
    module,
    exports: module.exports,
    require: (name) => {
      if (!(name in mocks)) throw new Error(`Unexpected import: ${name}`);
      return mocks[name];
    },
    URLSearchParams,
    console,
    window: { moment },
    ...globals,
  });
  return module.exports;
}

function memo(overrides = {}) {
  return {
    name: "memos/example",
    state: "NORMAL",
    creator: "users/example",
    createTime: "2026-10-26T01:00:00Z",
    updateTime: "2026-10-26T01:00:00Z",
    content: "Example memo",
    attachments: [],
    ...overrides,
  };
}

test("listMemos uses the supported creation order and preserves pagination", async () => {
  const requests = [];
  const { MemosClient } = load("api.ts", {
    obsidian: {
      requestUrl: async (req) => {
        requests.push(req);
        const url = new URL(req.url);
        assert.equal(url.searchParams.get("orderBy"), "create_time desc");
        return { json: { memos: [memo()], nextPageToken: "next" } };
      },
    },
  });
  const client = new MemosClient("https://memos.example", "test-token");
  const first = await client.listMemos(50);
  assert.equal(first.memos[0].name, "memos/example");
  await client.listMemos(50, first.nextPageToken);
  const secondUrl = new URL(requests[1].url);
  assert.equal(secondUrl.searchParams.get("pageSize"), "50");
  assert.equal(secondUrl.searchParams.get("pageToken"), "next");
});

test("private attachments retain token authentication and binary data", async () => {
  const bytes = new Uint8Array([137, 80, 78, 71]).buffer;
  const { MemosClient } = load("api.ts", {
    obsidian: {
      requestUrl: async (req) => {
        assert.equal(req.url, "https://memos.example/file/attachments/image/photo.png");
        assert.equal(req.headers.Authorization, "Bearer test-token");
        return { arrayBuffer: bytes };
      },
    },
  });
  const client = new MemosClient("https://memos.example", "test-token");
  const result = await client.fetchResourceBinary({ name: "attachments/image", filename: "photo.png" });
  assert.equal(result, bytes);
});

function syncerWithPages(pages, initialTime = 0, initialNote = "## Daily Record\n\n## Personal\n\n- Keep this section.\n") {
  const notes = new Map();
  const state = new Map();
  const requests = [];
  const { MemosSyncer } = load("sync.ts", {
    obsidian: {
      Notice: class {},
      normalizePath: (p) => p,
      requestUrl: async (req) => {
        const url = new URL(req.url);
        requests.push(url);
        const key = `${url.searchParams.get("orderBy")}:${url.searchParams.get("pageToken") || ""}`;
        return { json: pages[key] || { memos: [], nextPageToken: "" } };
      },
    },
    "obsidian-daily-notes-interface": {
      getAllDailyNotes: () => ({}),
      getDailyNote: (date) => {
        const name = date.format("YYYY-MM-DD");
        if (!notes.has(name)) notes.set(name, initialNote);
        return { path: name };
      },
    },
  }, {
    localStorage: {
      getItem: (key) => state.get(key) ?? (initialTime ? String(initialTime) : null),
      setItem: (key, value) => state.set(key, value),
    },
  });
  const app = {
    vault: {
      process: async (file, modify) => notes.set(file.path, modify(notes.get(file.path))),
    },
  };
  const syncer = new MemosSyncer(app, {
    memosAPIURL: "https://memos.example",
    memosAPIToken: "test-token",
    dailyMemosHeader: "Daily Record",
    urlRewriteRules: [],
  });
  return { syncer, notes, state, requests };
}

test("v0.31 memos without displayTime sync across pages and remain idempotent", async () => {
  const latest = memo();
  const earlier = memo({ name: "memos/earlier", createTime: "2026-10-25T01:00:00Z", updateTime: "2026-10-25T01:00:00Z" });
  const { syncer, notes, requests } = syncerWithPages({
    "create_time desc:": { memos: [latest], nextPageToken: "page-2" },
    "create_time desc:page-2": { memos: [earlier], nextPageToken: "" },
    "update_time desc:": { memos: [latest, earlier], nextPageToken: "" },
  });
  const first = await syncer.sync();
  assert.equal(first.newCount, 2);
  assert.equal(notes.size, 2);
  assert.ok(requests.some((r) => r.searchParams.get("pageToken") === "page-2"));
  for (const content of notes.values()) {
    assert.match(content, /#daily-record \^\d{10}/);
    assert.match(content, /## Personal\n\n- Keep this section\.\n$/);
  }
  const snapshot = [...notes];
  const second = await syncer.sync();
  assert.equal(second.newCount, 0);
  assert.equal(second.updatedCount, 0);
  assert.deepEqual([...notes], snapshot);
});

test("creation-order cutoff does not use a legacy displayTime", async () => {
  const cutoff = moment("2026-10-25T12:00:00Z").unix();
  const { syncer, notes } = syncerWithPages({
    "create_time desc:": {
      memos: [memo({ displayTime: "2026-10-24T01:00:00Z", updateTime: "2026-10-24T01:00:00Z" })],
      nextPageToken: "",
    },
  }, cutoff);
  const result = await syncer.sync();
  assert.equal(result.newCount, 1);
  assert.ok(notes.get("2026-10-24"), "Keep legacy display time for existing block IDs");
});

test("editing an older memo updates its existing block without duplicating it", async () => {
  const original = memo();
  const edited = memo({ content: "Edited memo", updateTime: "2026-10-26T02:00:00Z" });
  const pages = {
    "create_time desc:": { memos: [original], nextPageToken: "" },
    "update_time desc:": { memos: [original], nextPageToken: "" },
  };
  const { syncer, notes } = syncerWithPages(pages);
  await syncer.sync();
  pages["update_time desc:"].memos = [edited];
  const result = await syncer.sync();
  assert.equal(result.newCount, 0);
  assert.equal(result.updatedCount, 1);
  const content = [...notes.values()][0];
  assert.match(content, /Edited memo/);
  assert.equal((content.match(/#daily-record/g) || []).length, 1);
});

test("falls back to /api/v1 on older servers and remembers the prefix", async () => {
  const urls = [];
  const { MemosClient } = load("api.ts", {
    obsidian: {
      requestUrl: async (req) => {
        urls.push(new URL(req.url).pathname);
        if (!req.url.includes("/api/v1/")) throw new Error("404");
        return { json: { memos: [memo()] } };
      },
    },
  });
  const client = new MemosClient("https://memos.example", "test-token");
  await client.listMemos(1);
  await client.listMemos(1);
  assert.deepEqual(urls, ["/api/memos", "/api/v1/memos", "/api/v1/memos"]);
});

const LIFELOG_NOTE = [
  "## Daily Record",
  "",
  "> [!health] Garmin Health",
  "> Steps: 3,478",
  "",
  "%%Your Record%%",
  "",
  "<!-- daily-lifelog-agent:start -->",
  "",
  "- 오늘의 실제 기록: 점심",
  "- Source: Calendar",
  "",
  "<!-- daily-lifelog-agent:end -->",
  "",
  "## Work",
  "",
  "- Keep this section.",
  "",
].join("\n");

function dailyRecord(content) {
  return content.split("## Work")[0];
}

test("first memo of a day keeps callouts and lands above marker blocks", async () => {
  const { syncer, notes } = syncerWithPages({
    "create_time desc:": { memos: [memo()], nextPageToken: "" },
  }, 0, LIFELOG_NOTE);
  const result = await syncer.sync();
  assert.equal(result.newCount, 1);
  const section = dailyRecord([...notes.values()][0]);
  assert.match(section, /> \[!health\] Garmin Health\n> Steps: 3,478\n\n%%Your Record%%\n\n- \d\d:\d\d Example memo #daily-record \^\d{10}\n\n<!-- daily-lifelog-agent:start -->/);
  assert.match(section, /- 오늘의 실제 기록: 점심\n- Source: Calendar\n\n<!-- daily-lifelog-agent:end -->\n\n$/);
  assert.match([...notes.values()][0], /## Work\n\n- Keep this section\.\n$/);
});

test("later memos join the memo list in time order without touching other content", async () => {
  const first = memo({ createTime: "2026-10-26T01:00:00Z", content: "first" });
  const third = memo({ name: "memos/third", createTime: "2026-10-26T05:00:00Z", content: "third" });
  const second = memo({ name: "memos/second", createTime: "2026-10-26T03:00:00Z", content: "second" });
  const pages = { "create_time desc:": { memos: [third, first], nextPageToken: "" } };
  const { syncer, notes } = syncerWithPages(pages, 0, LIFELOG_NOTE);
  await syncer.sync();
  pages["create_time desc:"].memos = [second];
  const result = await syncer.sync(true);
  assert.equal(result.newCount, 1);
  const section = dailyRecord([...notes.values()][0]);
  const order = ["first", "second", "third", "daily-lifelog-agent:start"].map((s) => section.indexOf(s));
  assert.deepEqual([...order].sort((a, b) => a - b), order);
  assert.ok(order.every((i) => i > section.indexOf("Garmin Health")));
  assert.match(section, /first #daily-record \^\d{10}\n- \d\d:\d\d second #daily-record \^\d{10}\n- \d\d:\d\d third/);
});

test("editing a multi-line memo replaces all of its lines and keeps the lifelog block", async () => {
  const original = memo({ content: "headline\nline two\nline three" });
  const edited = memo({ content: "headline edited\nonly line", updateTime: "2026-10-26T02:00:00Z" });
  const pages = {
    "create_time desc:": { memos: [original], nextPageToken: "" },
    "update_time desc:": { memos: [original], nextPageToken: "" },
  };
  const { syncer, notes } = syncerWithPages(pages, 0, LIFELOG_NOTE);
  await syncer.sync();
  pages["update_time desc:"].memos = [edited];
  const result = await syncer.sync();
  assert.equal(result.updatedCount, 1);
  const section = dailyRecord([...notes.values()][0]);
  assert.match(section, /headline edited #daily-record \^\d{10}\n\tonly line\n\n<!-- daily-lifelog-agent:start -->/);
  assert.doesNotMatch(section, /line two|line three/);
  assert.match(section, /<!-- daily-lifelog-agent:end -->/);
  assert.match(section, /Garmin Health/);
});

test("extra blank lines under the header do not leak memo text into the next section", async () => {
  const note = "## Daily Record\n\n\n> [!health] Garmin\n- 13:00 old #daily-record ^1779940826\n\t- detail\n\n## Work\n\n- keep\n";
  const { syncer, notes } = syncerWithPages({
    "create_time desc:": { memos: [memo()], nextPageToken: "" },
  }, 0, note);
  await syncer.sync();
  const content = [...notes.values()][0];
  assert.match(content, /\t- detail\n- \d\d:\d\d Example memo #daily-record \^\d{10}\n\n## Work\n\n- keep\n$/);
  assert.doesNotMatch(content, /^d$/m);
  assert.match(content, /> \[!health\] Garmin\n- 13:00 old #daily-record \^1779940826\n\t- detail/);
});
