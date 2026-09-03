<script lang="ts">
  import { LoaderCircle } from "@lucide/svelte";

  type Props = {
    label: string | null;
  };

  let { label }: Props = $props();
</script>

<div class="flex h-6 min-h-6 items-center border-t border-[var(--app-theme-toolbar-border)] bg-[var(--app-theme-toolbar)] px-2 text-[11px] text-[var(--app-theme-toolbar-foreground)]" aria-live="polite" aria-busy={label !== null}>
  {#if label}
    <span class="inline-flex items-center gap-1.5 opacity-80" role="status">
      <LoaderCircle aria-hidden="true" class="animate-spin" size={12} strokeWidth={2} />
      <span>{label}…</span>
    </span>
  {/if}
</div>
