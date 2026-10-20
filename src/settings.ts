import {
  AbstractInputSuggest,
  App,
  Notice,
  PluginSettingTab,
  Setting,
  TFolder,
  prepareFuzzySearch,
  requestUrl,
} from "obsidian";
import { scanSkills, skillsFolderPath } from "./skills/store";
import type ChatPlugin from "./main";
import type { Provider } from "./types";

interface ModelOption {
  value: string;
  label: string;
}

const FALLBACK_MODELS: Record<string, ModelOption[]> = {
  anthropic: [
    { value: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
    { value: "claude-opus-4-7", label: "Claude Opus 4.7" },
    { value: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5" },
  ],
  openai: [
    { value: "gpt-5.3-codex", label: "Codex 5.3" },
    { value: "gpt-5.4", label: "GPT-5.4" },
    { value: "gpt-4o", label: "GPT-4o" },
  ],
  custom: [
    { value: "deepseek-chat", label: "DeepSeek V3" },
    { value: "deepseek-reasoner", label: "DeepSeek R1" },
  ],
};

// Cache fetched models per provider so they survive tab re-opens
const modelCache = new Map<string, ModelOption[]>();

/** Resolve a model ID to its display name */
export function getModelDisplayName(provider: string, modelId: string): string {
  const cached = modelCache.get(provider);
  const models = cached || FALLBACK_MODELS[provider] || [];
  const match = models.find((m) => m.value === modelId);
  return match?.label || modelId;
}

// ─── Settings Tab ───────────────────────────────────────────────────────────

export class ChatSettingTab extends PluginSettingTab {
  plugin: ChatPlugin;

  constructor(app: App, plugin: ChatPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "Obsidian Chat" });

    const s = this.plugin.settings;

    // ─── Provider ─────────────────────────────────────────────────────
    new Setting(containerEl)
      .setName("Provider")
      .setDesc("Which AI provider to use. Select Custom for DeepSeek, Ollama, OpenRouter, etc.")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("anthropic", "Anthropic")
          .addOption("openai", "OpenAI")
          .addOption("custom", "Custom (OpenAI-compatible)")
          .setValue(s.provider)
          .onChange(async (value) => {
            // Load the new provider's key BEFORE saving,
            // otherwise the old provider's key gets saved under the new provider name
            s.provider = value as Provider;
            s.model = "";
            // Custom providers don't support built-in web search; keep the
            // stored flag in sync with the disabled toggle shown below.
            if (s.provider === "custom") {
              s.enableWebSearch = false;
            }
            this.plugin.reloadApiKeyForProvider();
            await this.plugin.saveSettings();
            setTimeout(() => this.display(), 10);
          })
      );

    // ─── Base URL (only shown for custom provider) ───────────────────
    if (s.provider === "custom") {
      new Setting(containerEl)
        .setName("Base URL")
        .setDesc("API endpoint base URL. E.g. https://api.deepseek.com for DeepSeek, or http://localhost:11434 for Ollama")
        .addText((text) =>
          text
            .setPlaceholder("https://api.deepseek.com")
            .setValue(s.baseUrl)
            .onChange(async (value) => {
              s.baseUrl = value.trim().replace(/\/+$/, "");
              // Model availability depends on the endpoint; drop the cached
              // list so a stale set from the previous Base URL isn't shown.
              modelCache.delete(s.provider);
              await this.plugin.saveSettings();
            })
        );
    }

    // ─── API Key + Test ─────────────────────────────────────────────
    const apiKeySetting = new Setting(containerEl)
      .setName("API key")
      .setDesc(s.apiKey ? "Key saved" : "Enter your API key to get started")
      .addText((text) => {
        text.inputEl.type = "password";
        text
          .setPlaceholder("Enter your API key")
          .setValue(s.apiKey)
          .onChange(async (value) => {
            const hadKey = !!s.apiKey;
            s.apiKey = value.trim();
            await this.plugin.saveSettings();
            if (!hadKey && s.apiKey) {
              setTimeout(() => this.display(), 10);
            }
          });
      });

    if (s.apiKey) {
      apiKeySetting.addButton((button) =>
        button.setButtonText("Test").onClick(async () => {
          button.setButtonText("Testing...");
          button.setDisabled(true);
          try {
            const { sendMessage } = await import("./api/client");
            const response = await sendMessage(
              s,
              [{ role: "user", content: "Say hello in one word." }],
              [],
              "You are a test. Respond with one word.",
              // Throwaway chaining state: a connection test must never attach
              // itself to a real conversation.
              { previousResponseId: null }
            );
            const text = response.content
              .filter((b) => b.type === "text")
              .map((b) => b.text)
              .join("");
            new Notice(`Connected! Response: "${text}"`);
            apiKeySetting.setDesc("Connection successful");
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            new Notice(`Connection failed: ${msg}`);
            apiKeySetting.setDesc(`Failed: ${msg}`);
          } finally {
            button.setButtonText("Test");
            button.setDisabled(false);
          }
        })
      );
    }

    // ─── Model ────────────────────────────────────────────────────────
    const cached = modelCache.get(s.provider);
    const models = cached || FALLBACK_MODELS[s.provider] || FALLBACK_MODELS.anthropic;

    const modelSetting = new Setting(containerEl)
      .setName("Model")
      .setDesc(cached ? `${cached.length} models loaded from API` : "Select a model or type a custom model ID")
      .addDropdown((dropdown) => {
        for (const m of models) {
          dropdown.addOption(m.value, m.label);
        }
        dropdown.addOption("__custom__", "Custom...");
        const current = models.some((m) => m.value === s.model) ? s.model : "__custom__";
        dropdown.setValue(current);
        dropdown.onChange(async (value) => {
          if (value === "__custom__") {
            s.model = "";
          } else {
            s.model = value;
          }
          await this.plugin.saveSettings();
          setTimeout(() => this.display(), 10);
        });
      });

    // Refresh button to fetch models from API
    if (s.apiKey) {
      modelSetting.addButton((btn) =>
        btn
          .setIcon("refresh-cw")
          .setTooltip("Fetch models from API")
          .onClick(async () => {
            btn.setDisabled(true);
            try {
              const fetched = await fetchModelsFromAPI(s);
              modelCache.set(s.provider, fetched);
              new Notice(`Loaded ${fetched.length} models`);
              if (!s.model && fetched.length > 0) {
                s.model = fetched[0].value;
                await this.plugin.saveSettings();
              }
              this.display();
            } catch (e) {
              const msg = e instanceof Error ? e.message : String(e);
              new Notice(`Failed to fetch models: ${msg}`);
            }
          })
      );
    }

    // Custom model text field (shown when Custom... is selected, i.e. the
    // saved model isn't one of the listed options — covers empty model and
    // saved-but-unlisted custom IDs so they remain visible and editable)
    if (!models.some((m) => m.value === s.model)) {
      new Setting(containerEl)
        .setName("Custom model ID")
        .setDesc(
          s.provider === "custom"
            ? "Enter the full model identifier (e.g. deepseek-chat, deepseek-reasoner)"
            : s.provider === "anthropic"
            ? "Enter the full model identifier (e.g. claude-sonnet-4-20250514)"
            : "Enter the full model identifier (e.g. gpt-4o)"
        )
        .addText((text) =>
          text
            .setPlaceholder(
              s.provider === "custom"
                ? "deepseek-chat"
                : s.provider === "anthropic"
                ? "claude-sonnet-4-20250514"
                : "gpt-4o"
            )
            .setValue(s.model)
            .onChange(async (value) => {
              s.model = value.trim();
              await this.plugin.saveSettings();
            })
        );
    }

    // ─── Web search ───────────────────────────────────────────────────
    if (s.provider === "custom") {
      new Setting(containerEl)
        .setName("Web search")
        .setDesc("Not supported for custom providers. Most third-party APIs do not offer built-in web search.")
        .addToggle((toggle) =>
          toggle
            .setValue(false)
            .setDisabled(true)
        );
    } else {
      new Setting(containerEl)
        .setName("Web search")
        .setDesc("Allow the model to search the web when it needs current information")
        .addToggle((toggle) =>
          toggle
            .setValue(s.enableWebSearch)
            .onChange(async (value) => {
              s.enableWebSearch = value;
              await this.plugin.saveSettings();
            })
        );
    }

    // ─── File link menu ───────────────────────────────────────────────
    new Setting(containerEl)
      .setName("File link suggestions")
      .setDesc(
        "Typing [[ in the chat input suggests vault files and adds the closing ]]. " +
          "Turn off if you find it distracting or it feels slow in a large vault."
      )
      .addToggle((toggle) =>
        toggle.setValue(s.fileLinkMenu).onChange(async (value) => {
          s.fileLinkMenu = value;
          await this.plugin.saveSettings();
        })
      );

    // ─── Max iterations ───────────────────────────────────────────────
    new Setting(containerEl)
      .setName("Max tool iterations")
      .setDesc("Safety limit for the agent loop (default: 20)")
      .addText((text) =>
        text
          .setPlaceholder("20")
          .setValue(String(s.maxIterations))
          .onChange(async (value) => {
            const n = parseInt(value, 10);
            if (!isNaN(n) && n > 0 && n <= 100) {
              s.maxIterations = n;
              await this.plugin.saveSettings();
            }
          })
      );

    // Last, under its own heading, so the general settings above stay together.
    this.displaySkills(containerEl);
  }

  private displaySkills(containerEl: HTMLElement): void {
    const s = this.plugin.settings;
    new Setting(containerEl).setName("Skills").setHeading();

    // Read off the vault when the tab is drawn and when the folder changes,
    // the same way the chat reads it each turn.
    const summary = async (): Promise<DocumentFragment> => {
      const frag = document.createDocumentFragment();
      const path = skillsFolderPath(s.skillsFolder);
      if (!path) {
        frag.append("No skills folder set.");
        return frag;
      }
      const { root, skills, skipped } = await scanSkills(this.app, s.skillsFolder);
      if (!root) {
        frag.append(`There's no folder "${path}" in this vault.`);
        return frag;
      }
      frag.append(skills.length === 0 ? "None found." : `${skills.length}: ${skills.map((k) => k.name).join(", ")}.`);
      for (const k of skipped) {
        frag.createEl("br");
        frag.append(`Not loaded: ${k.folder}: ${k.reason}.`);
      }
      return frag;
    };
    // Set at the end of this section; refreshed in place, since redrawing the
    // tab while the folder is being typed would take focus out of the field.
    let loadedSetting: Setting | undefined;
    const show = (value: string) =>
      summary()
        // Typing fast starts several; only the one for the value now set counts.
        .then((desc) => {
          if (loadedSetting && s.skillsFolder === value) loadedSetting.setDesc(desc);
        })
        .catch((e) => console.warn("Obsidian Chat: couldn't list skills", e));
    const save = async (value: string) => {
      s.skillsFolder = value.trim();
      await this.plugin.saveSettings();
      void show(s.skillsFolder);
    };

    new Setting(containerEl)
      .setName("Skills folder")
      .setDesc(
        "A vault folder of skills, each in its own folder as <name>/SKILL.md (Claude Code's format). " +
          "It syncs like any note, so skills here work on mobile too. " +
          "Just ask, and the chat uses a skill whose description matches. Leave it empty for no skills. " +
          "If you rename or move the folder, update this to match."
      )
      .addText((text) => {
        text.setPlaceholder("e.g. Skills").setValue(s.skillsFolder).onChange(save);
        new FolderSuggest(this.app, text.inputEl, save);
      });

    const found = new Setting(containerEl).setName("Skills found");
    loadedSetting = found;
    void show(s.skillsFolder);
  }
}

// ─── Skills ─────────────────────────────────────────────────────────────────

/** Suggests vault folders as you type, for the skills folder setting. */
class FolderSuggest extends AbstractInputSuggest<TFolder> {
  constructor(app: App, private inputEl: HTMLInputElement, private onPick: (path: string) => unknown) {
    super(app, inputEl);
  }

  getSuggestions(query: string): TFolder[] {
    const folders = this.app.vault.getAllFolders(false);
    if (!query) return folders.slice(0, 20);
    const match = prepareFuzzySearch(query);
    return folders
      .map((f) => ({ f, r: match(f.path) }))
      .filter((x) => x.r)
      .sort((a, b) => b.r!.score - a.r!.score)
      .slice(0, 20)
      .map((x) => x.f);
  }

  renderSuggestion(folder: TFolder, el: HTMLElement): void {
    el.setText(folder.path);
  }

  selectSuggestion(folder: TFolder): void {
    this.inputEl.value = folder.path;
    // onPick saves, which can fail (a locked data.json): don't leave that unhandled.
    void Promise.resolve(this.onPick(folder.path)).catch((e) => console.warn("Obsidian Chat: couldn't save the skills folder", e));
    this.close();
  }
}

// ─── Model Fetching (only triggered by explicit refresh button click) ───────

async function fetchModelsFromAPI(
  settings: ChatPlugin["settings"]
): Promise<ModelOption[]> {
  if (settings.provider === "anthropic") {
    return fetchAnthropicModels(settings.apiKey);
  }
  if (settings.provider === "custom") {
    return fetchCustomModels(settings);
  }
  return fetchOpenAIModels(settings.apiKey);
}

async function fetchCustomModels(settings: ChatPlugin["settings"]): Promise<ModelOption[]> {
  const baseUrl = (settings.baseUrl || "https://api.deepseek.com").replace(/\/+$/, "");
  let response;
  try {
    response = await requestUrl({
      url: `${baseUrl}/v1/models`,
      method: "GET",
      headers: {
        Authorization: `Bearer ${settings.apiKey}`,
      },
      throw: false,
    });
  } catch {
    // Fall back to default list if model endpoint fails
    return FALLBACK_MODELS.custom;
  }

  if (response.status !== 200) {
    return FALLBACK_MODELS.custom;
  }

  const models = (response.json?.data || [])
    .filter((m: { id: string }) => m.id && !m.id.startsWith("ft:"))
    .map((m: { id: string }) => ({ value: m.id, label: m.id }));

  return models.length > 0 ? models : FALLBACK_MODELS.custom;
}

async function fetchAnthropicModels(apiKey: string): Promise<ModelOption[]> {
  let response;
  try {
    response = await requestUrl({
      url: "https://api.anthropic.com/v1/models?limit=100",
      method: "GET",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
    });
  } catch (e) {
    throw new Error(e instanceof Error ? e.message : String(e));
  }

  const models = (response.json?.data || [])
    .filter((m: { type?: string }) => m.type === "model")
    .map((m: { id: string; display_name?: string }) => ({
      value: m.id,
      label: m.display_name || m.id,
    }))
    .sort((a: ModelOption, b: ModelOption) => {
      const da = a.value.match(/(\d{8})/)?.[1] || "";
      const db = b.value.match(/(\d{8})/)?.[1] || "";
      return db.localeCompare(da) || a.label.localeCompare(b.label);
    });

  return models.length > 0 ? models : FALLBACK_MODELS.anthropic;
}

async function fetchOpenAIModels(apiKey: string): Promise<ModelOption[]> {
  let response;
  try {
    response = await requestUrl({
      url: "https://api.openai.com/v1/models",
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}` },
    });
  } catch (e) {
    throw new Error(e instanceof Error ? e.message : String(e));
  }

  const chatPrefixes = ["gpt-", "o1", "o3", "o4", "chatgpt-", "codex-", "gpt5"];
  const excludePatterns = ["realtime", "audio", "transcri", "search"];

  const models = (response.json?.data || [])
    .filter((m: { id: string }) => {
      const id = m.id.toLowerCase();
      return chatPrefixes.some((p) => id.startsWith(p)) &&
        !excludePatterns.some((p) => id.includes(p));
    })
    .sort((a: { created?: number }, b: { created?: number }) =>
      (b.created || 0) - (a.created || 0)
    )
    .map((m: { id: string }) => ({ value: m.id, label: m.id }));

  return models.length > 0 ? models : FALLBACK_MODELS.openai;
}
