<script lang="ts">
  import { FolderOpen, X } from "@lucide/svelte";
  import { tick } from "svelte";

  type Props = {
    open: boolean;
    value: string;
    error?: string;
    loading?: boolean;
    allowCancelWhileLoading?: boolean;
    canOpen?: boolean;
    unavailableReason?: string;
    environmentLabel?: string;
    onValueChange: (value: string) => void;
    onSubmit: () => void | Promise<void>;
    onCancel: () => void;
  };

  let {
    open,
    value,
    error = "",
    loading = false,
    allowCancelWhileLoading = false,
    canOpen = false,
    unavailableReason = "Session authorization is unavailable.",
    environmentLabel = "",
    onValueChange,
    onSubmit,
    onCancel,
  }: Props = $props();

  let pathInput = $state<HTMLInputElement | null>(null);
  let dialog: HTMLDialogElement;

  $effect(() => {
    if (open && dialog && !dialog.open) {
      dialog.showModal();
      void tick().then(() => pathInput?.focus());
    } else if (!open && dialog?.open) {
      dialog.close();
    }
  });

  function cancel() {
    if (!loading || allowCancelWhileLoading) {
      onCancel();
    }
  }

  function handleBackdropClick(event: MouseEvent) {
    const bounds = dialog.getBoundingClientRect();
    if (event.target === dialog && (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom)) {
      cancel();
    }
  }

  function submit(event: SubmitEvent) {
    event.preventDefault();
    if (canOpen && !loading) void onSubmit();
  }
</script>

<dialog
  bind:this={dialog}
  class="m-auto w-[calc(100%_-_2rem)] max-w-xl overflow-hidden rounded-lg border border-[var(--app-theme-border)] bg-[var(--app-theme-surface-overlay)] p-0 text-[var(--app-theme-text)] shadow-[var(--app-theme-dialog-shadow)] backdrop:bg-[var(--app-theme-overlay)] backdrop:backdrop-blur-[1px]"
  aria-labelledby="repository-path-title"
  onclick={handleBackdropClick}
  oncancel={(event) => { event.preventDefault(); cancel(); }}
>
  <header class="flex items-center justify-between border-b border-[var(--app-theme-border-subtle)] px-5 py-4">
    <div class="flex min-w-0 items-center gap-3">
      <span class="grid h-9 w-9 shrink-0 place-items-center rounded-md bg-[var(--app-theme-accent-surface)] text-[var(--app-theme-accent)]">
        <FolderOpen aria-hidden="true" size={20} />
      </span>
      <div class="min-w-0">
        <h2 id="repository-path-title" class="text-base font-semibold text-[var(--app-theme-text)]">
          Open repository
        </h2>
        <p class="mt-0.5 text-sm text-[var(--app-theme-text-muted)]">{environmentLabel ? `Enter a path on ${environmentLabel}.` : "Enter a path that exists on the connected GitGui server."}</p>
      </div>
    </div>
    <button
      class="grid h-8 w-8 shrink-0 place-items-center rounded text-[var(--app-theme-text-muted)] transition hover:bg-[var(--app-theme-sidebar-row-hover)] hover:text-[var(--app-theme-text)] disabled:opacity-50"
      type="button"
      aria-label="Close repository path dialog"
      disabled={loading && !allowCancelWhileLoading}
      onclick={cancel}
    >
      <X aria-hidden="true" size={18} />
    </button>
  </header>

  <form class="px-5 py-5" onsubmit={submit}>
    {#if !canOpen}<p class="mb-3 text-sm text-[var(--app-theme-text-muted)]" role="status">{unavailableReason}</p>{/if}
    <label class="block text-sm font-medium text-[var(--app-theme-text-secondary)]" for="repository-server-path">
      Repository path
    </label>
    <input
      bind:this={pathInput}
      id="repository-server-path"
      class="mt-2 h-9 w-full rounded-md border border-[var(--app-theme-border)] bg-[var(--app-theme-surface)] px-3 font-mono text-sm text-[var(--app-theme-text)] outline-none transition placeholder:text-[var(--app-theme-text-placeholder)] focus:border-[var(--app-theme-accent)] focus:ring-2 focus:ring-[var(--app-theme-focus-ring)]"
      type="text"
      autocomplete="off"
      spellcheck="false"
      placeholder="C:\Projects\my-repository or /home/me/projects/my-repository"
      value={value}
      disabled={loading}
      aria-invalid={error ? "true" : undefined}
      aria-describedby={error ? "repository-path-error" : undefined}
      oninput={(event) => onValueChange(event.currentTarget.value)}
    />

    {#if error}
      <p id="repository-path-error" class="mt-2 text-sm text-[var(--app-theme-error)]">{error}</p>
    {/if}

    <div class="mt-6 flex justify-end gap-2">
      <button
        class="h-9 rounded-md border border-[var(--app-theme-border)] bg-[var(--app-theme-surface-raised)] px-4 text-sm font-medium text-[var(--app-theme-text-secondary)] transition hover:bg-[var(--app-theme-canvas)] disabled:cursor-not-allowed disabled:opacity-50"
        type="button"
        disabled={loading && !allowCancelWhileLoading}
        onclick={cancel}
      >
        Cancel
      </button>
      <button
        class="h-9 rounded-md border border-[var(--app-theme-accent-hover)] bg-[var(--app-theme-accent)] px-4 text-sm font-semibold text-[var(--app-theme-accent-foreground)] transition hover:bg-[var(--app-theme-accent-hover)] disabled:cursor-not-allowed disabled:opacity-50"
        type="submit"
        disabled={loading || !canOpen || !value.trim()}
      >
        {loading ? "Opening…" : "Open repository"}
      </button>
    </div>
  </form>
</dialog>
