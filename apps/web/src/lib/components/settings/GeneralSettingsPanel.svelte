<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import { Info } from "@lucide/svelte";
  import {
    readBranchSwitchMergePreference,
    resolveProjectsLocation,
    writeProjectsLocationPreference,
    writeBranchSwitchMergePreference,
  } from "$lib/preferences";
  import type { DesktopUpdateStatus } from "@gitgui/contracts/desktop";

  type BranchSwitchMode = "normal" | "merge";

  let branchSwitchMode = $state<BranchSwitchMode>(
    readBranchSwitchMergePreference() ? "merge" : "normal",
  );
  let projectsLocation = $state("");
  let projectsLocationCanBrowse = $state(false);
  let updateStatus = $state<DesktopUpdateStatus>({ phase: "disabled" });
  let notice = $state("");
  let unsubscribeUpdates: (() => void) | undefined;

  onMount(() => {
    projectsLocationCanBrowse = Boolean(window.desktopBridge);
    void loadProjectsLocation();
    if (window.desktopBridge) {
      void window.desktopBridge.getUpdateStatus().then((status) => (updateStatus = status));
      unsubscribeUpdates = window.desktopBridge.onUpdateStatus((status) => (updateStatus = status));
    }
  });

  onDestroy(() => {
    unsubscribeUpdates?.();
  });

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
        notice = "";
      }
    } catch {
      notice = "The default project location could not be selected.";
    }
  }

  async function checkForUpdates() {
    updateStatus = await window.desktopBridge?.checkForUpdates() ?? updateStatus;
  }

  async function installUpdate() {
    await window.desktopBridge?.installUpdate();
  }
</script>

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

              {#if notice}
                <p class="flex items-start gap-2 py-6 text-xs leading-5 text-[var(--app-theme-text-subtle)]" aria-live="polite"><Info aria-hidden="true" class="mt-0.5 shrink-0" size={14} />{notice}</p>
              {/if}
            </div>
