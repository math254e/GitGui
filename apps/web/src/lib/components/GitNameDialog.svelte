<script lang="ts">
  import { X } from "@lucide/svelte";

  export type GitNameDialogKind = "branch" | "stash";

  export type GitNameDialogProps = {
    open: boolean;
    kind: GitNameDialogKind;
    value: string;
    loading?: boolean;
    error?: string;
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
    onValueChange,
    onSubmit,
    onCancel,
  }: GitNameDialogProps = $props();

  let nameInput = $state<HTMLInputElement | null>(null);
  const isBranch = $derived(kind === "branch");
  const title = $derived(isBranch ? "New branch" : "New stash");
  const label = $derived(isBranch ? "Branch name" : "Stash message (optional)");
  const placeholder = $derived(
    isBranch ? "feature/describe-the-change" : "before upgrading dependencies",
  );
  const actionLabel = $derived(
    isBranch ? "Create branch" : "Stash changes",
  );

  $effect(() => {
    if (open) {
      requestAnimationFrame(() => nameInput?.focus());
    }
  });

  function handleBackdropClick(event: MouseEvent) {
    if (event.target === event.currentTarget && !loading) {
      onCancel();
    }
  }

  function handleKeydown(event: KeyboardEvent) {
    if (event.key === "Escape" && !loading) {
      event.preventDefault();
      onCancel();
    }
  }

  function submit(event: SubmitEvent) {
    event.preventDefault();
    if (!loading && (isBranch ? value.trim().length > 0 : true)) {
      onSubmit();
    }
  }
</script>

{#if open}
  <div
    class="fixed inset-0 z-[200] flex items-center justify-center bg-[var(--app-theme-overlay)] p-4 backdrop-blur-[2px]"
    role="presentation"
    onclick={handleBackdropClick}
  >
    <div
      class="w-full max-w-md overflow-hidden rounded-xl border border-[var(--app-theme-border)] bg-[var(--app-theme-surface-overlay)] text-[var(--app-theme-text)] shadow-[var(--app-theme-dialog-shadow)]"
      role="dialog"
      aria-modal="true"
      aria-labelledby="git-name-dialog-title"
      tabindex="-1"
      onkeydown={handleKeydown}
    >
      <header class="flex items-center justify-between gap-4 border-b border-[var(--app-theme-border-subtle)] px-5 py-4">
        <h2 id="git-name-dialog-title" class="text-base font-semibold tracking-[-0.01em]">
          {title}
        </h2>

        <button
          class="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-[var(--app-theme-text-muted)] transition hover:bg-[var(--app-theme-sidebar-row-hover)] hover:text-[var(--app-theme-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-theme-focus)] disabled:cursor-not-allowed disabled:opacity-45"
          type="button"
          aria-label="Close name dialog"
          disabled={loading}
          onclick={onCancel}
        >
          <X aria-hidden="true" size={17} />
        </button>
      </header>

      <form class="px-5 py-4" onsubmit={submit}>
        <label class="block text-sm font-semibold text-[var(--app-theme-text-secondary)]" for="git-name-dialog-input">
          {label}
        </label>
        <input
          bind:this={nameInput}
          id="git-name-dialog-input"
          class="mt-2 h-10 w-full rounded-lg border border-[var(--app-theme-border)] bg-[var(--app-theme-input)] px-3 text-sm text-[var(--app-theme-text)] outline-none transition placeholder:text-[var(--app-theme-text-placeholder)] focus:border-[var(--app-theme-accent)] focus:ring-2 focus:ring-[var(--app-theme-focus-ring)]"
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

        {#if error}
          <p id="git-name-dialog-error" class="mt-3 text-sm text-[var(--app-theme-error)]" role="alert">{error}</p>
        {/if}

        <footer class="mt-5 flex justify-end gap-2">
          <button
            class="h-9 rounded-lg px-3 text-sm font-semibold text-[var(--app-theme-text-muted)] transition hover:bg-[var(--app-theme-sidebar-row-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-theme-focus)] disabled:cursor-not-allowed disabled:opacity-45"
            type="button"
            disabled={loading}
            onclick={onCancel}
          >
            Cancel
          </button>
          <button
            class="inline-flex h-9 items-center justify-center rounded-lg border border-[var(--app-theme-accent-hover)] bg-[var(--app-theme-accent)] px-4 text-sm font-semibold text-[var(--app-theme-accent-foreground)] transition hover:bg-[var(--app-theme-accent-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-theme-focus)] disabled:cursor-not-allowed disabled:opacity-45"
            type="submit"
            disabled={loading || (isBranch && !value.trim())}
          >
            {actionLabel}
          </button>
        </footer>
      </form>
    </div>
  </div>
{/if}
