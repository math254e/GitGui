<script lang="ts">
  import type { OmittedDiffContent } from "@gitgui/contracts";

  let { omitted, repositoryPath }: { omitted: OmittedDiffContent; repositoryPath: string } = $props();
</script>

<div class="large-file-notice" role="status">
  <p class="notice-title">Update the server to view this file</p>
  <p>This server is running an older version that omits larger files. Update or restart it
    with the current GitGui version to view the complete diff.</p>
  <details>
    <summary>Inspect text prefixes (up to 8 KiB per side)</summary>
    <p>These prefixes omit the rest of each file and may end mid-line. They are not a complete diff.</p>
    <h3>Original prefix</h3>
    <!-- svelte-ignore a11y_no_noninteractive_tabindex (Keyboard focus enables scrolling the bounded text prefix.) -->
    <pre tabindex="0">{omitted.originalPreview || "(empty or unavailable)"}</pre>
    <h3>Modified prefix</h3>
    <!-- svelte-ignore a11y_no_noninteractive_tabindex (Keyboard focus enables scrolling the bounded text prefix.) -->
    <pre tabindex="0">{omitted.modifiedPreview || "(empty or unavailable)"}</pre>
  </details>
  <details>
    <summary>Inspect the full contents outside GitGui</summary>
    <p>On the repository host, open a terminal in <code>{repositoryPath}</code>.
      Use <code>git diff</code> for working-tree changes, <code>git diff --cached</code> for staged changes,
      or <code>git show &lt;commit&gt;</code> for a commit. These commands inspect all changed paths;
      add a literal path filter if needed. Open working files in an editor that supports large files.</p>
    <p>For a remote repository, run these commands on that host.</p>
  </details>
</div>

<style>
  .large-file-notice { position: absolute; inset: 0; overflow: auto; padding: 24px; background: var(--app-theme-code-background); font-size: 13px; }
  .notice-title { font-size: 15px; font-weight: 600; }
  p { max-width: 80ch; margin-bottom: 12px; }
  details { margin-top: 16px; }
  summary { cursor: pointer; margin-bottom: 12px; font-weight: 600; }
  h3 { font-size: 12px; margin: 12px 0 6px; }
  pre { max-height: 240px; overflow: auto; padding: 12px; border: 1px solid var(--app-theme-toolbar-border); font-size: 12px; white-space: pre; }
  code { overflow-wrap: anywhere; }
</style>
