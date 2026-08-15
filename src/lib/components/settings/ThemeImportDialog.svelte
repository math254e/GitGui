<script lang="ts">
  import { AlertCircle, Check, ClipboardPaste, FileJson, Upload, X as Close } from "@lucide/svelte";
  import { parseThemeFile } from "../../theme/themePalette";
  import type { ThemeDefinition } from "../../theme/types";

  export type ThemeImportDialogProps = {
    open?: boolean;
    onClose?: () => void;
    onImported?: (theme: ThemeDefinition) => void;
  };

  let {
    open = true,
    onClose,
    onImported,
  }: ThemeImportDialogProps = $props();

  let source = $state<"paste" | "file">("paste");
  let json = $state("");
  let fileName = $state("");
  let errorMessage = $state("");
  let parsedTheme = $state<ThemeDefinition | null>(null);
  let isDragging = $state(false);
  let fileInput = $state<HTMLInputElement | null>(null);

  function validate(raw: string): ThemeDefinition | null {
    const trimmed = raw.trim();
    if (!trimmed) {
      errorMessage = "Paste a theme JSON file to continue.";
      parsedTheme = null;
      return null;
    }

    try {
      const value: unknown = JSON.parse(trimmed);
      const theme = parseThemeFile(value);
      errorMessage = "";
      parsedTheme = theme;
      return theme;
    } catch (error) {
      parsedTheme = null;
      errorMessage = error instanceof Error ? error.message : "This theme file could not be read.";
      return null;
    }
  }

  function updateJson(value: string) {
    json = value;
    validate(value);
  }

  async function readFile(file: File | undefined) {
    if (!file) return;
    fileName = file.name;
    source = "file";

    try {
      updateJson(await file.text());
    } catch {
      parsedTheme = null;
      errorMessage = "The selected file could not be read.";
    }
  }

  function handleFileChange(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    void readFile(input.files?.[0]);
  }

  function handleDrop(event: DragEvent) {
    event.preventDefault();
    isDragging = false;
    void readFile(event.dataTransfer?.files[0]);
  }

  function importTheme() {
    const theme = parsedTheme ?? validate(json);
    if (!theme) return;
    onImported?.(theme);
    onClose?.();
  }

  function closeOnEscape(event: KeyboardEvent) {
    if (event.key === "Escape") onClose?.();
  }
</script>

{#if open}
  <div
    class="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-4 backdrop-blur-[2px]"
    role="presentation"
    onclick={(event) => {
      if (event.target === event.currentTarget) onClose?.();
    }}
  >
    <div
      class="flex max-h-[min(720px,calc(100vh-2rem))] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border shadow-2xl"
      style="background: var(--app-theme-surface-overlay, #111113); border-color: var(--app-theme-border, #27272c); color: var(--app-theme-text, #f4f4f5)"
      role="dialog"
      aria-modal="true"
      aria-labelledby="theme-import-title"
      aria-describedby="theme-import-description"
      tabindex="-1"
      onkeydown={closeOnEscape}
    >
      <header class="flex items-start justify-between gap-4 border-b px-5 py-4" style="border-color: var(--app-theme-border, #27272c)">
        <div>
          <p class="text-[11px] font-semibold uppercase tracking-[0.16em]" style="color: var(--app-theme-text-muted, #92939b)">Theme library</p>
          <h2 id="theme-import-title" class="mt-1 text-lg font-semibold tracking-[-0.02em]">Import theme</h2>
          <p id="theme-import-description" class="mt-1 text-sm" style="color: var(--app-theme-text-muted, #92939b)">
            Add a version 1 GitGui theme from a JSON file or pasted text.
          </p>
        </div>
        <button
          type="button"
          class="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg transition hover:bg-[var(--app-theme-sidebar-row-hover,#1a1a1d)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-theme-focus,#4c8dff)]"
          style="color: var(--app-theme-text-muted, #92939b)"
          aria-label="Close import theme dialog"
          onclick={() => onClose?.()}
        >
          <Close aria-hidden="true" size={17} />
        </button>
      </header>

      <div class="min-h-0 overflow-y-auto px-5 py-5">
        <div class="flex gap-1 rounded-xl border p-1" style="background: var(--app-theme-surface, #0b0b0d); border-color: var(--app-theme-border, #27272c)" role="tablist" aria-label="Theme source">
          <button
            type="button"
            class="flex h-9 flex-1 items-center justify-center gap-2 rounded-lg px-3 text-sm font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-theme-focus,#4c8dff)]"
            style={`background: ${source === "paste" ? "var(--app-theme-sidebar-row-selected, #1e2030)" : "transparent"}; color: ${source === "paste" ? "var(--app-theme-text, #f4f4f5)" : "var(--app-theme-text-muted, #92939b)"}`}
            role="tab"
            aria-selected={source === "paste"}
            onclick={() => {
              source = "paste";
              errorMessage = "";
            }}
          >
            <ClipboardPaste aria-hidden="true" size={15} />
            Paste JSON
          </button>
          <button
            type="button"
            class="flex h-9 flex-1 items-center justify-center gap-2 rounded-lg px-3 text-sm font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-theme-focus,#4c8dff)]"
            style={`background: ${source === "file" ? "var(--app-theme-sidebar-row-selected, #1e2030)" : "transparent"}; color: ${source === "file" ? "var(--app-theme-text, #f4f4f5)" : "var(--app-theme-text-muted, #92939b)"}`}
            role="tab"
            aria-selected={source === "file"}
            onclick={() => {
              source = "file";
              errorMessage = "";
            }}
          >
            <Upload aria-hidden="true" size={15} />
            Choose file
          </button>
        </div>

        {#if source === "paste"}
          <label class="mt-4 block">
            <span class="mb-2 block text-sm font-semibold">Theme JSON</span>
            <textarea
              class="min-h-64 w-full resize-y rounded-xl border px-3 py-3 font-mono text-[12px] leading-5 outline-none transition placeholder:text-[var(--app-theme-placeholder,#686a73)] focus:border-[var(--app-theme-focus,#4c8dff)] focus:ring-2 focus:ring-[color-mix(in_srgb,var(--app-theme-focus,#4c8dff)_24%,transparent)]"
              style="background: var(--app-theme-input, #17171a); border-color: var(--app-theme-border, #27272c); color: var(--app-theme-text, #f4f4f5)"
              placeholder={'{\n  "version": 1,\n  "name": "My theme",\n  "appearance": "dark",\n  "colors": { ... }\n}'}
              value={json}
              aria-label="Theme JSON"
              oninput={(event) => updateJson((event.currentTarget as HTMLTextAreaElement).value)}
            ></textarea>
          </label>
        {:else}
          <button
            type="button"
            class={`mt-4 flex min-h-44 w-full flex-col items-center justify-center rounded-xl border border-dashed px-6 text-center transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-theme-focus,#4c8dff)] ${isDragging ? "bg-[var(--app-theme-sidebar-row-hover,#1a1a1d)]" : "hover:bg-[var(--app-theme-sidebar-row-hover,#1a1a1d)]"}`}
            style="border-color: var(--app-theme-border, #3b3c43); color: var(--app-theme-text-muted, #92939b)"
            onclick={() => fileInput?.click()}
            ondragover={(event) => {
              event.preventDefault();
              isDragging = true;
            }}
            ondragleave={() => (isDragging = false)}
            ondrop={handleDrop}
          >
            <span class="mb-3 flex h-10 w-10 items-center justify-center rounded-xl" style="background: var(--app-theme-sidebar-row-selected, #1e2030); color: var(--app-theme-accent, #8d9cff)">
              <FileJson aria-hidden="true" size={20} />
            </span>
            <span class="text-sm font-semibold" style="color: var(--app-theme-text, #f4f4f5)">{fileName || "Choose a JSON theme file"}</span>
            <span class="mt-1 text-xs">Drop a file here or browse from your computer</span>
          </button>
          <input bind:this={fileInput} class="sr-only" type="file" accept="application/json,.json" aria-label="Choose theme JSON file" onchange={handleFileChange} />
        {/if}

        {#if errorMessage}
          <div class="mt-3 flex items-start gap-2 rounded-xl border px-3 py-2.5 text-sm" style="background: var(--app-theme-error-surface, #351b1d); border-color: color-mix(in srgb, var(--app-theme-error,#f97066) 40%, transparent); color: var(--app-theme-error-foreground, #fff)" role="alert">
            <AlertCircle class="mt-0.5 shrink-0" aria-hidden="true" size={16} />
            <span>{errorMessage}</span>
          </div>
        {:else if parsedTheme}
          <div class="mt-3 flex items-start gap-3 rounded-xl border px-3 py-3" style="background: var(--app-theme-accent-surface, #1e2030); border-color: color-mix(in srgb, var(--app-theme-accent,#8d9cff) 38%, transparent)" role="status">
            <span class="flex h-7 w-7 shrink-0 items-center justify-center rounded-full" style="background: var(--app-theme-accent, #8d9cff); color: var(--app-theme-accent-foreground, #101116)">
              <Check aria-hidden="true" size={15} />
            </span>
            <div class="min-w-0">
              <p class="text-sm font-semibold">{parsedTheme.label}</p>
              <p class="mt-0.5 truncate text-xs" style="color: var(--app-theme-text-muted, #92939b)">{parsedTheme.id} · {parsedTheme.appearance} palette validated</p>
            </div>
          </div>
        {/if}
      </div>

      <footer class="flex flex-col-reverse gap-2 border-t px-5 py-4 sm:flex-row sm:justify-end" style="border-color: var(--app-theme-border, #27272c)">
        <button
          type="button"
          class="h-9 rounded-lg px-3 text-sm font-semibold transition hover:bg-[var(--app-theme-sidebar-row-hover,#1a1a1d)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-theme-focus,#4c8dff)]"
          style="color: var(--app-theme-text-muted, #92939b)"
          onclick={() => onClose?.()}
        >
          Cancel
        </button>
        <button
          type="button"
          class="inline-flex h-9 items-center justify-center gap-2 rounded-lg px-4 text-sm font-semibold transition disabled:cursor-not-allowed disabled:opacity-45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-theme-focus,#4c8dff)]"
          style="background: var(--app-theme-accent, #8d9cff); color: var(--app-theme-accent-foreground, #101116)"
          disabled={!parsedTheme}
          onclick={importTheme}
        >
          <Upload aria-hidden="true" size={15} />
          Import theme
        </button>
      </footer>
    </div>
  </div>
{/if}
