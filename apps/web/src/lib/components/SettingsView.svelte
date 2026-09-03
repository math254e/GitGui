<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import {
    ExternalLink,
    GitBranch,
    Info,
    Link2,
    Palette,
    Settings,
  } from "@lucide/svelte";
  import {
    applyThemeColorPreview,
    BUILT_IN_THEMES,
    DEFAULT_THEME_ID,
    getCustomThemes,
    getThemeColorsForMode,
    getThemeDefinition,
    installCustomTheme,
    removeCustomTheme,
    themeIdFromName,
    updateCustomTheme,
  } from "$lib/theme/themePalette";
  import { themeStore } from "$lib/theme/useTheme";
  import type {
    ThemeAppearance,
    ThemeColors,
    ThemeDefinition as RuntimeThemeDefinition,
    ThemePreferenceMode,
    ThemeSnapshot,
  } from "$lib/theme/types";
  import ThemeAppearancePanel from "$lib/components/settings/ThemeAppearancePanel.svelte";
  import ThemeDeleteDialog from "$lib/components/settings/ThemeDeleteDialog.svelte";
  import ThemeEditorPanel from "$lib/components/settings/ThemeEditorPanel.svelte";
  import ThemeImportDialog from "$lib/components/settings/ThemeImportDialog.svelte";
  import type {
    ThemeDefinition as PreviewThemeDefinition,
    ThemePalette,
  } from "$lib/components/settings/theme-types";
  import {
    readBranchSwitchMergePreference,
    resolveProjectsLocation,
    writeProjectsLocationPreference,
    writeBranchSwitchMergePreference,
  } from "$lib/preferences";
  import { useWebApplicationRuntime, type WebApplicationRuntimeState } from "$lib/connection/runtime";
  import type { DesktopSshHost, DesktopUpdateStatus } from "@gitgui/contracts/desktop";

  type SettingsSection = "general" | "appearance" | "connections";
  type BranchSwitchMode = "normal" | "merge";

  let activeSection = $state<SettingsSection>("general");
  let branchSwitchMode = $state<BranchSwitchMode>(readBranchSwitchMergePreference() ? "merge" : "normal");
  let projectsLocation = $state("");
  let projectsLocationCanBrowse = $state(false);
  let gitExecutable = $state("git");
  let autoFetch = $state(true);
  let themeNotice = $state("");
  let showThemeEditor = $state(false);
  let showThemeImport = $state(false);
  let editingTheme = $state<RuntimeThemeDefinition | null>(null);
  let removeThemeTarget = $state<RuntimeThemeDefinition | null>(null);
  let themeSnapshot = $state<ThemeSnapshot>(themeStore.getSnapshot());
  let customThemes = $state<ReadonlyArray<RuntimeThemeDefinition>>(getCustomThemes());
  const applicationRuntime = useWebApplicationRuntime();
  let runtimeState = $state<WebApplicationRuntimeState>(applicationRuntime.state);
  let connectionNotice = $state("");
  let connectionBusy = $state(false);
  let directUrl = $state("");
  let directToken = $state("");
  let directCredentialKind = $state<"pairing" | "bearer">("pairing");
  let sshHost = $state("");
  let sshUser = $state("");
  let sshPort = $state("");
  let sshIdentityFile = $state("");
  let sshToken = $state("");
  let discoveredSshHosts = $state<DesktopSshHost[]>([]);
  let unsubscribeRuntime: (() => void) | undefined;
  let unsubscribeUpdates: (() => void) | undefined;
  let updateStatus = $state<DesktopUpdateStatus>({ phase: "disabled" });

  const sections: Array<{ id: SettingsSection; label: string }> = [
    { id: "general", label: "General" },
    { id: "appearance", label: "Appearance" },
    { id: "connections", label: "Connections" },
  ];

  const unsubscribeTheme = themeStore.subscribe((snapshot) => {
    themeSnapshot = snapshot;
    customThemes = getCustomThemes();
  });

  onDestroy(() => {
    unsubscribeTheme();
    unsubscribeRuntime?.();
    unsubscribeUpdates?.();
  });

  onMount(() => {
    projectsLocationCanBrowse = Boolean(window.desktopBridge);
    unsubscribeRuntime = applicationRuntime.subscribe((state) => (runtimeState = state));
    void loadProjectsLocation();
    if (applicationRuntime.isDesktop) void loadSshHosts();
    if (window.desktopBridge) {
      void window.desktopBridge.getUpdateStatus().then((status) => (updateStatus = status));
      unsubscribeUpdates = window.desktopBridge.onUpdateStatus((status) => (updateStatus = status));
    }
  });

  const sectionTitle = $derived(
    sections.find((section) => section.id === activeSection)?.label ?? "General",
  );
  const allThemes = $derived([...BUILT_IN_THEMES, ...customThemes]);
  const previewThemes = $derived(allThemes.map(toPreviewTheme));
  const selectedThemeIds = $derived({
    light: themeSnapshot.themeHalves?.light ?? themeSnapshot.theme,
    dark: themeSnapshot.themeHalves?.dark ?? themeSnapshot.theme,
  });

  function toPreviewPalette(colors: ThemeColors): ThemePalette {
    return {
      canvas: colors.canvas,
      sidebar: colors.sidebar,
      sidebarForeground: colors.sidebarForeground,
      sidebarMutedForeground: colors.sidebarMutedForeground,
      sidebarBorder: colors.sidebarBorder,
      sidebarRowHover: colors.sidebarRowHover,
      sidebarRowSelected: colors.sidebarRowSelected,
      surface: colors.surface,
      surfaceRaised: colors.surfaceRaised,
      surfaceOverlay: colors.surfaceOverlay,
      text: colors.text,
      textMuted: colors.textMuted,
      border: colors.border,
      accent: colors.accent,
      accentForeground: colors.accentForeground,
      accentSurface: colors.accentSurface,
      messageSurface: colors.messageSurface,
      messageAction: colors.messageAction,
    };
  }

  function toPreviewTheme(theme: RuntimeThemeDefinition): PreviewThemeDefinition {
    const light = getThemeColorsForMode(theme, "light") ?? theme.colors;
    const dark = getThemeColorsForMode(theme, "dark") ?? theme.colors;

    return {
      id: theme.id,
      label: theme.label,
      colors: {
        light: toPreviewPalette(light),
        dark: toPreviewPalette(dark),
      },
      collection: theme.collection?.id,
      managed: theme.managed,
      removable: customThemes.some((customTheme) => customTheme.id === theme.id),
    };
  }

  function selectSection(section: SettingsSection) {
    activeSection = section;
    themeNotice = "";
  }

  function setBranchSwitchMode(mode: BranchSwitchMode) {
    branchSwitchMode = mode;
    writeBranchSwitchMergePreference(mode === "merge");
  }

  function handleBranchSwitchModeChange(event: Event) {
    const value = (event.currentTarget as HTMLSelectElement).value;
    setBranchSwitchMode(value === "merge" ? "merge" : "normal");
  }

  async function loadProjectsLocation() {
    projectsLocation = await resolveProjectsLocation();
  }

  function handleProjectsLocationInput(event: Event) {
    projectsLocation = (event.currentTarget as HTMLInputElement).value;
    writeProjectsLocationPreference(projectsLocation);
  }

  async function browseProjectsLocation() {
    if (!projectsLocationCanBrowse) return;

    try {
      const selectedPath = await window.desktopBridge?.pickFolder();
      if (typeof selectedPath === "string") {
        projectsLocation = selectedPath;
        writeProjectsLocationPreference(selectedPath);
      }
    } catch {
      themeNotice = "The default project location could not be selected.";
    }
  }

  function setAppearanceMode(mode: ThemePreferenceMode) {
    if (!themeStore.setAppearanceMode(mode)) {
      themeNotice = "The appearance preference could not be saved.";
      return;
    }
    themeNotice = "";
  }

  function selectTheme(themeId: string, appearance: ThemePreferenceMode) {
    const saved = appearance === "system"
      ? themeStore.setTheme(themeId)
      : themeStore.setThemeHalf(appearance as ThemeAppearance, themeId);

    themeNotice = saved ? "" : "The theme selection could not be saved.";
  }

  function duplicateTheme(themeId: string) {
    const source = getThemeDefinition(themeId);
    if (!source) return;

    const existingIds = new Set(allThemes.map((theme) => theme.id));
    let copyId = themeIdFromName(`${source.label}-copy`);
    let suffix = 2;
    while (existingIds.has(copyId)) {
      copyId = themeIdFromName(`${source.label}-copy-${suffix}`);
      suffix += 1;
    }

    try {
      installCustomTheme({
        ...source,
        id: copyId,
        label: `${source.label} Copy`,
        managed: false,
      });
      customThemes = getCustomThemes();
      themeStore.setTheme(copyId);
      themeNotice = `${source.label} copied.`;
    } catch {
      themeNotice = "That theme could not be copied.";
    }
  }

  function requestRemoveTheme(themeId: string) {
    const target = customThemes.find((theme) => theme.id === themeId);
    if (!target) return;
    removeThemeTarget = target;
    themeNotice = "";
  }

  function confirmRemoveTheme() {
    const target = removeThemeTarget;
    if (!target) return;

    try {
      const baseIsActive = themeSnapshot.theme === target.id;
      if (baseIsActive) {
        if (!themeStore.setTheme(DEFAULT_THEME_ID)) {
          throw new Error("The active theme could not be changed.");
        }
      } else {
        for (const appearance of ["light", "dark"] as const) {
          if (themeSnapshot.themeHalves?.[appearance] !== target.id) continue;
          if (!themeStore.setThemeHalf(appearance, null)) {
            throw new Error("The active theme variant could not be changed.");
          }
        }
      }

      removeCustomTheme(target.id);
      customThemes = getCustomThemes();
      themeStore.refreshTheme();
      removeThemeTarget = null;
      themeNotice = `${target.label} removed.`;
    } catch (error) {
      themeNotice = error instanceof Error ? error.message : "That theme could not be removed.";
    }
  }

  function openThemeEditor() {
    editingTheme = null;
    showThemeEditor = true;
    themeNotice = "";
  }

  function openThemeImport() {
    showThemeImport = true;
    themeNotice = "";
  }

  function closeThemeEditor() {
    showThemeEditor = false;
    editingTheme = null;
    themeStore.refreshTheme();
  }

  function saveTheme(theme: RuntimeThemeDefinition) {
    try {
      if (editingTheme) updateCustomTheme(theme);
      else installCustomTheme(theme);
      customThemes = getCustomThemes();
      themeStore.setTheme(theme.id);
      showThemeEditor = false;
      editingTheme = null;
      themeStore.refreshTheme();
      themeNotice = `${theme.label} saved.`;
    } catch (error) {
      themeNotice = error instanceof Error ? error.message : "That theme could not be saved.";
    }
  }

  function importTheme(theme: RuntimeThemeDefinition) {
    try {
      installCustomTheme(theme);
      customThemes = getCustomThemes();
      themeStore.setTheme(theme.id);
      showThemeImport = false;
      themeNotice = `${theme.label} imported.`;
    } catch (error) {
      themeNotice = error instanceof Error ? error.message : "That theme could not be imported.";
    }
  }

  async function addDirectEnvironment() {
    const endpoint = directUrl.trim();
    if (!endpoint) {
      connectionNotice = "Enter the backend HTTP or HTTPS URL.";
      return;
    }
    connectionBusy = true;
    connectionNotice = "Connecting and verifying the environment…";
    try {
      await applicationRuntime.addDirect(
        endpoint,
        directToken.trim()
          ? { kind: directCredentialKind, token: directToken.trim() }
          : undefined,
      );
      directToken = "";
      connectionNotice = "Environment connected and saved.";
    } catch (error) {
      connectionNotice = error instanceof Error ? error.message : "The environment could not be connected.";
    } finally {
      connectionBusy = false;
    }
  }

  async function addSshEnvironment() {
    if (!sshHost.trim()) {
      connectionNotice = "Enter an SSH host or select one from your SSH configuration.";
      return;
    }
    const parsedPort = sshPort.trim() ? Number(sshPort) : undefined;
    connectionBusy = true;
    connectionNotice = "Preparing the SSH environment…";
    try {
      await applicationRuntime.addSsh(
        {
          kind: "ssh",
          host: sshHost.trim(),
          ...(sshUser.trim() ? { user: sshUser.trim() } : {}),
          ...(parsedPort !== undefined ? { port: parsedPort } : {}),
          ...(sshIdentityFile.trim() ? { identityFile: sshIdentityFile.trim() } : {}),
        },
        sshToken.trim() ? { kind: "pairing", token: sshToken.trim() } : undefined,
      );
      sshToken = "";
      connectionNotice = "SSH environment connected and saved.";
    } catch (error) {
      connectionNotice = error instanceof Error ? error.message : "The SSH environment could not be connected.";
    } finally {
      connectionBusy = false;
    }
  }

  async function loadSshHosts() {
    try {
      discoveredSshHosts = await applicationRuntime.discoverSshHosts();
    } catch (error) {
      connectionNotice = error instanceof Error ? error.message : "SSH hosts could not be discovered.";
    }
  }

  function chooseSshHost(event: Event) {
    const alias = (event.currentTarget as HTMLSelectElement).value;
    const host = discoveredSshHosts.find((candidate) => candidate.alias === alias);
    if (!host) return;
    sshHost = host.alias;
    sshUser = host.user ?? "";
    sshPort = host.port ? String(host.port) : "";
  }

  async function removeEnvironment(environmentId: string, displayName: string) {
    if (!window.confirm(`Remove ${displayName} and its saved credentials from this client?`)) return;
    connectionBusy = true;
    try {
      await applicationRuntime.removeEnvironment(environmentId);
      connectionNotice = `${displayName} removed.`;
    } catch (error) {
      connectionNotice = error instanceof Error ? error.message : "The environment could not be removed.";
    } finally {
      connectionBusy = false;
    }
  }

  async function checkForUpdates() {
    updateStatus = await window.desktopBridge?.checkForUpdates() ?? updateStatus;
  }

  async function installUpdate() {
    await window.desktopBridge?.installUpdate();
  }
</script>

<section class="h-full min-h-0 overflow-auto bg-[var(--app-theme-canvas)] text-[var(--app-theme-text)]">
  <div class="flex min-h-full w-full flex-col lg:flex-row">
    <aside class="w-full shrink-0 border-b border-[var(--app-theme-sidebar-border)] bg-[var(--app-theme-sidebar)] lg:w-[258px] lg:border-r lg:border-b-0">
      <div class="lg:sticky lg:top-0">
        <nav aria-label="Settings categories">
          {#each sections as section (section.id)}
            <button
              type="button"
              class={`flex h-12 w-full items-center gap-3 border-b border-[var(--app-theme-sidebar-border)] px-4 text-left transition-colors ${
                activeSection === section.id
                  ? "bg-[var(--app-theme-sidebar-row-active)] text-[var(--app-theme-sidebar-foreground)]"
                  : "bg-[var(--app-theme-sidebar)] text-[var(--app-theme-sidebar-muted-foreground)] hover:bg-[var(--app-theme-sidebar-row-hover)] hover:text-[var(--app-theme-sidebar-foreground)]"
              }`}
              aria-current={activeSection === section.id ? "page" : undefined}
              onclick={() => selectSection(section.id)}
            >
              {#if section.id === "general"}
                <Settings aria-hidden="true" class="mt-0.5 shrink-0" size={17} />
              {:else if section.id === "appearance"}
                <Palette aria-hidden="true" class="mt-0.5 shrink-0" size={17} />
              {:else}
                <Link2 aria-hidden="true" class="mt-0.5 shrink-0" size={17} />
              {/if}
              <span class="text-sm font-semibold">{section.label}</span>
            </button>
          {/each}
        </nav>
      </div>
    </aside>

    <main class="min-w-0 flex-1">
      {#if activeSection === "appearance"}
        <ThemeAppearancePanel
          themes={previewThemes}
          selectedThemeId={themeSnapshot.theme}
          selectedThemeIds={selectedThemeIds}
          appearanceMode={themeSnapshot.appearanceMode}
          selectedThemeAppearance={themeSnapshot.appearanceMode}
          onAppearanceModeChange={setAppearanceMode}
          onThemeSelect={selectTheme}
          onCreateTheme={openThemeEditor}
          onImportTheme={openThemeImport}
          onDuplicateTheme={duplicateTheme}
          onRemoveTheme={requestRemoveTheme}
        />
        {#if themeNotice}
          <p class="mx-auto max-w-[1080px] px-5 pb-6 text-sm text-[var(--app-theme-text-muted)] sm:px-8 lg:px-12" aria-live="polite">
            {themeNotice}
          </p>
        {/if}
      {:else}
        <div class="mx-auto max-w-[920px] px-6 py-8 sm:px-8 lg:px-12 lg:py-12">
          <header class="border-b border-[var(--app-theme-border)] pb-8">
            <p class="text-sm font-medium text-[var(--app-theme-text-subtle)]">Settings / {sectionTitle}</p>
            <div class="mt-3 flex flex-wrap items-end justify-between gap-4">
              <div>
                <h2 class="text-[28px] font-semibold tracking-[-0.03em] text-[var(--app-theme-text)]">{sectionTitle}</h2>
                <p class="mt-2 max-w-[620px] text-sm leading-6 text-[var(--app-theme-text-muted)]">
                  {#if activeSection === "general"}
                    Choose how GitGui handles local changes when switching branches.
                  {:else}
                    Configure how GitGui finds Git and connects to repositories.
                  {/if}
                </p>
              </div>
            </div>
          </header>

          {#if activeSection === "general"}
            <div class="divide-y divide-[var(--app-theme-border-subtle)]">
              <section class="py-7" aria-labelledby="general-project-location">
                <div class="mb-5">
                  <h3 id="general-project-location" class="text-sm font-semibold text-[var(--app-theme-text)]">Default project location</h3>
                  <p class="mt-1 text-sm text-[var(--app-theme-text-subtle)]">New repositories start here by default.</p>
                </div>
                <label class="block max-w-[620px]" for="projects-location">
                  <span class="mb-2 block text-xs font-semibold uppercase tracking-[0.08em] text-[var(--app-theme-text-subtle)]">Location</span>
                  <div class="flex gap-2">
                    <input
                      id="projects-location"
                      class="h-8 min-w-0 flex-1 rounded-[2px] border border-[var(--app-theme-input)] bg-[var(--app-theme-canvas)] px-3 font-mono text-sm text-[var(--app-theme-text-secondary)] outline-none transition placeholder:text-[var(--app-theme-placeholder)] focus:border-[var(--app-theme-focus)] focus:ring-2 focus:ring-[var(--app-theme-focus-ring)]"
                      type="text"
                      autocomplete="off"
                      spellcheck="false"
                      placeholder="Documents"
                      value={projectsLocation}
                      oninput={handleProjectsLocationInput}
                    />
                    <button
                      type="button"
                      class="inline-flex h-8 items-center gap-2 rounded-[2px] border border-[var(--app-theme-border)] bg-[var(--app-theme-surface-raised)] px-3 text-sm font-semibold text-[var(--app-theme-text-muted)] transition hover:bg-[var(--app-theme-sidebar-row-hover)] disabled:cursor-not-allowed disabled:opacity-45"
                      disabled={!projectsLocationCanBrowse}
                      title={projectsLocationCanBrowse ? "Browse for a folder" : "Folder browsing is available in the desktop app"}
                      onclick={() => void browseProjectsLocation()}
                    >
                      Browse
                    </button>
                  </div>
                </label>
              </section>

              <section class="py-7">
                <label class="flex flex-wrap items-center justify-between gap-4 py-3" for="branch-switch-mode">
                  <span>
                    <span class="block text-sm font-medium text-[var(--app-theme-text-secondary)]">Branch switch mode</span>
                    <span class="mt-1 block max-w-[620px] text-xs leading-5 text-[var(--app-theme-text-subtle)]">Normal keeps local changes in place. Merge uses <code class="rounded bg-[var(--app-theme-muted)] px-1 py-0.5 font-mono text-[11px]">git switch --merge</code> and may leave conflicts to resolve.</span>
                  </span>
                  <select
                    id="branch-switch-mode"
                    value={branchSwitchMode}
                    onchange={handleBranchSwitchModeChange}
                    class="h-9 w-full max-w-[190px] rounded-md border border-[var(--app-theme-border)] bg-[var(--app-theme-input)] px-3 text-sm text-[var(--app-theme-text-secondary)] outline-none transition focus:border-[var(--app-theme-focus)] focus:ring-2 focus:ring-[var(--app-theme-focus-ring)]"
                  >
                    <option value="normal">Normal</option>
                    <option value="merge">Merge</option>
                  </select>
                </label>
              </section>

              {#if window.desktopBridge}
                <section class="py-7" aria-labelledby="general-updates">
                  <div class="flex flex-wrap items-center justify-between gap-4">
                    <div>
                      <h3 id="general-updates" class="text-sm font-semibold text-[var(--app-theme-text)]">Desktop updates</h3>
                      <p class="mt-1 text-xs text-[var(--app-theme-text-subtle)]">
                        {updateStatus.message ?? (updateStatus.version ? `${updateStatus.phase} · ${updateStatus.version}` : updateStatus.phase)}
                      </p>
                    </div>
                    {#if updateStatus.phase === "downloaded"}
                      <button type="button" onclick={installUpdate} class="h-8 rounded-md bg-[var(--app-theme-accent)] px-3 text-xs font-semibold text-[var(--app-theme-accent-foreground)]">Restart and install</button>
                    {:else}
                      <button type="button" onclick={checkForUpdates} disabled={updateStatus.phase === "checking" || updateStatus.phase === "disabled"} class="h-8 rounded-md border border-[var(--app-theme-border)] bg-[var(--app-theme-surface-raised)] px-3 text-xs font-semibold text-[var(--app-theme-text-muted)] disabled:opacity-50">Check for updates</button>
                    {/if}
                  </div>
                </section>
              {/if}
            </div>
          {:else}
            <div class="divide-y divide-[var(--app-theme-border-subtle)]">
              <section class="py-7" aria-labelledby="connections-git">
                <div class="mb-5">
                  <h3 id="connections-git" class="text-sm font-semibold text-[var(--app-theme-text)]">Git installation</h3>
                  <p class="mt-1 text-sm text-[var(--app-theme-text-subtle)]">GitGui uses the system Git executable for repository operations.</p>
                </div>
                <label class="block max-w-[560px]" for="git-executable">
                  <span class="mb-2 block text-xs font-semibold uppercase tracking-[0.08em] text-[var(--app-theme-text-subtle)]">Executable path</span>
                  <div class="flex gap-2">
                    <input id="git-executable" bind:value={gitExecutable} class="h-9 min-w-0 flex-1 rounded-md border border-[var(--app-theme-border)] bg-[var(--app-theme-input)] px-3 text-sm text-[var(--app-theme-text-secondary)] outline-none transition focus:border-[var(--app-theme-focus)] focus:ring-2 focus:ring-[var(--app-theme-focus-ring)]" />
                    <button type="button" class="inline-flex h-9 items-center gap-2 rounded-md border border-[var(--app-theme-border)] bg-[var(--app-theme-surface-raised)] px-3 text-sm font-semibold text-[var(--app-theme-text-muted)] transition hover:bg-[var(--app-theme-control-hover)]">Detect</button>
                  </div>
                </label>
              </section>

              <section class="py-7" aria-labelledby="connections-environments">
                <div class="mb-5">
                  <h3 id="connections-environments" class="text-sm font-semibold text-[var(--app-theme-text)]">Environments</h3>
                  <p class="mt-1 text-sm text-[var(--app-theme-text-subtle)]">Each environment is one independent GitGui backend and repository catalog.</p>
                </div>
                <div class="divide-y divide-[var(--app-theme-border-subtle)] border-y border-[var(--app-theme-border-subtle)]">
                  {#each runtimeState.registry.entries as entry (entry.registration.environmentId)}
                    <div class="flex flex-wrap items-center justify-between gap-4 py-4">
                      <div class="flex min-w-0 items-center gap-3">
                        <span
                          class={`h-2.5 w-2.5 shrink-0 rounded-full ${entry.connection.phase === "connected" ? "bg-[var(--app-theme-success)] shadow-[0_0_0_4px_var(--app-theme-success-surface)]" : entry.connection.phase === "blocked" ? "bg-[var(--app-theme-danger)]" : "bg-[var(--app-theme-muted)]"}`}
                          aria-hidden="true"
                        ></span>
                        <div class="min-w-0">
                          <p class="truncate text-sm font-semibold text-[var(--app-theme-text-secondary)]">{entry.registration.displayName}</p>
                          <p class="mt-1 truncate text-xs text-[var(--app-theme-text-subtle)]">
                            {entry.registration.target.kind} · {entry.connection.phase} · {entry.registration.environmentId}
                          </p>
                        </div>
                      </div>
                      <div class="flex items-center gap-2">
                        {#if runtimeState.registry.selectedEnvironmentId !== entry.registration.environmentId}
                          <button type="button" disabled={connectionBusy} onclick={() => applicationRuntime.selectEnvironment(entry.registration.environmentId)} class="inline-flex h-8 items-center rounded-md border border-[var(--app-theme-border)] bg-[var(--app-theme-surface-raised)] px-3 text-xs font-semibold text-[var(--app-theme-text-muted)] disabled:opacity-50">Use</button>
                        {:else}
                          <span class="px-2 text-xs font-semibold text-[var(--app-theme-accent)]">Active</span>
                        {/if}
                        {#if entry.connection.phase === "blocked" || entry.connection.phase === "waiting" || entry.connection.phase === "offline"}
                          <button type="button" disabled={connectionBusy} onclick={() => applicationRuntime.registry.retry(entry.registration.environmentId)} class="inline-flex h-8 items-center rounded-md border border-[var(--app-theme-border)] bg-[var(--app-theme-surface-raised)] px-3 text-xs font-semibold text-[var(--app-theme-text-muted)] disabled:opacity-50">Retry</button>
                        {/if}
                        {#if entry.registration.target.kind !== "primary"}
                          <button type="button" disabled={connectionBusy} onclick={() => removeEnvironment(entry.registration.environmentId, entry.registration.displayName)} class="inline-flex h-8 items-center rounded-md border border-[var(--app-theme-border)] px-3 text-xs font-semibold text-[var(--app-theme-danger)] disabled:opacity-50">Remove</button>
                        {/if}
                      </div>
                    </div>
                  {:else}
                    <p class="py-4 text-sm text-[var(--app-theme-text-subtle)]">No environment is configured.</p>
                  {/each}
                </div>
              </section>

              <section class="py-7" aria-labelledby="connections-direct">
                <div class="mb-5">
                  <h3 id="connections-direct" class="text-sm font-semibold text-[var(--app-theme-text)]">Direct backend</h3>
                  <p class="mt-1 text-sm text-[var(--app-theme-text-subtle)]">Connect directly over HTTP/WebSocket. Tailscale endpoints use this same connection type.</p>
                </div>
                <div class="grid max-w-[720px] gap-3 md:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
                  <label class="block md:col-span-2">
                    <span class="mb-1 block text-xs font-semibold text-[var(--app-theme-text-subtle)]">Backend URL</span>
                    <input bind:value={directUrl} placeholder="https://git.example.com" class="h-9 w-full rounded-md border border-[var(--app-theme-border)] bg-[var(--app-theme-input)] px-3 text-sm outline-none" />
                  </label>
                  <label class="block">
                    <span class="mb-1 block text-xs font-semibold text-[var(--app-theme-text-subtle)]">Credential</span>
                    <input bind:value={directToken} type="password" autocomplete="off" placeholder="Pairing or bearer token" class="h-9 w-full rounded-md border border-[var(--app-theme-border)] bg-[var(--app-theme-input)] px-3 text-sm outline-none" />
                  </label>
                  <label class="block">
                    <span class="mb-1 block text-xs font-semibold text-[var(--app-theme-text-subtle)]">Credential type</span>
                    <select bind:value={directCredentialKind} class="h-9 w-full rounded-md border border-[var(--app-theme-border)] bg-[var(--app-theme-input)] px-3 text-sm outline-none">
                      <option value="pairing">Pairing token</option>
                      <option value="bearer">Bearer token</option>
                    </select>
                  </label>
                  <button type="button" disabled={connectionBusy} onclick={addDirectEnvironment} class="h-9 w-fit rounded-md bg-[var(--app-theme-accent)] px-4 text-sm font-semibold text-[var(--app-theme-accent-foreground)] disabled:opacity-50">Connect backend</button>
                </div>
              </section>

              {#if applicationRuntime.isDesktop}
                <section class="py-7" aria-labelledby="connections-ssh">
                  <div class="mb-5">
                    <h3 id="connections-ssh" class="text-sm font-semibold text-[var(--app-theme-text)]">SSH backend</h3>
                    <p class="mt-1 text-sm text-[var(--app-theme-text-subtle)]">Electron starts or restores the remote backend and gives the normal client runtime a forwarded endpoint.</p>
                  </div>
                  <div class="grid max-w-[720px] gap-3 md:grid-cols-2">
                    {#if discoveredSshHosts.length > 0}
                      <label class="block md:col-span-2">
                        <span class="mb-1 block text-xs font-semibold text-[var(--app-theme-text-subtle)]">Discovered host</span>
                        <select onchange={chooseSshHost} class="h-9 w-full rounded-md border border-[var(--app-theme-border)] bg-[var(--app-theme-input)] px-3 text-sm outline-none">
                          <option value="">Choose from SSH config or known hosts</option>
                          {#each discoveredSshHosts as host (host.alias)}<option value={host.alias}>{host.alias}</option>{/each}
                        </select>
                      </label>
                    {/if}
                    <label class="block"><span class="mb-1 block text-xs font-semibold text-[var(--app-theme-text-subtle)]">Host</span><input bind:value={sshHost} placeholder="build-host" class="h-9 w-full rounded-md border border-[var(--app-theme-border)] bg-[var(--app-theme-input)] px-3 text-sm outline-none" /></label>
                    <label class="block"><span class="mb-1 block text-xs font-semibold text-[var(--app-theme-text-subtle)]">User</span><input bind:value={sshUser} placeholder="Optional" class="h-9 w-full rounded-md border border-[var(--app-theme-border)] bg-[var(--app-theme-input)] px-3 text-sm outline-none" /></label>
                    <label class="block"><span class="mb-1 block text-xs font-semibold text-[var(--app-theme-text-subtle)]">SSH port</span><input bind:value={sshPort} inputmode="numeric" placeholder="22" class="h-9 w-full rounded-md border border-[var(--app-theme-border)] bg-[var(--app-theme-input)] px-3 text-sm outline-none" /></label>
                    <label class="block"><span class="mb-1 block text-xs font-semibold text-[var(--app-theme-text-subtle)]">Identity file</span><input bind:value={sshIdentityFile} placeholder="Optional" class="h-9 w-full rounded-md border border-[var(--app-theme-border)] bg-[var(--app-theme-input)] px-3 text-sm outline-none" /></label>
                    <label class="block md:col-span-2"><span class="mb-1 block text-xs font-semibold text-[var(--app-theme-text-subtle)]">Existing pairing token</span><input bind:value={sshToken} type="password" autocomplete="off" placeholder="Optional when GitGui starts the backend" class="h-9 w-full rounded-md border border-[var(--app-theme-border)] bg-[var(--app-theme-input)] px-3 text-sm outline-none" /></label>
                    <button type="button" disabled={connectionBusy} onclick={addSshEnvironment} class="h-9 w-fit rounded-md bg-[var(--app-theme-accent)] px-4 text-sm font-semibold text-[var(--app-theme-accent-foreground)] disabled:opacity-50">Connect over SSH</button>
                  </div>
                </section>
              {/if}

              <section class="py-7" aria-labelledby="connections-refresh">
                <div class="flex flex-wrap items-center justify-between gap-4">
                  <div class="flex items-start gap-3">
                    <GitBranch aria-hidden="true" class="mt-0.5 text-[var(--app-theme-text-muted)]" size={17} />
                    <div>
                      <h3 id="connections-refresh" class="text-sm font-semibold text-[var(--app-theme-text)]">Refresh repositories automatically</h3>
                      <p class="mt-1 text-xs text-[var(--app-theme-text-subtle)]">Check open repositories for new commits every 30 seconds.</p>
                    </div>
                  </div>
                  <button type="button" class={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${autoFetch ? "bg-[var(--app-theme-accent)]" : "bg-[var(--app-theme-muted)]"}`} role="switch" aria-checked={autoFetch} aria-label="Refresh repositories automatically" onclick={() => (autoFetch = !autoFetch)}>
                    <span class={`absolute top-1 h-4 w-4 rounded-full bg-[var(--app-theme-surface-raised)] shadow-sm transition-transform ${autoFetch ? "translate-x-6" : "translate-x-1"}`}></span>
                  </button>
                </div>
              </section>

              {#if connectionNotice}
                <p class="flex items-start gap-2 py-6 text-xs leading-5 text-[var(--app-theme-text-subtle)]"><Info aria-hidden="true" class="mt-0.5 shrink-0" size={14} />{connectionNotice}</p>
              {/if}
            </div>
          {/if}
        </div>
      {/if}
    </main>
  </div>
</section>

<ThemeImportDialog
  open={showThemeImport}
  onClose={() => (showThemeImport = false)}
  onImported={importTheme}
/>

<ThemeEditorPanel
  open={showThemeEditor}
  theme={editingTheme}
  onCancel={closeThemeEditor}
  onPreview={applyThemeColorPreview}
  onSave={saveTheme}
/>

<ThemeDeleteDialog
  open={removeThemeTarget !== null}
  theme={removeThemeTarget}
  onCancel={() => (removeThemeTarget = null)}
  onConfirm={confirmRemoveTheme}
/> 
