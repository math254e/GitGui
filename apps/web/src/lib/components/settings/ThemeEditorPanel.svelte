<script lang="ts">
  import { modalDialog, dismissModalOnBackdrop } from "../modal-dialog";
  import ThemeWireframe from "./ThemeWireframe.svelte";
  import { AlertCircle, Check, Moon, Palette, Sun, X as Close } from "@lucide/svelte";
  import {
    getDefaultThemeColors,
    getThemeColorsForMode,
    isThemeId,
    parseThemeFile,
    themeIdFromName,
    toCanonicalThemeColor,
  } from "../../theme/themePalette";
  import {
    GRAPH_THEME_COLOR_ROLES,
    THEME_FILE_VERSION,
    type GraphThemeColorRole,
    type ThemeAppearance,
    type ThemeColors,
    type ThemeDefinition,
  } from "../../theme/types";

  export type ThemeEditorPreviewHandler = (colors: ThemeColors, appearance: ThemeAppearance) => void;

  export type ThemeEditorPanelProps = {
    open?: boolean;
    theme?: ThemeDefinition | null;
    onCancel?: () => void;
    onSave?: (theme: ThemeDefinition) => void;
    onPreview?: ThemeEditorPreviewHandler;
  };

  let {
    open = true,
    theme = null,
    onCancel,
    onSave,
    onPreview,
  }: ThemeEditorPanelProps = $props();

  let name = $state("New theme");
  let id = $state("new-theme");
  let activeAppearance = $state<ThemeAppearance>("light");
  let lightColors = $state<ThemeColors>({ ...getDefaultThemeColors("light") });
  let darkColors = $state<ThemeColors>({ ...getDefaultThemeColors("dark") });
  let lightCanvas = $state(getDefaultThemeColors("light").canvas);
  let lightAccent = $state(getDefaultThemeColors("light").accent);
  let darkCanvas = $state(getDefaultThemeColors("dark").canvas);
  let darkAccent = $state(getDefaultThemeColors("dark").accent);
  let errorMessage = $state("");
  let hydratedKey = $state<string | null>(null);

  const activeColors = $derived(activeAppearance === "light" ? lightColors : darkColors);
  const activeCanvas = $derived(activeAppearance === "light" ? lightCanvas : darkCanvas);
  const activeAccent = $derived(activeAppearance === "light" ? lightAccent : darkAccent);

  function colorsFor(themeDefinition: ThemeDefinition | null, appearance: ThemeAppearance): ThemeColors {
    return themeDefinition
      ? { ...(getThemeColorsForMode(themeDefinition, appearance) ?? getDefaultThemeColors(appearance)) }
      : { ...getDefaultThemeColors(appearance) };
  }

  function hydrate() {
    const nextLight = colorsFor(theme, "light");
    const nextDark = colorsFor(theme, "dark");
    name = theme?.label ?? "New theme";
    id = theme?.id ?? themeIdFromName(name);
    activeAppearance = theme?.appearance ?? "light";
    lightColors = nextLight;
    darkColors = nextDark;
    lightCanvas = nextLight.canvas;
    lightAccent = nextLight.accent;
    darkCanvas = nextDark.canvas;
    darkAccent = nextDark.accent;
    errorMessage = "";
  }

  $effect(() => {
    const key = `${open}:${theme?.id ?? "new"}:${theme?.label ?? ""}`;
    if (open && hydratedKey !== key) {
      hydrate();
      hydratedKey = key;
    }
    if (!open) hydratedKey = null;
  });

  function colorInputValue(value: string): string {
    const normalized = value.trim();
    if (/^#[0-9a-f]{6}$/i.test(normalized)) return normalized;
    if (/^#[0-9a-f]{3}$/i.test(normalized)) {
      return `#${normalized.slice(1).split("").map((part) => part + part).join("")}`;
    }
    // Native color inputs need sRGB hex. Keep authored CSS/OKLCH in the
    // text field and saved palette until the user explicitly edits a color.
    if (typeof document !== "undefined") {
      const context = document.createElement("canvas").getContext("2d");
      if (context) {
        context.fillStyle = normalized;
        context.fillRect(0, 0, 1, 1);
        const channels = context.getImageData(0, 0, 1, 1).data;
        return `#${Array.from(channels).slice(0, 3).map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
      }
    }
    return "#000000";
  }

  function updateColor(appearance: ThemeAppearance, role: "canvas" | "accent", value: string) {
    const canonical = toCanonicalThemeColor(value);
    if (!canonical) return;

    if (appearance === "light") {
      lightColors = { ...lightColors, [role]: canonical } as ThemeColors;
      if (role === "canvas") lightCanvas = value;
      else lightAccent = value;
      onPreview?.(lightColors, "light");
    } else {
      darkColors = { ...darkColors, [role]: canonical } as ThemeColors;
      if (role === "canvas") darkCanvas = value;
      else darkAccent = value;
      onPreview?.(darkColors, "dark");
    }
    errorMessage = "";
  }

  function updateTextColor(appearance: ThemeAppearance, role: "canvas" | "accent", value: string) {
    if (appearance === "light") {
      if (role === "canvas") lightCanvas = value;
      else lightAccent = value;
    } else if (role === "canvas") {
      darkCanvas = value;
    } else {
      darkAccent = value;
    }
    updateColor(appearance, role, value);
  }

  function updateGraphColor(
    appearance: ThemeAppearance,
    role: GraphThemeColorRole,
    value: string,
  ) {
    const canonical = toCanonicalThemeColor(value);
    if (!canonical) return;

    if (appearance === "light") {
      lightColors = { ...lightColors, [role]: canonical } as ThemeColors;
      onPreview?.(lightColors, "light");
    } else {
      darkColors = { ...darkColors, [role]: canonical } as ThemeColors;
      onPreview?.(darkColors, "dark");
    }
    errorMessage = "";
  }

  function setAppearance(appearance: ThemeAppearance) {
    activeAppearance = appearance;
    onPreview?.(appearance === "light" ? lightColors : darkColors, appearance);
  }

  function buildTheme(): ThemeDefinition | null {
    const baseAppearance = activeAppearance;
    const variantAppearance: ThemeAppearance = baseAppearance === "light" ? "dark" : "light";
    const baseColors = baseAppearance === "light" ? lightColors : darkColors;
    const variantColors = variantAppearance === "light" ? lightColors : darkColors;
    const rawFile = {
      version: THEME_FILE_VERSION,
      id: id.trim(),
      name: name.trim(),
      appearance: baseAppearance,
      colors: baseColors,
      variants: { [variantAppearance]: variantColors },
      managed: false,
    };

    try {
      const parsed = parseThemeFile(rawFile);
      errorMessage = "";
      return parsed;
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : "Check the theme details before saving.";
      return null;
    }
  }

  function save() {
    if (!name.trim()) {
      errorMessage = "Give the theme a name before saving.";
      return;
    }
    if (!isThemeId(id.trim())) {
      errorMessage = "Theme ids may only contain lowercase letters, numbers, and hyphens.";
      return;
    }
    if ([lightCanvas, lightAccent, darkCanvas, darkAccent].some((color) => !toCanonicalThemeColor(color))) {
      errorMessage = "Enter a valid CSS color for each canvas and accent before saving.";
      return;
    }
    const nextTheme = buildTheme();
    if (nextTheme) onSave?.(nextTheme);
  }

</script>

{#if open}
  <dialog use:modalDialog
      class="m-auto flex p-0 max-h-[min(780px,calc(100vh-2rem))] w-[calc(100%_-_2rem)] max-w-3xl flex-col overflow-hidden rounded-lg border shadow-[var(--app-theme-dialog-shadow)] backdrop:bg-[var(--app-theme-overlay)] backdrop:backdrop-blur-[2px]"
      style="background: var(--app-theme-surface-overlay, #111113); border-color: var(--app-theme-border, #27272c); color: var(--app-theme-text, #f4f4f5)"
      aria-modal="true"
      aria-labelledby="theme-editor-title"
      aria-describedby="theme-editor-description"
      tabindex="-1"
      oncancel={(event) => { event.preventDefault(); onCancel?.(); }}
      onclick={(event) => dismissModalOnBackdrop(event, () => onCancel?.())}
    >
      <header class="flex items-start justify-between gap-4 border-b px-5 py-4" style="border-color: var(--app-theme-border, #27272c)">
        <div>
          <p class="text-xs font-medium" style="color: var(--app-theme-text-muted, #92939b)">Theme library</p>
          <h2 id="theme-editor-title" class="mt-1 text-base font-semibold">{theme ? "Edit theme" : "Create theme"}</h2>
          <p id="theme-editor-description" class="mt-1 text-sm" style="color: var(--app-theme-text-muted, #92939b)">
            Set the identity, palette anchors, and graph colors used by the theme.
          </p>
        </div>
        <button
          type="button"
          class="flex h-8 w-8 shrink-0 items-center justify-center rounded-sm transition hover:bg-[var(--app-theme-sidebar-row-hover,#1a1a1d)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-theme-focus,#4c8dff)]"
          style="color: var(--app-theme-text-muted, #92939b)"
          aria-label="Close theme editor"
          onclick={() => onCancel?.()}
        >
          <Close aria-hidden="true" size={17} />
        </button>
      </header>

      <form class="min-h-0 overflow-y-auto px-5 py-5" onsubmit={(event) => { event.preventDefault(); save(); }}>
        <div class="grid gap-4 sm:grid-cols-[1.35fr_1fr]">
          <label class="block">
            <span class="mb-2 block text-sm font-semibold">Name</span>
            <input
              class="h-10 w-full rounded-md border px-3 text-sm outline-none transition focus:border-[var(--app-theme-focus,#4c8dff)] focus:ring-2 focus:ring-[color-mix(in_srgb,var(--app-theme-focus,#4c8dff)_24%,transparent)]"
              style="background: var(--app-theme-surface, #17171a); border-color: var(--app-theme-border, #27272c); color: var(--app-theme-text, #f4f4f5)"
              maxlength="48"
              value={name}
              aria-label="Theme name"
              data-dialog-initial-focus
              oninput={(event) => {
                name = (event.currentTarget as HTMLInputElement).value;
                if (!theme && id === themeIdFromName(name.slice(0, -1))) id = themeIdFromName(name);
              }}
            />
          </label>

          <label class="block">
            <span class="mb-2 block text-sm font-semibold">Theme ID</span>
            <input
              class="h-10 w-full rounded-md border px-3 font-mono text-[12px] outline-none transition focus:border-[var(--app-theme-focus,#4c8dff)] focus:ring-2 focus:ring-[color-mix(in_srgb,var(--app-theme-focus,#4c8dff)_24%,transparent)]"
              style="background: var(--app-theme-surface, #17171a); border-color: var(--app-theme-border, #27272c); color: var(--app-theme-text, #f4f4f5)"
              maxlength="48"
              value={id}
              aria-label="Theme id"
              oninput={(event) => (id = (event.currentTarget as HTMLInputElement).value)}
            />
          </label>
        </div>

        <fieldset class="mt-6">
          <legend class="text-sm font-semibold">Base appearance</legend>
          <p class="mt-1 text-xs" style="color: var(--app-theme-text-muted, #92939b)">Choose which palette is the primary version in the exported file.</p>
          <div class="mt-3 grid grid-cols-2 gap-3">
            {#each [
              { value: "light" as const, label: "Light", icon: Sun, palette: lightColors },
              { value: "dark" as const, label: "Dark", icon: Moon, palette: darkColors },
            ] as option (option.value)}
              <button
                type="button"
                class="flex items-center gap-3 rounded-sm border px-3 py-3 text-left transition hover:bg-[var(--app-theme-sidebar-row-hover,#1a1a1d)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-theme-focus,#4c8dff)]"
                style={`background: var(--app-theme-surface); border-color: ${activeAppearance === option.value ? "var(--app-theme-text-muted)" : "var(--app-theme-border-subtle)"}`}
                aria-pressed={activeAppearance === option.value}
                onclick={() => setAppearance(option.value)}
              >
                <span class="flex h-8 w-8 shrink-0 items-center justify-center rounded-sm bg-[var(--app-theme-muted)] text-[var(--app-theme-text-muted)]">
                  <option.icon aria-hidden="true" size={15} />
                </span>
                <span class="min-w-0 flex-1">
                  <span class="block text-sm font-semibold">{option.label}</span>
                  <span class="mt-0.5 block truncate text-xs" style="color: var(--app-theme-text-muted, #92939b)">{option.palette.canvas}</span>
                </span>
                {#if activeAppearance === option.value}<Check aria-hidden="true" size={15} class="shrink-0" />{/if}
              </button>
            {/each}
          </div>
        </fieldset>

        <section class="mt-6" aria-labelledby="theme-colors-heading">
          <div class="flex items-end justify-between gap-3">
            <div>
              <h3 id="theme-colors-heading" class="text-sm font-semibold">{activeAppearance === "light" ? "Light" : "Dark"} colors</h3>
              <p class="mt-1 text-xs" style="color: var(--app-theme-text-muted, #92939b)">Canvas sets the mood; accent carries focus and selection.</p>
            </div>
            <Palette aria-hidden="true" size={17} style="color: var(--app-theme-accent, #8d9cff)" />
          </div>

          <div class="mt-3 grid gap-3 sm:grid-cols-2">
            <label class="rounded-md border p-3" style="background: var(--app-theme-surface, #0b0b0d); border-color: var(--app-theme-border, #27272c)">
              <span class="flex items-center justify-between gap-3">
                <span>
                  <span class="block text-sm font-semibold">Canvas</span>
                  <span class="mt-0.5 block text-xs" style="color: var(--app-theme-text-muted, #92939b)">Main application background</span>
                </span>
                <input
                  class="h-8 w-10 cursor-pointer rounded-md border-0 bg-transparent p-0.5"
                  type="color"
                  value={colorInputValue(activeColors.canvas)}
                  aria-label={`${activeAppearance} canvas color picker`}
                  onchange={(event) => updateTextColor(activeAppearance, "canvas", (event.currentTarget as HTMLInputElement).value)}
                />
              </span>
              <input
                class="mt-3 h-9 w-full rounded-md border px-2.5 font-mono text-xs outline-none transition focus:border-[var(--app-theme-focus,#4c8dff)] focus:ring-2 focus:ring-[color-mix(in_srgb,var(--app-theme-focus,#4c8dff)_24%,transparent)]"
                style="background: var(--app-theme-surface, #17171a); border-color: var(--app-theme-border, #27272c); color: var(--app-theme-text, #f4f4f5)"
                value={activeCanvas}
                aria-label={`${activeAppearance} canvas CSS color`}
                oninput={(event) => updateTextColor(activeAppearance, "canvas", (event.currentTarget as HTMLInputElement).value)}
              />
            </label>

            <label class="rounded-md border p-3" style="background: var(--app-theme-surface, #0b0b0d); border-color: var(--app-theme-border, #27272c)">
              <span class="flex items-center justify-between gap-3">
                <span>
                  <span class="block text-sm font-semibold">Accent</span>
                  <span class="mt-0.5 block text-xs" style="color: var(--app-theme-text-muted, #92939b)">Focus rings and selected states</span>
                </span>
                <input
                  class="h-8 w-10 cursor-pointer rounded-md border-0 bg-transparent p-0.5"
                  type="color"
                  value={colorInputValue(activeColors.accent)}
                  aria-label={`${activeAppearance} accent color picker`}
                  onchange={(event) => updateTextColor(activeAppearance, "accent", (event.currentTarget as HTMLInputElement).value)}
                />
              </span>
              <input
                class="mt-3 h-9 w-full rounded-md border px-2.5 font-mono text-xs outline-none transition focus:border-[var(--app-theme-focus,#4c8dff)] focus:ring-2 focus:ring-[color-mix(in_srgb,var(--app-theme-focus,#4c8dff)_24%,transparent)]"
                style="background: var(--app-theme-surface, #17171a); border-color: var(--app-theme-border, #27272c); color: var(--app-theme-text, #f4f4f5)"
                value={activeAccent}
                aria-label={`${activeAppearance} accent CSS color`}
                oninput={(event) => updateTextColor(activeAppearance, "accent", (event.currentTarget as HTMLInputElement).value)}
              />
            </label>
          </div>

          <div class="mt-5 border-t pt-4" style="border-color: var(--app-theme-border, #27272c)">
            <div class="flex items-end justify-between gap-3">
              <div>
                <h4 class="text-sm font-semibold">Graph lanes</h4>
                <p class="mt-1 text-xs" style="color: var(--app-theme-text-muted, #92939b)">Colors repeat when a history needs more than nine lanes.</p>
              </div>
              <div class="flex items-center gap-1" aria-hidden="true">
                {#each GRAPH_THEME_COLOR_ROLES.slice(0, 5) as role (role)}
                  <span class="h-1.5 w-4 rounded-full" style={`background: ${activeColors[role]}`}></span>
                {/each}
              </div>
            </div>

            <div class="mt-3 grid grid-cols-3 gap-2 sm:grid-cols-5 lg:grid-cols-9">
              {#each GRAPH_THEME_COLOR_ROLES as role, index (role)}
                <label
                  class="flex min-w-0 items-center gap-2 rounded-md border px-2 py-2"
                  style="background: var(--app-theme-surface, #0b0b0d); border-color: var(--app-theme-border, #27272c)"
                  title={`Graph lane ${index + 1}: ${activeColors[role]}`}
                >
                  <input
                    class="h-6 w-7 shrink-0 cursor-pointer rounded border-0 bg-transparent p-0"
                    type="color"
                    value={colorInputValue(activeColors[role])}
                    aria-label={`${activeAppearance} graph lane ${index + 1} color`}
                    oninput={(event) => updateGraphColor(activeAppearance, role, (event.currentTarget as HTMLInputElement).value)}
                  />
                  <span class="truncate text-[11px] font-semibold" style="color: var(--app-theme-text-muted, #92939b)">{index + 1}</span>
                </label>
              {/each}
            </div>
          </div>

          <div class="mt-3 h-32 overflow-hidden rounded-md border" style={`border-color: ${activeColors.border}`} aria-label={`${activeAppearance} theme preview`}>
            <ThemeWireframe mode={activeAppearance} lightPalette={lightColors} darkPalette={darkColors} />
          </div>
        </section>

        {#if errorMessage}
          <div class="mt-4 flex items-start gap-2 rounded-md border px-3 py-2.5 text-sm" style="background: var(--app-theme-error-surface, #351b1d); border-color: color-mix(in srgb, var(--app-theme-error,#f97066) 40%, transparent); color: var(--app-theme-error-foreground, #fff)" role="alert">
            <AlertCircle class="mt-0.5 shrink-0" aria-hidden="true" size={16} />
            <span>{errorMessage}</span>
          </div>
        {:else}
          <p class="mt-4 flex items-center gap-2 text-xs" style="color: var(--app-theme-text-muted, #92939b)">
            <Check aria-hidden="true" size={14} style="color: var(--app-theme-accent, #8d9cff)" />
            Both light and dark palettes will be saved in the theme file.
          </p>
        {/if}
      </form>

      <footer class="flex flex-col-reverse gap-2 border-t px-5 py-4 sm:flex-row sm:justify-end" style="border-color: var(--app-theme-border, #27272c)">
        <button
          type="button"
          class="h-9 rounded-sm px-3 text-sm font-semibold transition hover:bg-[var(--app-theme-sidebar-row-hover,#1a1a1d)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-theme-focus,#4c8dff)]"
          style="color: var(--app-theme-text-muted, #92939b)"
          onclick={() => onCancel?.()}
        >
          Cancel
        </button>
        <button
          type="button"
          class="h-9 rounded-sm px-4 text-sm font-semibold transition disabled:cursor-not-allowed disabled:opacity-45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-theme-focus,#4c8dff)]"
          style="background: var(--app-theme-accent, #8d9cff); color: var(--app-theme-accent-foreground, #101116)"
          onclick={save}
        >
          {theme ? "Save changes" : "Create theme"}
        </button>
      </footer>
  </dialog>
{/if}
