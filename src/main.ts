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

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName("Memos server URL")
      .setDesc("e.g. https://memo.jmjeong.com")
      .addText((text) =>
        text
          .setPlaceholder("https://your-memos-server.com")
          .setValue(this.plugin.settings.memosAPIURL)
          .onChange(async (value) => {
            this.plugin.settings.memosAPIURL = value.trim().replace(/\/+$/, "");
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("API token")
      .setDesc("Memos access token (Settings > Access Tokens in Memos)")
      .addText((text) =>
        text
          .setPlaceholder("memos_pat_...")
          .setValue(this.plugin.settings.memosAPIToken)
          .onChange(async (value) => {
            this.plugin.settings.memosAPIToken = value.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Test connection")
      .setDesc("Verify server URL and token")
      .addButton((button) =>
        button.setButtonText("Test").onClick(async () => {
          try {
            const syncer = new MemosSyncer(this.app, this.plugin.settings);
            const name = await syncer.testConnection();
            new Notice(`Connected as: ${name}`);
          } catch (e) {
            new Notice(`Connection failed: ${e}`);
          }
        })
      );

    new Setting(containerEl)
      .setName("Daily memos header")
      .setDesc("Section header in daily notes where memos are inserted")
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
      .setDesc("Folder for downloaded attachments (relative to vault root)")
      .addText((text) =>
        text
          .setPlaceholder("Attachments")
          .setValue(this.plugin.settings.attachmentFolder)
          .onChange(async (value) => {
            this.plugin.settings.attachmentFolder = value.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Auto sync on load")
      .setDesc("Sync memos when Obsidian starts")
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
      .setDesc("Periodic sync interval. 0 to disable.")
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

    // URL Rewrite Rules
    containerEl.createEl("h3", { text: "URL Rewrite Rules" });
    containerEl.createEl("p", {
      text: "Replace URL prefixes in memo content. Useful for R2 CDN rewriting.",
      cls: "setting-item-description",
    });

    const rules = this.plugin.settings.urlRewriteRules;

    for (let i = 0; i < rules.length; i++) {
      const rule = rules[i];
      const ruleContainer = containerEl.createDiv({ cls: "memos-sync-rule" });

      new Setting(ruleContainer)
        .setName(`Rule ${i + 1}: From`)
        .addText((text) =>
          text
            .setPlaceholder("Original URL prefix")
            .setValue(rule.from)
            .onChange(async (value) => {
              rule.from = value;
              await this.plugin.saveSettings();
            })
        );

      new Setting(ruleContainer)
        .setName(`Rule ${i + 1}: To`)
        .addText((text) =>
          text
            .setPlaceholder("Replacement URL prefix")
            .setValue(rule.to)
            .onChange(async (value) => {
              rule.to = value;
              await this.plugin.saveSettings();
            })
        );

      new Setting(ruleContainer)
        .setName(`Rule ${i + 1}: Image width`)
        .setDesc("Added as |width to image alt text. Leave empty to skip.")
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

    new Setting(containerEl).addButton((button) =>
      button.setButtonText("Add rule").onClick(async () => {
        rules.push({ from: "", to: "" });
        await this.plugin.saveSettings();
        this.display();
      })
    );
  }
}
