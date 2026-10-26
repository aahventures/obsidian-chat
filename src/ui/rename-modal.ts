import { App, Modal, Setting } from "obsidian";

/**
 * Ask for a chat's new name. Enter or Save applies it; a blank name goes back
 * to the title taken from the first message.
 */
export class RenameChatModal extends Modal {
  private name: string;

  constructor(
    app: App,
    current: string,
    private onRename: (name: string) => void
  ) {
    super(app);
    this.name = current;
  }

  onOpen(): void {
    this.setTitle("Rename chat");

    new Setting(this.contentEl)
      .setName("Name")
      .setDesc("Leave blank to name it after its first message again.")
      .addText((text) => {
        text.setValue(this.name).onChange((value) => (this.name = value));
        text.inputEl.addEventListener("keydown", (event) => {
          // Not mid-composition, so Enter can confirm an IME candidate.
          if (event.key === "Enter" && !event.isComposing) {
            event.preventDefault();
            this.save();
          }
        });
        // Selected, so typing replaces the old name.
        window.setTimeout(() => text.inputEl.select(), 0);
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
