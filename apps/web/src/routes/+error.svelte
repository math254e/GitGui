<script lang="ts">
  import { page } from "$app/state";
</script>

<section class="flex h-full min-h-0 items-center justify-center overflow-auto bg-[var(--app-theme-canvas)] px-6 py-12 text-[var(--app-theme-text)]">
  <div class="w-full max-w-[560px]">
    <h1 class="text-[22px] font-semibold tracking-[-0.02em]">
      {page.status === 404 ? "This page does not exist" : "Something went wrong"}
    </h1>
    <p class="mt-3 text-sm leading-6 text-[var(--app-theme-text-muted)]">
      {page.error?.message ?? "The page could not be displayed."}
    </p>
    <a
      class="mt-6 inline-flex h-8 items-center rounded-[2px] border border-[var(--app-theme-border)] bg-[var(--app-theme-surface-raised)] px-3 text-sm font-semibold text-[var(--app-theme-text-muted)] transition hover:bg-[var(--app-theme-sidebar-row-hover)]"
      href={`/${page.url.search}`}
    >
      Back to repositories
    </a>
  </div>
</section>
