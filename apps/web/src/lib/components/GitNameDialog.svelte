<script lang="ts">
  import { X } from "@lucide/svelte";
  import { tick } from "svelte";

  export type GitNameDialogKind = "branch" | "renameBranch" | "tag" | "stash";

  export type GitNameDialogProps = {
    open: boolean;
    kind: GitNameDialogKind;
    value: string;
    loading?: boolean;
    error?: string;
    startPoint?: string;
    checkout?: boolean;
    onCheckoutChange?: (checked: boolean) => void;
    onValueChange: (value: string) => void;
    onSubmit: () => void;
    onCancel: () => void;
  };

  let {
    open,
    kind,
    value,
    loading = false,
    error = "",
    startPoint,
    checkout = true,
    onCheckoutChange,
    onValueChange,
    onSubmit,
    onCancel,
  }: GitNameDialogProps = $props();

  let nameInput = $state<HTMLInputElement | null>(null);
  let dialog: HTMLDialogElement;
  const isBranch = $derived(kind === "branch" || kind === "renameBranch");
  const title = $derived(kind === "renameBranch" ? "Rename branch" : kind === "tag" ? "New tag" : isBranch ? "New branch" : "New stash");
  const label = $derived(kind === "tag" ? "Tag name" : isBranch ? "Branch name" : "Stash message (optional)");
  const placeholder = $derived(
    kind === "tag" ? "v1.0.0" : isBranch ? "feature/describe-the-change" : "before upgrading dependencies",
  );
  const actionLabel = $derived(
    kind === "renameBranch" ? "Rename branch" : kind === "tag" ? "Create tag" : isBranch ? "Create branch" : "Stash changes",
  );

  $effect(() => {
    if (open && dialog && !dialog.open) {
      dialog.showModal();
      void tick().then(() => { nameInput?.focus(); nameInput?.select(); });
    } else if (!open && dialog?.open) {
      dialog.close();
    }
  });

  function submit(event: SubmitEvent) {
    event.preventDefault();
    if (!loading && (kind === "stash" || value.trim().length > 0)) {
      onSubmit();
    }
  }
</script>

<dialog
  bind:this={dialog}
  class="m-auto w-[calc(100%_-_2rem)] max-w-[420px] overflow-hidden rounded-[2px] border border-[var(--app-theme-border)] bg-[var(--app-theme-surface-overlay)] p-0 text-[var(--app-theme-text)] shadow-2xl backdrop:bg-black/55"
  aria-labelledby="git-name-dialog-title"
  oncancel={(event) => { event.preventDefault(); if (!loading) onCancel(); }}
>
  <header class="flex items-center justify-between gap-3 border-b border-[var(--app-theme-border)] px-4 py-2.5">
    <h2 id="git-name-dialog-title" class="text-sm font-semibold">
      {title}
    </h2>

    <button
      class="flex h-6 w-6 shrink-0 items-center justify-center rounded-[2px] text-[var(--app-theme-text-muted)] transition-colors hover:bg-[var(--app-theme-sidebar-row-hover)] hover:text-[var(--app-theme-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-theme-focus)] disabled:cursor-not-allowed disabled:opacity-45"
      type="button"
      aria-label="Close name dialog"
      disabled={loading}
      onclick={onCancel}
    >
      <X aria-hidden="true" size={15} />
    </button>
  </header>

  <form class="px-4 py-4" onsubmit={submit}>
    {#if kind === "branch" || kind === "tag"}
      <p class="mb-3 flex items-center gap-2 text-xs text-[var(--app-theme-text-secondary)]">From <code title={startPoint}>{startPoint ? startPoint.slice(0, 8) : "HEAD"}</code></p>
    {/if}
    <label class="block text-xs font-medium text-[var(--app-theme-text-secondary)]" for="git-name-dialog-input">
      {label}
    </label>
    <input
      bind:this={nameInput}
      id="git-name-dialog-input"
      class="mt-1.5 h-8 w-full rounded-[2px] border border-[var(--app-theme-input)] bg-[var(--app-theme-canvas)] px-2.5 font-mono text-sm text-[var(--app-theme-text)] outline-none placeholder:text-[var(--app-theme-placeholder)]"
      type="text"
      autocomplete="off"
      spellcheck="false"
      placeholder={placeholder}
      value={value}
      disabled={loading}
      aria-invalid={error ? "true" : undefined}
      aria-describedby={error ? "git-name-dialog-error" : undefined}
      oninput={(event) => onValueChange(event.currentTarget.value)}
    />

    {#if kind === "branch"}
      <label class="mt-3 flex items-center gap-2 text-xs text-[var(--app-theme-text-secondary)]">
        <input class="h-3.5 w-3.5 accent-[var(--app-theme-accent)]" type="checkbox" checked={checkout} disabled={loading} onchange={(event) => onCheckoutChange?.(event.currentTarget.checked)} />
        Switch to this branch
      </label>
    {/if}

    {#if error}
      <p id="git-name-dialog-error" class="mt-3 text-xs text-[var(--app-theme-error)]" role="alert">{error}</p>
    {/if}

    <footer class="mt-4 flex justify-end gap-2">
      <button
        class="h-8 rounded-[2px] border border-[var(--app-theme-border)] bg-[var(--app-theme-surface-raised)] px-3 text-sm font-medium text-[var(--app-theme-text-secondary)] transition-colors hover:bg-[var(--app-theme-sidebar-row-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-theme-focus)] disabled:cursor-not-allowed disabled:opacity-45"
        type="button"
        disabled={loading}
        onclick={onCancel}
      >
        Cancel
      </button>
      <button
        class="inline-flex h-8 items-center justify-center rounded-[2px] border border-[var(--app-theme-accent)] bg-[var(--app-theme-accent-surface)] px-3 text-sm font-medium text-[var(--app-theme-accent-surface-foreground)] transition-colors hover:bg-[var(--app-theme-sidebar-row-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-theme-focus)] disabled:cursor-not-allowed disabled:opacity-45"
        type="submit"
        disabled={loading || (kind !== "stash" && !value.trim())}
      >
        {loading ? "Working…" : actionLabel}
      </button>
    </footer>
  </form>
</dialog>
