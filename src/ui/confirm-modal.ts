import { App, Modal, Setting } from "obsidian";
import { t } from "../i18n";

export class ConfirmModal extends Modal {
  private message: string;
  private onConfirm: () => void;
  private onCancel: () => void;
  private isConfirmed = false;

  constructor(
    app: App,
    message: string,
    onConfirm: () => void,
    onCancel: () => void
  ) {
    super(app);
    this.message = message;
    this.onConfirm = onConfirm;
    this.onCancel = onCancel;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: t("changeRepoConfirmTitle") });
    contentEl.createEl("p", { text: this.message });

    new Setting(contentEl)
      .addButton((btn) =>
        btn
          .setButtonText(t("cancel"))
          .onClick(() => {
            this.close();
          })
      )
      .addButton((btn) =>
        btn
          .setButtonText(t("confirm"))
          .setCta()
          .onClick(() => {
            this.isConfirmed = true;
            this.close();
            this.onConfirm();
          })
      );
  }

  onClose(): void {
    this.contentEl.empty();
    if (!this.isConfirmed) {
      this.onCancel();
    }
  }
}
