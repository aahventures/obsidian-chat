import { App, Modal, Setting } from "obsidian";
import type { ChatSession } from "../sessions";

/** Ask for a chat's new name. Enter or Save applies it; a blank name changes nothing. */
export class RenameChatModal extends Modal {
  private name: string;
  /** What the chat is shown as, for an empty field: an untitled chat's "New chat". */
  private shown: string;

  constructor(
    app: App,
    session: ChatSession,
    private onRename: (name: string) => void
  ) {
    super(app);
    this.name = session.title;
    this.shown = session.displayTitle;
  }

  onOpen(): void {
    this.setTitle("Rename chat");

    new Setting(this.contentEl)
      .setName("Name")
      .addText((text) => {
        text
          .setValue(this.name)
          .setPlaceholder(this.shown)
          .onChange((value) => (this.name = value));
        text.inputEl.addEventListener("keydown", (event) => {
          // Not mid-composition, so Enter can confirm an IME candidate. WebKit
          // ends the composition before keydown, which then reports 229.
          if (event.key === "Enter" && !event.isComposing && event.keyCode !== 229) {
            event.preventDefault();
            this.save();
          }
        });
        // Focused while the tap that opened this is still being handled, so a
        // phone raises its keyboard; selected, so typing replaces the old name.
        text.inputEl.focus();
        text.inputEl.select();
      });

    new Setting(this.contentEl)
      .addButton((button) => button.setButtonText("Cancel").onClick(() => this.close()))
      .addButton((button) => button.setButtonText("Save").setCta().onClick(() => this.save()));
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private save(): void {
    this.onRename(this.name);
    this.close();
  }
}
