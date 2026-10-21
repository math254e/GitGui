<script lang="ts">
  import type { Snippet } from "svelte";

  type Props = {
    title: string;
    description: string;
    children: Snippet;
  };

  let { title, description, children }: Props = $props();
</script>

<div class="mx-auto max-w-[920px] px-6 py-8 sm:px-8 lg:px-12 lg:py-12">
  <header class="border-b border-[var(--app-theme-border)] pb-8">
    <p class="text-sm font-medium text-[var(--app-theme-text-subtle)]">Settings / {title}</p>
    <div class="mt-3 flex flex-wrap items-end justify-between gap-4">
      <div>
        <h2 class="text-[28px] font-semibold tracking-[-0.03em] text-[var(--app-theme-text)]">{title}</h2>
        <p class="mt-2 max-w-[620px] text-sm leading-6 text-[var(--app-theme-text-muted)]">
          {description}
        </p>
      </div>
    </div>
  </header>

  {@render children()}
</div>
