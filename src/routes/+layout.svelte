<script lang="ts">
  import { Toaster } from "svelte-sonner";

  let { children } = $props();

  const toastOptions = {
    unstyled: true,
    classes: {
      toast: "group relative flex w-fit min-w-[240px] max-w-[320px] items-center gap-3 rounded-lg border px-4 py-3 text-sm shadow-lg",
      title: "font-semibold text-[var(--app-theme-text)]",
      description: "text-xs text-[var(--app-theme-text-muted)]",
      content: "flex min-w-0 flex-1 flex-col gap-0.5",
      icon: "flex h-4 w-4 shrink-0 items-center justify-center",
      closeButton: "absolute -top-2 -left-2 z-10 inline-flex h-6 w-6 items-center justify-center rounded-full border border-[var(--app-theme-border)] bg-[var(--app-theme-surface)] text-[var(--app-theme-text-muted)] shadow-sm hover:bg-[var(--app-theme-sidebar-row-hover)]",
      success: "border-[var(--app-theme-accent)]/45 bg-[var(--app-theme-surface-raised)] text-[var(--app-theme-text)]",
      error: "border-[var(--app-theme-error)]/45 bg-[var(--app-theme-surface-raised)] text-[var(--app-theme-text)]",
    },
  };
</script>

<Toaster position="bottom-left" offset={{ bottom: "40px", left: "24px" }} closeButton toastOptions={toastOptions} />

{@render children()}
