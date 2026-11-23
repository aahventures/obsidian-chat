import { App, ButtonComponent, Modal, TextComponent } from "obsidian";
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

    // The whole width for the name: the modal's title already says what it is.
    const text = new TextComponent(this.contentEl)
      .setValue(this.name)
      .setPlaceholder(this.shown)
      .onChange((value) => (this.name = value));
    text.inputEl.addClass("ochat-rename-input");
    // There's no visible label, so screen readers get this one.
    text.inputEl.setAttr("aria-label", "Chat name");
    text.inputEl.addEventListener("keydown", (event) => {
      // Not mid-composition, so Enter can confirm an IME candidate. WebKit
      // ends the composition before keydown, which then reports 229.
      if (event.key === "Enter" && !event.isComposing && event.keyCode !== 229) {
        event.preventDefault();
        this.save();
      }
    });

    const buttons = this.contentEl.createDiv({ cls: "modal-button-container" });
    new ButtonComponent(buttons).setButtonText("Cancel").onClick(() => this.close());
    new ButtonComponent(buttons).setButtonText("Save").setCta().onClick(() => this.save());

    // Focused while the tap that opened this is still being handled, so a
    // phone raises its keyboard; selected, so typing replaces the old name.
    text.inputEl.focus();
    text.inputEl.select();
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private save(): void {
    this.onRename(this.name);
    this.close();
  }
}
