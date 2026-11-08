<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import { Info } from "@lucide/svelte";
  import {
    readBranchSwitchMergePreference,
    resolveProjectsLocation,
    writeProjectsLocationPreference,
    writeBranchSwitchMergePreference,
  } from "$lib/preferences";
  import { getDesktopUi } from "$lib/updates/context.svelte";
  import { getDesktopReleaseUrl, getReleaseNotesPreview, type DesktopUpdateSnapshot } from "$lib/updates/controller";

  type BranchSwitchMode = "normal" | "merge";

  let branchSwitchMode = $state<BranchSwitchMode>(
    readBranchSwitchMergePreference() ? "merge" : "normal",
  );
  let projectsLocation = $state("");
  let projectsLocationCanBrowse = $state(false);
  const desktopUi = getDesktopUi();
  let updateSnapshot = $state<DesktopUpdateSnapshot | null>(desktopUi.updates?.getSnapshot() ?? null);
  let updateUnsubscribe: (() => void) | undefined;
  let notice = $state("");
  const updateStatus = $derived(updateSnapshot?.status ?? { phase: "disabled" as const });
  const notesPreview = $derived(getReleaseNotesPreview(updateStatus.releaseNotes));
  const releaseUrl = $derived(getDesktopReleaseUrl(updateStatus));
  const updateBusy = $derived(Boolean(updateSnapshot?.pendingAction) || updateStatus.phase === "checking" || updateStatus.phase === "downloading" || updateStatus.phase === "installing");

  onMount(() => {
    projectsLocationCanBrowse = desktopUi.pickFolder !== null;
    void loadProjectsLocation();
    updateUnsubscribe = desktopUi.updates?.subscribe((next) => (updateSnapshot = next));
  });

  onDestroy(() => {
    updateUnsubscribe?.();
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
      const selectedPath = await desktopUi.pickFolder?.();
      if (typeof selectedPath === "string") {
        projectsLocation = selectedPath;
        writeProjectsLocationPreference(selectedPath);
        notice = "";
      }
    } catch {
      notice = "The default project location could not be selected.";
    }
  }

  function checkForUpdates() {
    void desktopUi.updates?.check();
  }

  function statusSummary(status: typeof updateStatus): string {
    if (status.phase === "disabled") return status.message ?? "Updates are disabled for this desktop build.";
    if (status.phase === "current") return "GitGui is up to date.";
    if (status.phase === "available") return `Version ${status.availableVersion ?? ""} is available.`.trim();
    if (status.phase === "downloaded") return `Version ${status.downloadedVersion ?? status.availableVersion ?? ""} is ready to install.`.trim();
    if (status.phase === "checking") return "Checking for updates…";
    if (status.phase === "downloading") return `Downloading update${typeof status.downloadPercent === "number" ? ` · ${Math.floor(status.downloadPercent)}%` : "…"}`;
    if (status.phase === "installing") return "Installing update…";
    if (status.phase === "error") return status.message ?? "Update failed.";
    return status.message ?? "Updates have not been checked yet.";
  }
</script>

            <div class="divide-y divide-[var(--app-theme-border-subtle)]">
              <section class="py-7" aria-labelledby="general-project-location">
                <div class="mb-5">
                  <h3 id="general-project-location" class="text-base font-semibold text-[var(--app-theme-text)]">Default project location</h3>
                  <p class="mt-1 text-sm text-[var(--app-theme-text-subtle)]">New repositories start here by default.</p>
                </div>
                <label class="block max-w-[620px]" for="projects-location">
                  <span class="mb-2 block text-xs font-medium text-[var(--app-theme-text-subtle)]">Location</span>
                  <div class="flex gap-2">
                    <input
                      id="projects-location"
                      class="h-8 min-w-0 flex-1 rounded-sm border border-[var(--app-theme-input)] bg-[var(--app-theme-canvas)] px-3 font-mono text-sm text-[var(--app-theme-text-secondary)] outline-none transition placeholder:text-[var(--app-theme-placeholder)] focus:border-[var(--app-theme-focus)] focus:ring-2 focus:ring-[var(--app-theme-focus-ring)]"
                      type="text"
                      autocomplete="off"
                      spellcheck="false"
                      placeholder="Documents"
                      value={projectsLocation}
                      oninput={handleProjectsLocationInput}
                    />
                    <button
                      type="button"
                      class="inline-flex h-8 items-center gap-2 rounded-sm border border-[var(--app-theme-border)] bg-[var(--app-theme-surface-raised)] px-3 text-sm font-semibold text-[var(--app-theme-text-muted)] transition hover:bg-[var(--app-theme-sidebar-row-hover)] disabled:cursor-not-allowed disabled:opacity-45"
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
                    class="h-9 w-full max-w-[190px] rounded-md border border-[var(--app-theme-border)] bg-[var(--app-theme-surface)] px-3 text-sm text-[var(--app-theme-text-secondary)] outline-none transition focus:border-[var(--app-theme-focus)] focus:ring-2 focus:ring-[var(--app-theme-focus-ring)]"
                  >
                    <option value="normal">Normal</option>
                    <option value="merge">Merge</option>
                  </select>
                </label>
              </section>

              {#if desktopUi.updates}
                <section class="py-7" aria-labelledby="general-updates">
                  <div class="flex flex-wrap items-center justify-between gap-4">
                    <div>
                      <h3 id="general-updates" class="text-base font-semibold text-[var(--app-theme-text)]">Desktop updates</h3>
                      <p class="mt-1 text-xs text-[var(--app-theme-text-subtle)]">
                        {#if updateStatus.currentVersion}Version {updateStatus.currentVersion} · {/if}
                        {updateStatus.message ?? statusSummary(updateStatus)}
                      </p>
                      {#if updateStatus.checkedAt}
                        <p class="mt-1 text-xs text-[var(--app-theme-text-subtle)]">Last checked {new Date(updateStatus.checkedAt).toLocaleString()}</p>
                      {/if}
                      {#if notesPreview}
                        <p class="mt-2 max-w-[620px] whitespace-pre-line text-xs leading-5 text-[var(--app-theme-text-subtle)]">{notesPreview}</p>
                        {#if releaseUrl}<a class="mt-1 inline-block text-xs text-[var(--app-theme-accent)] underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-theme-focus)]" href={releaseUrl} target="_blank" rel="noreferrer">Release notes on GitHub</a>{/if}
                      {/if}
                    </div>
                    <button type="button" onclick={checkForUpdates} disabled={updateBusy || updateStatus.phase === "disabled"} class="h-8 rounded-sm border border-[var(--app-theme-border)] bg-[var(--app-theme-surface-raised)] px-3 text-xs font-semibold text-[var(--app-theme-text-muted)] transition hover:bg-[var(--app-theme-sidebar-row-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-theme-focus)] disabled:cursor-not-allowed disabled:opacity-50">{updateBusy && updateStatus.phase === "checking" ? "Checking…" : "Check for updates"}</button>
                  </div>
                </section>
              {/if}

              {#if notice}
                <p class="flex items-start gap-2 py-6 text-xs leading-5 text-[var(--app-theme-text-subtle)]" aria-live="polite"><Info aria-hidden="true" class="mt-0.5 shrink-0" size={14} />{notice}</p>
              {/if}
            </div>
