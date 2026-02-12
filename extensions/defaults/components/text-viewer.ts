import { ScrollablePanel } from "@aliou/pi-utils-ui";
import type { Theme } from "@mariozechner/pi-coding-agent";
import type { Component, TUI } from "@mariozechner/pi-tui";

type ContentBuilder = (width: number, theme: Theme) => string[];

export class TextViewer implements Component {
  private panel: ScrollablePanel;

  constructor(
    title: string,
    buildContent: ContentBuilder,
    tui: TUI,
    theme: Theme,
    onClose: () => void,
  ) {
    this.panel = new ScrollablePanel(
      {
        title,
        buildContent,
        maxVisible: 20,
        keymap: "default",
        onClose,
      },
      tui,
      theme,
    );
  }

  handleInput(data: string): boolean {
    return this.panel.handleInput(data);
  }

  invalidate(): void {
    this.panel.invalidate();
  }

  render(width: number): string[] {
    return this.panel.render(width);
  }
}
