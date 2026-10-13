import { Modal, Notice, Platform, type App } from "obsidian";

const VIEW_SELECTOR = ".ochat-input-bar";
/** Time to open the chat panel (and the keyboard) before measuring. */
const DELAY_SECONDS = 8;

function describe(el: Element): string {
  const classes = Array.from(el.classList).slice(0, 4).join(".");
  return el.tagName.toLowerCase() + (classes ? "." + classes : "");
}

function rect(el: Element): string {
  const r = el.getBoundingClientRect();
  return `top ${Math.round(r.top)} bottom ${Math.round(r.bottom)} h ${Math.round(r.height)}`;
}

/** Env safe-area insets can only be read by applying them to an element. */
function safeAreaBottom(): string {
  const probe = document.body.createDiv();
  probe.style.cssText =
    "position:fixed;visibility:hidden;padding-bottom:env(safe-area-inset-bottom, 0px)";
  const value = getComputedStyle(probe).paddingBottom;
  probe.remove();
  return value;
}

/** Walk up from the input bar, noting anything that could add space below it. */
export function collectLayoutReport(): string {
  const lines: string[] = [];
  const vv = window.visualViewport;

  lines.push(
    `mobile ${Platform.isMobile} phone ${Platform.isPhone} tablet ${Platform.isTablet} ios ${Platform.isIosApp}`
  );
  lines.push(
    `inner ${window.innerWidth}x${window.innerHeight} ` +
      `visual ${vv ? `${Math.round(vv.width)}x${Math.round(vv.height)} offsetTop ${Math.round(vv.offsetTop)}` : "n/a"} ` +
      `screen ${screen.width}x${screen.height}`
  );
  lines.push(`safe-area-bottom ${safeAreaBottom()}`);
  lines.push(`body classes: ${Array.from(document.body.classList).join(" ")}`);
  lines.push("");

  const bar = document.querySelector(VIEW_SELECTOR);
  if (!bar) {
    lines.push("No chat input bar in the DOM. Open the chat first.");
    return lines.join("\n");
  }

  lines.push("Chain, input bar up to body (rect, then non-zero spacing):");
  for (let el: Element | null = bar; el; el = el.parentElement) {
    const cs = getComputedStyle(el);
    const extras: string[] = [];
    for (const prop of ["padding-bottom", "margin-bottom", "bottom", "min-height"]) {
      const v = cs.getPropertyValue(prop);
      if (v && v !== "0px" && v !== "auto" && v !== "normal") extras.push(`${prop} ${v}`);
    }
    if (cs.position !== "static") extras.push(`position ${cs.position}`);
    if (cs.transform !== "none") extras.push(`transform ${cs.transform}`);
    lines.push(`${describe(el)} | ${rect(el)} | ${extras.join(", ")}`);
  }

  lines.push("");
  lines.push("Obsidian mobile chrome:");
  for (const sel of [
    ".workspace-drawer",
    ".mobile-navbar",
    ".status-bar",
    ".app-container",
  ]) {
    const el = document.querySelector(sel);
    lines.push(`${sel}: ${el ? rect(el) : "not found"}`);
  }

  return lines.join("\n");
}

class LayoutReportModal extends Modal {
  constructor(app: App, private report: string) {
    super(app);
  }

  onOpen(): void {
    this.setTitle("Chat layout report");
    const area = this.contentEl.createEl("textarea", { text: this.report });
    area.readOnly = true;
    area.rows = 18;
    area.style.width = "100%";
    area.style.fontSize = "11px";
    area.style.fontFamily = "var(--font-monospace)";

    this.contentEl.createEl("button", { text: "Copy", cls: "mod-cta" }).onclick = () => {
      void navigator.clipboard.writeText(this.report);
      new Notice("Copied");
    };
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

/**
 * Measure after a delay so the user can close the palette, open the chat panel
 * and focus the input (keyboard up) first. The report is then shown in a
 * modal, which can be screenshotted or copied.
 */
export function runLayoutDiagnostics(app: App): void {
  new Notice(
    `Open the chat panel and tap the input. Measuring in ${DELAY_SECONDS} seconds.`,
    DELAY_SECONDS * 1000
  );
  window.setTimeout(() => {
    new LayoutReportModal(app, collectLayoutReport()).open();
  }, DELAY_SECONDS * 1000);
}
