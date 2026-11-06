<script lang="ts">
  import type { Snippet } from "svelte";

  type Props = {
    title: string;
    description: string;
    children: Snippet;
  };

  let { title, description, children }: Props = $props();
</script>

<div class="mx-auto max-w-[1080px] px-5 py-6 sm:px-8 sm:py-8 lg:px-12">
  <header class="max-w-[760px]">
    <h1 class="text-xl font-semibold tracking-tight text-[var(--app-theme-text)]">{title}</h1>
    <p class="mt-2 text-sm leading-6 text-[var(--app-theme-text-muted)]">{description}</p>
  </header>

  {@render children()}
</div>
