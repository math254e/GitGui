<script lang="ts">
  import { onDestroy, tick } from "svelte";
  import { Check, Download, LoaderCircle, RefreshCw, X } from "@lucide/svelte";
  import { getDesktopUi } from "./context.svelte";
  import {
    getDesktopUpdateAction,
    getDownloadedVersion,
    getReleaseNotesPreview,
    getDesktopReleaseUrl,
    shouldShowDesktopUpdateControl,
    type DesktopUpdateSnapshot,
  } from "./controller";

  const updates = getDesktopUi().updates;
  let snapshot = $state<DesktopUpdateSnapshot | null>(updates?.getSnapshot() ?? null);
  let confirmOpen = $state(false);
  let confirmedVersion = $state<string | undefined>();
  let dialog: HTMLDialogElement;
  let cancelButton: HTMLButtonElement;
  const unsubscribe = updates?.subscribe((next) => (snapshot = next));
  onDestroy(() => unsubscribe?.());

  const status = $derived(snapshot?.status);
  const action = $derived(status ? getDesktopUpdateAction(status) : "check");
  const busy = $derived(Boolean(snapshot?.pendingAction) || status?.phase === "checking" || status?.phase === "downloading" || status?.phase === "installing");
  const version = $derived(status ? getDownloadedVersion(status) : undefined);
  const releaseUrl = $derived(status ? getDesktopReleaseUrl(status) : null);
  const notesPreview = $derived(status ? getReleaseNotesPreview(status.releaseNotes) : null);
  const progress = $derived(status?.phase === "downloading" && typeof status.downloadPercent === "number"
    ? Math.max(0, Math.min(100, Math.floor(status.downloadPercent)))
    : null);
  const buttonLabel = $derived(status ? labelForStatus(status, action, progress) : "Check for updates");

  $effect(() => {
    if (confirmOpen && dialog && !dialog.open) {
      dialog.showModal();
      void tick().then(() => cancelButton?.focus());
    } else if (!confirmOpen && dialog?.open) {
      dialog.close();
    }
  });

  function activate() {
    if (!updates || !status || busy) return;
    if (action === "install") {
      confirmedVersion = version;
      confirmOpen = true;
      return;
    }
    if (action === "download") void updates.download();
    else void updates.check();
  }

  function confirmInstall() {
    confirmOpen = false;
    void updates?.install(confirmedVersion);
  }

  function labelForStatus(
    current: NonNullable<typeof status>,
    currentAction: "check" | "download" | "install",
    currentProgress: number | null,
  ): string {
    if (current.message && current.errorContext === "download") return `Retry downloading update: ${current.message}`;
    if (current.message && current.errorContext === "install") return `Retry installing update: ${current.message}`;
    if (current.phase === "downloading") return currentProgress === null ? "Downloading update" : `Downloading update ${currentProgress}%`;
    if (current.phase === "installing") return "Installing update";
    if (current.phase === "checking") return "Checking for updates";
    if (current.phase === "available") return `Download update ${current.availableVersion ?? ""}`.trim();
    if (current.phase === "downloaded") return `Install update ${getDownloadedVersion(current) ?? ""}`.trim();
    if (current.phase === "error") return current.errorContext === "download"
      ? `Retry update download ${current.availableVersion ?? ""}`.trim()
      : current.errorContext === "install" && current.downloadedVersion
        ? `Retry installing update ${current.downloadedVersion}`
        : `Retry update check${current.message ? `: ${current.message}` : ""}`;
    if (current.phase === "current") return "Check for updates; GitGui is up to date";
    return currentAction === "check" ? "Check for updates" : currentAction;
  }
</script>

{#if status && shouldShowDesktopUpdateControl(status)}
  <div class="relative flex h-full shrink-0 items-center border-l border-[var(--app-theme-toolbar-border)]">
    <button
      type="button"
      class="relative flex h-full min-w-11 items-center justify-center gap-1 px-2 text-[var(--app-theme-toolbar-foreground)] transition hover:bg-[var(--app-theme-toolbar-control-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--app-theme-focus)] disabled:cursor-wait disabled:opacity-70"
      aria-label={buttonLabel}
      title={`${buttonLabel}${notesPreview ? `\n\n${notesPreview}` : ""}`}
      aria-busy={busy}
      disabled={busy}
      onclick={activate}
    >
      {#if busy}<LoaderCircle aria-hidden="true" class="animate-spin" size={17} />
      {:else if action === "download"}<Download aria-hidden="true" size={17} />
      {:else if action === "install"}<Check aria-hidden="true" size={17} />
      {:else if status.phase === "current"}<Check aria-hidden="true" size={17} />
      {:else}<RefreshCw aria-hidden="true" size={16} />{/if}
      {#if progress !== null}<span class="text-[10px] tabular-nums">{progress}%</span>{/if}
      {#if status.phase === "downloading"}
        <span class="absolute inset-x-1 bottom-1 h-0.5 overflow-hidden rounded bg-[var(--app-theme-toolbar-border)]" aria-hidden="true">
          <span class="block h-full bg-[var(--app-theme-accent)]" style={`width: ${progress ?? 0}%`}></span>
        </span>
      {:else if status.phase === "error" || (status.message && status.errorContext)}
        <span class="absolute right-1.5 top-1.5 h-1.5 w-1.5 rounded-full bg-[var(--app-theme-error)]" aria-hidden="true"></span>
      {/if}
    </button>
  </div>
{/if}

<dialog bind:this={dialog}
  class="m-auto w-[calc(100%_-_2rem)] max-w-[440px] overflow-hidden rounded-[2px] border border-[var(--app-theme-border)] bg-[var(--app-theme-surface-overlay)] p-0 text-[var(--app-theme-text)] shadow-2xl backdrop:bg-black/55"
  aria-labelledby="update-confirm-title" aria-describedby="update-confirm-description"
  oncancel={(event) => { event.preventDefault(); confirmOpen = false; }}>
  <header class="flex items-center justify-between gap-3 border-b border-[var(--app-theme-border)] px-4 py-3">
    <h2 id="update-confirm-title" class="text-sm font-semibold">Restart to install update?</h2>
    <button type="button" onclick={() => (confirmOpen = false)} aria-label="Close update confirmation"
      class="flex h-6 w-6 shrink-0 items-center justify-center rounded-[2px] text-[var(--app-theme-text-muted)] transition-colors hover:bg-[var(--app-theme-sidebar-row-hover)] hover:text-[var(--app-theme-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-theme-focus)]">
      <X aria-hidden="true" size={15} />
    </button>
  </header>
  <div class="px-4 py-4">
    <p id="update-confirm-description" class="text-sm text-[var(--app-theme-text-secondary)]">
      Install {confirmedVersion ? `version ${confirmedVersion}` : "the downloaded update"} and restart GitGui?
      Local Git operations must finish before installation. Connections will close briefly; remote work may be interrupted.
    </p>
    {#if status?.message && status.errorContext}
      <p class="mt-3 text-xs text-[var(--app-theme-error)]" role="alert">{status.message}</p>
    {/if}
    {#if notesPreview}
      <div class="mt-4 border-t border-[var(--app-theme-border-subtle)] pt-3">
        <h3 class="text-xs font-semibold text-[var(--app-theme-text)]">Release notes</h3>
        <p class="mt-1 whitespace-pre-line text-xs leading-5 text-[var(--app-theme-text-subtle)]">{notesPreview}</p>
        {#if releaseUrl}
          <a class="mt-2 inline-flex text-xs font-medium text-[var(--app-theme-accent)] underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-theme-focus)]" href={releaseUrl} target="_blank" rel="noreferrer">Read release notes on GitHub</a>
        {/if}
      </div>
    {/if}
    <footer class="mt-5 flex justify-end gap-2">
      <button bind:this={cancelButton} type="button" onclick={() => (confirmOpen = false)}
        class="h-8 rounded-[2px] border border-[var(--app-theme-border)] bg-[var(--app-theme-surface-raised)] px-3 text-sm font-medium text-[var(--app-theme-text-secondary)] transition-colors hover:bg-[var(--app-theme-sidebar-row-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-theme-focus)]">Cancel</button>
      <button type="button" onclick={confirmInstall}
        class="h-8 rounded-[2px] bg-[var(--app-theme-accent)] px-3 text-sm font-semibold text-[var(--app-theme-accent-foreground)] transition hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-theme-focus)]">Restart and install</button>
    </footer>
  </div>
</dialog>
