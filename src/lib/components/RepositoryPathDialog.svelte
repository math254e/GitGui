<script lang="ts">
  import { FolderOpen, X } from "@lucide/svelte";

  type Props = {
    open: boolean;
    value: string;
    error?: string;
    loading?: boolean;
    onValueChange: (value: string) => void;
    onSubmit: () => void | Promise<void>;
    onCancel: () => void;
  };

  let {
    open,
    value,
    error = "",
    loading = false,
    onValueChange,
    onSubmit,
    onCancel,
  }: Props = $props();

  let pathInput = $state<HTMLInputElement | null>(null);

  $effect(() => {
    if (open) {
      requestAnimationFrame(() => pathInput?.focus());
    }
  });

  function cancel() {
    if (!loading) {
      onCancel();
    }
  }

  function handleBackdropClick(event: MouseEvent) {
    if (event.target === event.currentTarget) {
      cancel();
    }
  }

  function handleKeydown(event: KeyboardEvent) {
    if (event.key === "Escape") {
      event.preventDefault();
      cancel();
    }
  }

  function submit(event: SubmitEvent) {
    event.preventDefault();
    void onSubmit();
  }
</script>

{#if open}
  <div
    class="fixed inset-0 z-50 grid place-items-center bg-[#202124]/35 p-4 backdrop-blur-[1px]"
    role="presentation"
    onclick={handleBackdropClick}
    onkeydown={handleKeydown}
  >
    <div
      class="w-full max-w-xl overflow-hidden rounded-lg border border-[#d8dde4] bg-white shadow-[0_24px_80px_rgba(32,33,36,0.24)]"
      role="dialog"
      aria-modal="true"
      aria-labelledby="repository-path-title"
    >
      <header class="flex items-center justify-between border-b border-[#e2e6eb] px-5 py-4">
        <div class="flex min-w-0 items-center gap-3">
          <span class="grid h-9 w-9 shrink-0 place-items-center rounded-md bg-[#e4f5f2] text-[#377f75]">
            <FolderOpen aria-hidden="true" size={20} />
          </span>
          <div class="min-w-0">
            <h2 id="repository-path-title" class="text-lg font-semibold text-[#202124]">
              Open repository on this host
            </h2>
            <p class="mt-0.5 text-sm text-[#6d7784]">Enter a path that exists on the connected GitGui server.</p>
          </div>
        </div>
        <button
          class="grid h-8 w-8 shrink-0 place-items-center rounded text-[#6d7784] transition hover:bg-[#eef2f5] hover:text-[#202124] disabled:opacity-50"
          type="button"
          aria-label="Close repository path dialog"
          disabled={loading}
          onclick={cancel}
        >
          <X aria-hidden="true" size={18} />
        </button>
      </header>

      <form class="px-5 py-5" onsubmit={submit}>
        <label class="block text-sm font-medium text-[#3c4043]" for="repository-server-path">
          Repository path
        </label>
        <input
          bind:this={pathInput}
          id="repository-server-path"
          class="mt-2 h-11 w-full rounded-md border border-[#c9cfd7] bg-white px-3 font-mono text-sm text-[#202124] outline-none transition placeholder:text-[#9aa0a6] focus:border-[#4d9d91] focus:ring-2 focus:ring-[#78d5c8]/25"
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
          <p id="repository-path-error" class="mt-2 text-sm text-[#a13b3b]">{error}</p>
        {/if}

        <div class="mt-6 flex justify-end gap-2">
          <button
            class="h-9 rounded-md border border-[#c9cfd7] bg-white px-4 text-sm font-medium text-[#3c4043] transition hover:bg-[#f4f6f8] disabled:cursor-not-allowed disabled:opacity-50"
            type="button"
            disabled={loading}
            onclick={cancel}
          >
            Cancel
          </button>
          <button
            class="h-9 rounded-md border border-[#3f8f84] bg-[#4d9d91] px-4 text-sm font-semibold text-white transition hover:bg-[#438c82] disabled:cursor-not-allowed disabled:opacity-50"
            type="submit"
            disabled={loading || !value.trim()}
          >
            {loading ? "Opening…" : "Open repository"}
          </button>
        </div>
      </form>
    </div>
  </div>
{/if}
