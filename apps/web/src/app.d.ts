import type { DesktopBridge } from "@gitgui/contracts/desktop";

declare global {
  interface Window {
    desktopBridge?: DesktopBridge;
    secretPrompt?: {
      submit(value: string): void;
      cancel(): void;
    };
  }
}

export {};
