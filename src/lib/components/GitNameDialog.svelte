<script lang="ts">
  import { Archive, GitBranch, X } from "@lucide/svelte";

  export type GitNameDialogKind = "branch" | "stash";

  export type GitNameDialogProps = {
    open: boolean;
    kind: GitNameDialogKind;
    value: string;
    currentBranch?: string | null;
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
    currentBranch = null,
    loading = false,
    error = "",
    onValueChange,
    onSubmit,
    onCancel,
  }: GitNameDialogProps = $props();

  let nameInput = $state<HTMLInputElement | null>(null);
  const isBranch = $derived(kind === "branch");
  const title = $derived(isBranch ? "Name a new branch" : "Name this stash");
  const description = $derived(
    isBranch
      ? `Create and check out a branch from ${currentBranch ?? "the current commit"}.`
      : "Save your current changes as a checkpoint you can come back to later.",
  );
  const label = $derived(isBranch ? "Branch name" : "Stash name");
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
      class="w-full max-w-lg overflow-hidden rounded-2xl border border-[var(--app-theme-border)] bg-[var(--app-theme-surface-overlay)] text-[var(--app-theme-text)] shadow-[var(--app-theme-dialog-shadow)]"
      role="dialog"
      aria-modal="true"
      aria-labelledby="git-name-dialog-title"
      aria-describedby="git-name-dialog-description"
      tabindex="-1"
      onkeydown={handleKeydown}
    >
      <header class="flex items-start justify-between gap-4 border-b border-[var(--app-theme-border-subtle)] px-5 py-5">
        <div class="flex min-w-0 items-start gap-3.5">
          <span
            class="relative flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-[var(--app-theme-accent)]/30 bg-[var(--app-theme-accent-surface)] text-[var(--app-theme-accent)]"
          >
            {#if isBranch}
              <GitBranch aria-hidden="true" size={19} strokeWidth={2} />
            {:else}
              <Archive aria-hidden="true" size={19} strokeWidth={2} />
            {/if}
          </span>
          <div class="min-w-0">
            <p class="text-[10px] font-bold uppercase tracking-[0.18em] text-[var(--app-theme-text-subtle)]">
              {isBranch ? "Branch workspace" : "Working tree"}
            </p>
            <h2 id="git-name-dialog-title" class="mt-1 text-lg font-semibold tracking-[-0.02em]">
              {title}
            </h2>
            <p id="git-name-dialog-description" class="mt-1 text-sm leading-5 text-[var(--app-theme-text-muted)]">
              {description}
            </p>
          </div>
        </div>

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

      <form class="px-5 py-5" onsubmit={submit}>
        <label class="block text-sm font-semibold text-[var(--app-theme-text-secondary)]" for="git-name-dialog-input">
          {label}
        </label>
        <div class="relative mt-2">
          <input
            bind:this={nameInput}
            id="git-name-dialog-input"
            class="h-11 w-full rounded-xl border border-[var(--app-theme-border)] bg-[var(--app-theme-input)] px-3.5 text-sm text-[var(--app-theme-text)] outline-none transition placeholder:text-[var(--app-theme-text-placeholder)] focus:border-[var(--app-theme-accent)] focus:ring-2 focus:ring-[var(--app-theme-focus-ring)]"
            type="text"
            autocomplete="off"
            spellcheck="false"
            placeholder={placeholder}
            value={value}
            disabled={loading}
            aria-invalid={error ? "true" : undefined}
            aria-describedby={error ? "git-name-dialog-error" : "git-name-dialog-hint"}
            oninput={(event) => onValueChange(event.currentTarget.value)}
          />
        </div>

        <p id="git-name-dialog-hint" class="mt-2 text-xs leading-5 text-[var(--app-theme-text-subtle)]">
          {#if isBranch}
            Use slashes to keep related branches together.
          {:else}
            Leave this blank to let Git use its default stash message.
          {/if}
        </p>

        {#if error}
          <p id="git-name-dialog-error" class="mt-3 text-sm text-[var(--app-theme-error)]" role="alert">{error}</p>
        {/if}

        <footer class="mt-6 flex justify-end gap-2">
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
