import { App, Notice, Plugin, PluginSettingTab, Setting } from "obsidian";
import { MemosSettings, DEFAULT_SETTINGS } from "./types";
import { MemosSyncer } from "./sync";

export default class MemosSyncPlugin extends Plugin {
  settings!: MemosSettings;
  private syncInterval: number | null = null;

  async onload() {
    await this.loadSettings();

    this.addCommand({
      id: "sync-memos",
      name: "Sync memos",
      callback: () => this.runSync(false),
    });

    this.addCommand({
      id: "force-sync-all-memos",
      name: "Force sync all memos",
      callback: () => this.runSync(true),
    });

    this.addSettingTab(new MemosSyncSettingTab(this.app, this));

    if (this.settings.autoSyncOnLoad) {
      this.app.workspace.onLayoutReady(() => {
        this.runSync(false);
      });
    }

    this.setupAutoSync();
  }

  onunload() {
    this.clearAutoSync();
  }

  private setupAutoSync() {
    this.clearAutoSync();
    const minutes = this.settings.syncIntervalMinutes;
    if (minutes > 0) {
      this.syncInterval = window.setInterval(
        () => this.runSync(false),
        minutes * 60 * 1000
      );
      this.registerInterval(this.syncInterval);
    }
  }

  private clearAutoSync() {
    if (this.syncInterval !== null) {
      window.clearInterval(this.syncInterval);
      this.syncInterval = null;
    }
  }

  private async runSync(forceAll: boolean) {
    if (!this.settings.memosAPIURL || !this.settings.memosAPIToken) {
      new Notice("Memos Sync: Please configure server URL and token in settings.");
      return;
    }

    const syncer = new MemosSyncer(this.app, this.settings);
    const label = forceAll ? "Force sync" : "Sync";

    try {
      new Notice(`Memos Sync: ${label} started...`);
      const count = await syncer.sync(forceAll);
      new Notice(`Memos Sync: ${label} complete. ${count} memo(s) synced.`);
    } catch (e) {
      console.error("Memos Sync error:", e);
      new Notice(`Memos Sync: ${label} failed. ${e}`);
    }
  }

  async loadSettings() {
    const data = await this.loadData();
    this.settings = { ...DEFAULT_SETTINGS, ...data };
    // Ensure urlRewriteRules is always an array
    if (!Array.isArray(this.settings.urlRewriteRules)) {
      this.settings.urlRewriteRules = DEFAULT_SETTINGS.urlRewriteRules;
    }
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }
}

class MemosSyncSettingTab extends PluginSettingTab {
  plugin: MemosSyncPlugin;

  constructor(app: App, plugin: MemosSyncPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  private async testAndShowStatus(setting: Setting) {
    setting.setDesc("Testing connection...");
    try {
      const syncer = new MemosSyncer(this.app, this.plugin.settings);
      const name = await syncer.testConnection();
      setting.setDesc(`Connected as: ${name}`);
    } catch {
      setting.setDesc("Connection failed. Check server URL and token.");
    }
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    // --- Connection ---
    containerEl.createEl("h3", { text: "Connection" });

    new Setting(containerEl)
      .setName("Server URL")
      .setDesc("Your Memos server address (e.g. https://memo.example.com)")
      .addText((text) =>
        text
          .setPlaceholder("https://your-memos-server.com")
          .setValue(this.plugin.settings.memosAPIURL)
          .onChange(async (value) => {
            this.plugin.settings.memosAPIURL = value.trim().replace(/\/+$/, "");
            await this.plugin.saveSettings();
          })
      );

    const tokenSetting = new Setting(containerEl)
      .setName("Access token")
      .setDesc("Generate in Memos: Settings > Access Tokens");

    let testTimeout: number | null = null;
    tokenSetting.addText((text) =>
      text
        .setPlaceholder("memos_pat_...")
        .setValue(this.plugin.settings.memosAPIToken)
        .onChange(async (value) => {
          this.plugin.settings.memosAPIToken = value.trim();
          await this.plugin.saveSettings();
          // Debounced auto-test on token change
          if (testTimeout) window.clearTimeout(testTimeout);
          if (value.trim()) {
            testTimeout = window.setTimeout(() => this.testAndShowStatus(tokenSetting), 800);
          }
        })
    );

    // Run initial test if token is already set
    if (this.plugin.settings.memosAPIURL && this.plugin.settings.memosAPIToken) {
      this.testAndShowStatus(tokenSetting);
    }

    // --- Sync ---
    containerEl.createEl("h3", { text: "Sync" });

    new Setting(containerEl)
      .setName("Auto sync on startup")
      .setDesc("Automatically sync memos when Obsidian opens")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.autoSyncOnLoad)
          .onChange(async (value) => {
            this.plugin.settings.autoSyncOnLoad = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Sync interval (minutes)")
      .setDesc("Run sync periodically in the background. Set to 0 to disable.")
      .addText((text) =>
        text
          .setPlaceholder("0")
          .setValue(String(this.plugin.settings.syncIntervalMinutes))
          .onChange(async (value) => {
            const num = parseInt(value, 10);
            this.plugin.settings.syncIntervalMinutes = isNaN(num) ? 0 : Math.max(0, num);
            await this.plugin.saveSettings();
          })
      );

    // --- Daily Notes ---
    containerEl.createEl("h3", { text: "Daily Notes" });

    new Setting(containerEl)
      .setName("Section header")
      .setDesc("Memos are inserted under this heading in daily notes (e.g. \"Daily Record\" matches \"## Daily Record\")")
      .addText((text) =>
        text
          .setPlaceholder("Daily Record")
          .setValue(this.plugin.settings.dailyMemosHeader)
          .onChange(async (value) => {
            this.plugin.settings.dailyMemosHeader = value.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Attachment folder")
      .setDesc("Where to save downloaded images and files (relative to vault root)")
      .addText((text) =>
        text
          .setPlaceholder("Attachments")
          .setValue(this.plugin.settings.attachmentFolder)
          .onChange(async (value) => {
            this.plugin.settings.attachmentFolder = value.trim();
            await this.plugin.saveSettings();
          })
      );

    // --- Image URL Shortening (collapsible) ---
    const detailsEl = containerEl.createEl("details");
    const rules = this.plugin.settings.urlRewriteRules;
    if (rules.some((r) => r.from)) detailsEl.setAttribute("open", "");
    detailsEl.createEl("summary", {
      text: `Image URL shortening (${rules.length} rule${rules.length !== 1 ? "s" : ""})`,
      cls: "setting-item-name",
    });
    detailsEl.createEl("p", {
      text: "Memos stores images with long storage URLs (e.g. Cloudflare R2 signed URLs). These rules replace the long URL with a shorter public one so images display correctly in Obsidian. Most users don't need to change this.",
      cls: "setting-item-description",
    });

    for (let i = 0; i < rules.length; i++) {
      const rule = rules[i];
      const ruleContainer = detailsEl.createDiv({ cls: "memos-sync-rule" });

      new Setting(ruleContainer)
        .setName("Find")
        .setDesc("Long URL prefix from Memos storage")
        .addText((text) =>
          text
            .setPlaceholder("https://long-storage-url.com/assets/")
            .setValue(rule.from)
            .onChange(async (value) => {
              rule.from = value;
              await this.plugin.saveSettings();
            })
        );

      new Setting(ruleContainer)
        .setName("Replace with")
        .setDesc("Short public URL")
        .addText((text) =>
          text
            .setPlaceholder("https://cdn.example.com/assets/")
            .setValue(rule.to)
            .onChange(async (value) => {
              rule.to = value;
              await this.plugin.saveSettings();
            })
        );

      new Setting(ruleContainer)
        .setName("Image width")
        .setDesc("Resize images to this width in Obsidian (e.g. 500)")
        .addText((text) =>
          text
            .setPlaceholder("500")
            .setValue(rule.imageWidth ? String(rule.imageWidth) : "")
            .onChange(async (value) => {
              const num = parseInt(value, 10);
              rule.imageWidth = isNaN(num) ? undefined : num;
              await this.plugin.saveSettings();
            })
        );

      new Setting(ruleContainer).addButton((button) =>
        button
          .setButtonText("Remove")
          .setWarning()
          .onClick(async () => {
            rules.splice(i, 1);
            await this.plugin.saveSettings();
            this.display();
          })
      );
    }

    new Setting(detailsEl).addButton((button) =>
      button.setButtonText("Add rule").onClick(async () => {
        rules.push({ from: "", to: "" });
        await this.plugin.saveSettings();
        this.display();
      })
    );
  }
}
