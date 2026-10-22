<script lang="ts">
  import { X } from "@lucide/svelte";
  import { onMount, untrack } from "svelte";
  import type { CodeView, DiffLineAnnotation, FileContents, FileDiffMetadata } from "@pierre/diffs";
  import type { GitHunkPreview, GitApplyHunksParams } from "@gitgui/contracts";
  import type { GitGuiClient } from "@gitgui/client-runtime";
  import { DIFF_VIEW_UNSAFE_CSS, resolveDiffThemeName } from "$lib/theme/diffTheme";
  import { themeStore } from "$lib/theme/useTheme";
  import type { ThemeAppearance } from "$lib/theme/types";
  import type { CommitFile, CommitFileDiff, CommitInfo, RepositorySnapshot } from "$lib/types/repository";
  import { buildFileDiffRequestKey } from "./file-diff-request-key";

  type HunkAnnotation = { id: number; header: string; request: number; revision: string };
  type Diffs = typeof import("@pierre/diffs");
  type DiffViewMode = "hunks" | "inline" | "split";
  type ContentViewMode = "diff" | "file";
  type DiffSource = "commit" | "workingTree" | "staged" | "commitWorkingTree";
  const contentModes = [
    { value: "diff", label: "Diff", title: "Compare original and modified contents" },
    { value: "file", label: "File", title: "Read the full file contents" },
  ] as const;
  const diffModes = [
    { value: "hunks", label: "Hunks", title: "Show changes with nearby context" },
    { value: "inline", label: "Inline", title: "Show the full diff in one column" },
    { value: "split", label: "Split", title: "Compare the full files side by side" },
  ] as const;

  type Props = {
    client: GitGuiClient;
    repositoryId: string;
    snapshot: RepositorySnapshot;
    diffSource: DiffSource;
    selectedCommit: CommitInfo | null;
    selectedFile: CommitFile;
    contentRevision?: number;
    onClose: () => void;
    onApplyHunks?: (params: GitApplyHunksParams) => void;
    pending?: boolean;
  };

  let { client, repositoryId, snapshot, diffSource, selectedCommit, selectedFile, contentRevision = 0, onClose, onApplyHunks, pending = false }: Props = $props();
  let viewerContainer: HTMLDivElement;
  let renderer = $state.raw<{ library: Diffs; viewer: CodeView<HunkAnnotation> } | null>(null);
  let parsedDiff: { source: CommitFileDiff; preview: GitHunkPreview | null; metadata: FileDiffMetadata } | null = null;
  let diff = $state<CommitFileDiff | null>(null);
  let hunkPreview = $state<GitHunkPreview | null>(null);
  let hunkError = $state("");
  let selectedHunks = $state<number[]>([]);
  let loading = $state(false);
  let error = $state("");
  let renderError = $state("");
  let contentViewMode = $state<ContentViewMode>("diff");
  let diffViewMode = $state<DiffViewMode>("inline");
  let wordWrap = $state(false);
  let appearance = $state<ThemeAppearance>(themeStore.getSnapshot().resolvedAppearance);
  let activeRequest = 0;
  let selectionController: AbortController | undefined;
  // CodeView ignores new payloads with an unchanged item version, including
  // hunk annotations arriving after the file contents.
  let renderVersion = 0;
  let activeDiffRequestKey = "";
  let destroyed = false;
  const diffRequestKey = $derived(buildFileDiffRequestKey(repositoryId, snapshot, diffSource, selectedCommit, selectedFile, contentRevision));
  const noContentChanges = $derived(diff !== null && diff.originalContent === diff.modifiedContent);
  const showingDeletedFile = $derived(statusLabel(selectedFile) === "D");
  const displayedFileIsEmpty = $derived(diff !== null &&
    (showingDeletedFile ? diff.originalContent : diff.modifiedContent) === "");

  $effect(() => {
    const requestKey = diffRequestKey;

    const currentSnapshot = snapshot;
    if ((diffSource === "commit" || diffSource === "commitWorkingTree") && requestKey === activeDiffRequestKey) {
      return;
    }

    activeDiffRequestKey = requestKey;
    untrack(() => { void loadDiff(repositoryId, diffSource, selectedCommit, selectedFile, currentSnapshot); });
  });

  $effect(() => {
    const currentDiff = diff;
    const startedAt = performance.now();
    renderView(renderer, currentDiff, contentViewMode, diffViewMode, wordWrap, appearance);
    if (renderer && currentDiff && !currentDiff.isBinary) {
      recordDiffDiagnostic("render", performance.now() - startedAt, currentDiff);
    }
  });

  $effect(() => {
    const selection = selectedHunks;
    const disabled = pending || loading || Boolean(renderError) || !onApplyHunks;
    for (const row of viewerContainer?.querySelectorAll<HTMLElement>("[data-hunk-action]") ?? []) {
      const input = row.querySelector<HTMLInputElement>("input");
      const button = row.querySelector<HTMLButtonElement>("button");
      // Update slotted controls in place so selecting a hunk keeps focus.
      if (input) {
        input.checked = selection.includes(Number(row.dataset.hunkAction));
        input.disabled = disabled;
      }
      if (button) button.disabled = disabled;
    }
  });

  onMount(() => {
    appearance = themeStore.getSnapshot().resolvedAppearance;
    const unsubscribeTheme = themeStore.subscribe((snapshot) => {
      appearance = snapshot.resolvedAppearance;
    });
    void initializeViewer();

    return () => {
      destroyed = true;
      activeRequest += 1;
      selectionController?.abort();
      unsubscribeTheme();
      renderer?.viewer.cleanUp();
      parsedDiff = null;
    };
  });

  async function initializeViewer() {
    try {
      // Diffs uses browser DOM APIs; load it only after the viewer mounts.
      const library = await import("@pierre/diffs");
      if (destroyed) {
        return;
      }

      const viewer = new library.CodeView<HunkAnnotation>();
      viewer.setup(viewerContainer);
      renderer = { library, viewer };
    } catch (caught) {
      if (!destroyed) {
        renderError = formatError(caught);
      }
    }
  }

  async function loadDiff(
    repositoryId: string,
    source: DiffSource,
    commit: CommitInfo | null,
    file: CommitFile,
    currentSnapshot: RepositorySnapshot = snapshot,
  ) {
    if (destroyed) {
      return;
    }

    const request = ++activeRequest;
    selectionController?.abort();
    selectionController = new AbortController();
    const signal = selectionController.signal;
    diff = null;
    hunkPreview = null;
    hunkError = "";
    selectedHunks = [];
    error = "";
    loading = true;

    try {
      const commitHash = commit?.hash;
      const parentHash = commit?.parents[0] ?? null;
      const headHash = currentSnapshot.status.headOid ?? null;

      if ((source === "commit" || source === "commitWorkingTree") && !commitHash) {
        throw new Error("No commit is selected.");
      }

      const resultPromise =
        source === "commit"
          ? client.getCommitFileDiff({
              repositoryId,
              commitHash: commitHash ?? "",
              ...(parentHash ? { parentHash } : {}),
              filePath: file.path,
            }, signal)
          : source === "commitWorkingTree"
          ? client.getCommitWorkingTreeFileDiff({ repositoryId, commitHash: commitHash ?? "", filePath: file.path }, signal)
          : client.getWorkingTreeFileDiff({
              repositoryId,
              ...(headHash ? { headHash } : {}),
              filePath: file.path,
              staged: source === "staged",
            }, signal);

      // Hunk actions are supplementary. A slow preview must not keep already
      // loaded file contents behind the loading overlay after a mutation.
      if (source === "workingTree" || source === "staged") {
        void loadHunkPreview(request, repositoryId, source, file.path, signal);
      }
      const result = await resultPromise;
      if (!destroyed && request === activeRequest) {
        diff = result.diff;
      }
    } catch (caught) {
      if (!destroyed && request === activeRequest) {
        error = formatError(caught);
      }
    } finally {
      if (!destroyed && request === activeRequest) {
        loading = false;
      }
    }
  }

  async function loadHunkPreview(request: number, repositoryId: string, source: DiffSource, filePath: string, signal: AbortSignal) {
    try {
      const preview = await client.getHunkPreview({ repositoryId, filePath, staged: source === "staged" }, signal);
      if (!destroyed && request === activeRequest) hunkPreview = preview;
    } catch (caught) {
      if (!destroyed && request === activeRequest) hunkError = formatError(caught);
    }
  }

  function renderView(
    currentRenderer: typeof renderer,
    currentDiff: CommitFileDiff | null,
    view: ContentViewMode,
    mode: DiffViewMode,
    wrap: boolean,
    themeAppearance: ThemeAppearance,
  ) {
    if (!currentRenderer || destroyed) {
      return;
    }

    const { viewer, library } = currentRenderer;
    if (!currentDiff || currentDiff.isBinary) {
      renderError = "";
      viewer.setItems([]);
      parsedDiff = null;
      return;
    }

    try {
      renderError = "";
      viewer.setOptions({
        theme: resolveDiffThemeName(themeAppearance),
        themeType: themeAppearance,
        preferredHighlighter: "shiki-wasm",
        unsafeCSS: DIFF_VIEW_UNSAFE_CSS,
        disableFileHeader: true,
        diffStyle: mode === "split" ? "split" : "unified",
        expandUnchanged: mode !== "hunks",
        loadDiffFiles: async () => ({ oldFile: { name: currentDiff.originalPath ?? currentDiff.modifiedPath, contents: currentDiff.originalContent }, newFile: { name: currentDiff.modifiedPath, contents: currentDiff.modifiedContent } }),
        collapsedContextThreshold: 8,
        expansionLineCount: 20,
        hunkSeparators: "line-info",
        diffIndicators: "classic",
        lineDiffType: "none",
        overflow: wrap ? "wrap" : "scroll",
        enableLineSelection: true,
        lineHoverHighlight: "both",
        renderAnnotation: (annotation) => untrack(() => renderHunkAction(annotation.metadata)),
        // These measurements match the shared T3 separator stylesheet.
        itemMetrics: { hunkSeparatorHeight: 24, spacing: 0, paddingTop: 0, paddingBottom: 8 },
        layout: { paddingTop: 0, paddingBottom: 0, gap: 0 },
      });

      const modifiedFile: FileContents = {
        name: currentDiff.modifiedPath,
        contents: currentDiff.modifiedContent,
      };

      // A pure rename has no hunks for Diffs to render. Keep its full contents
      // available in the expanded views and show an empty state in Hunks.
      const unchanged = currentDiff.originalContent === currentDiff.modifiedContent;
      if (unchanged && view === "diff" && mode === "hunks") {
        viewer.setItems([]);
        return;
      }

      if (view === "file" || unchanged) {
        // Deleted files still have useful original contents to inspect.
        const file = view === "file" && showingDeletedFile
          ? { name: currentDiff.originalPath ?? currentDiff.modifiedPath, contents: currentDiff.originalContent }
          : modifiedFile;
        viewer.setItems(file.contents === "" ? [] : [{ id: "file", type: "file", file, version: ++renderVersion }]);
        return;
      }

      // Reuse the parsed diff when changing layout or wrapping a large file.
      if (parsedDiff?.source !== currentDiff || parsedDiff.preview !== hunkPreview) {
        const parseStartedAt = performance.now();
        const originalFile: FileContents | null = currentDiff.originalPath === null
          ? null
          : { name: currentDiff.originalPath, contents: currentDiff.originalContent };
        parsedDiff = {
          source: currentDiff,
          preview: hunkPreview,
          metadata: hunkPreview && !hunkPreview.unavailableReason && hunkPreview.patch
            ? library.parsePatchFiles(hunkPreview.patch, hunkPreview.revision, true)[0].files[0]
            : library.parseDiffFromFile(originalFile, modifiedFile, { context: 3 }, true),
        };
        recordDiffDiagnostic("parse", performance.now() - parseStartedAt, currentDiff);
      }

      const preview = hunkPreview;
      const annotations: DiffLineAnnotation<HunkAnnotation>[] = preview && !preview.unavailableReason && onApplyHunks
        ? parsedDiff.metadata.hunks.map((hunk, id) => ({
            // Place controls directly after their Git hunk, including additions
            // and deletions where only one side has any lines.
            side: hunk.additionCount ? "additions" : "deletions",
            lineNumber: hunk.additionCount
              ? hunk.additionStart + hunk.additionCount - 1
              : hunk.deletionStart + hunk.deletionCount - 1,
            metadata: { id: preview.hunks[id].id, header: preview.hunks[id].header, request: activeRequest, revision: preview.revision },
          }))
        : [];
      viewer.setItems([{ id: "diff", type: "diff", fileDiff: parsedDiff.metadata, annotations, version: ++renderVersion }]);
    } catch (caught) {
      renderError = formatError(caught);
    }
  }

  function recordDiffDiagnostic(phase: "parse" | "render", durationMs: number, currentDiff: CommitFileDiff) {
    // Character counts are an inexpensive bounded proxy; contents and paths
    // are deliberately excluded from diagnostics.
    const contentBytes = Math.min(
      (currentDiff.originalContent.length + currentDiff.modifiedContent.length) * 2,
      0x7fffffff,
    );
    console.debug("[GitGui diff diagnostic]", {
      phase,
      source: diffSource,
      durationMs: Math.max(0, durationMs),
      contentBytes,
    });
  }

  function toggleHunk(id: number) {
    selectedHunks = selectedHunks.includes(id) ? selectedHunks.filter((selected) => selected !== id) : [...selectedHunks, id];
  }

  function renderHunkAction(hunk: HunkAnnotation) {
    const row = document.createElement("div");
    row.className = "inline-hunk-actions";
    row.dataset.hunkAction = String(hunk.id);
    const label = document.createElement("label");
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = selectedHunks.includes(hunk.id);
    checkbox.disabled = pending || loading || Boolean(renderError) || !onApplyHunks;
    checkbox.setAttribute("aria-label", `Select hunk ${hunk.id + 1}`);
    checkbox.onchange = () => {
      if (hunk.request === activeRequest && !destroyed && !pending && !loading) toggleHunk(hunk.id);
    };
    label.append(checkbox, `Hunk ${hunk.id + 1}`);
    const header = document.createElement("code");
    header.textContent = hunk.header;
    header.title = hunk.header;
    const action = document.createElement("button");
    action.type = "button";
    action.textContent = diffSource === "staged" ? "Unstage hunk" : "Stage hunk";
    action.setAttribute("aria-label", `${action.textContent} ${hunk.id + 1}`);
    action.disabled = checkbox.disabled;
    action.onclick = () => {
      if (!destroyed && hunk.request === activeRequest && hunk.revision === hunkPreview?.revision) submitHunks([hunk.id]);
    };
    row.append(label, header, action);
    return row;
  }

  function submitHunks(ids = [...selectedHunks]) {
    if (!hunkPreview || pending || loading || renderError || !ids.length) return;
    selectedHunks = [];
    onApplyHunks?.({ repositoryId, filePath: selectedFile.path, staged: diffSource === "staged", revision: hunkPreview.revision, hunkIds: ids });
  }

  function formatError(caught: unknown) {
    if (typeof caught === "object" && caught && "message" in caught) {
      const details =
        "stderr" in caught && typeof caught.stderr === "string" && caught.stderr
          ? ` ${caught.stderr}`
          : "";
      return `${caught.message}${details}`;
    }

    return String(caught);
  }

  function statusLabel(file: CommitFile) {
    const indexStatus = file.status.charAt(0);
    const worktreeStatus = file.status.charAt(1);

    return worktreeStatus && worktreeStatus !== "." ? worktreeStatus : indexStatus || "?";
  }

  function statusDescription(file: CommitFile) {
    const labels: Record<string, string> = {
      A: "Added", D: "Deleted", M: "Modified", R: "Renamed", C: "Copied",
      T: "Type changed", U: "Unmerged", "?": "Untracked",
    };
    return labels[statusLabel(file)] ?? "Changed";
  }

  function retryDiff() {
    if (!renderer) {
      void initializeViewer();
    }
    void loadDiff(repositoryId, diffSource, selectedCommit, selectedFile);
  }
</script>

<section class="diff-viewer flex h-full min-h-0 flex-col">
  <header class="diff-toolbar">
    <div class="file-heading">
      <code class="file-status" title={statusDescription(selectedFile)} aria-label={statusDescription(selectedFile)}>
        {statusLabel(selectedFile)}
      </code>
      <div class="min-w-0">
        <p class="file-path" title={selectedFile.path}>{selectedFile.path}</p>
        {#if diff?.originalPath && diff.originalPath !== diff.modifiedPath}
          <p class="file-detail" title={diff.originalPath}>from {diff.originalPath}</p>
        {:else if contentViewMode === "file" && showingDeletedFile}
          <p class="file-detail">Original file</p>
        {/if}
      </div>
    </div>

    <div class="viewer-controls">
      <div class="mode-group" role="group" aria-label="Content view">
        {#each contentModes as mode}
          <button class="viewer-button" type="button" title={mode.title}
            aria-pressed={contentViewMode === mode.value} onclick={() => (contentViewMode = mode.value)}>
            {mode.label}
          </button>
        {/each}
      </div>

      {#if contentViewMode === "diff"}
        <div class="mode-group" role="group" aria-label="Diff layout">
          {#each diffModes as mode}
            <button class="viewer-button" type="button" title={mode.title}
              aria-pressed={diffViewMode === mode.value} onclick={() => (diffViewMode = mode.value)}>
              {mode.label}
            </button>
          {/each}
        </div>
      {/if}

      <button class="viewer-button wrap-control" type="button" title="Wrap long lines to the available width"
        aria-pressed={wordWrap} onclick={() => (wordWrap = !wordWrap)}>
        Wrap
      </button>
    </div>

    <button class="close-button" type="button" title="Close file"
      aria-label={diffSource === "workingTree" || diffSource === "staged" ? "Close changed file" : "Close diff"}
      onclick={onClose}>
      <X aria-hidden="true" size={16} />
    </button>
  </header>

  {#if (diffSource === "workingTree" || diffSource === "staged") && !loading && diff}
    {#if hunkError || hunkPreview?.unavailableReason}
      <div class="hunk-controls"><p class="text-xs text-[var(--app-theme-text-muted)]">{hunkError || hunkPreview?.unavailableReason}</p></div>
    {:else if selectedHunks.length && contentViewMode === "diff"}
      <div class="hunk-controls flex items-center justify-between gap-3" aria-label="Selected hunks">
        <span class="text-xs text-[var(--app-theme-text-muted)]">{selectedHunks.length} {selectedHunks.length === 1 ? "hunk" : "hunks"} selected</span>
        <button type="button" class="state-action !mt-0" disabled={pending || loading || !renderer || Boolean(renderError) || !onApplyHunks} onclick={() => submitHunks()}>
          {diffSource === "staged" ? "Unstage selected hunks" : "Stage selected hunks"}
        </button>
      </div>
    {/if}
  {/if}

  <div class="diff-body">
    <!-- svelte-ignore a11y_no_noninteractive_tabindex (Keyboard focus enables scrolling and line selection in this code region.) -->
    <div bind:this={viewerContainer} class="diff-content h-full min-h-0 overflow-auto" role="region"
      aria-label={contentViewMode === "diff" ? "File diff" : "File contents"}
      aria-busy={loading || (diff !== null && !diff.isBinary && !renderer && !renderError)} tabindex="0"></div>

    {#if loading || (diff && !diff.isBinary && !renderer && !renderError)}
      <div class="viewer-state" role="status">
        <span class="loading-indicator" aria-hidden="true"></span>
        <p class="state-title">Loading file...</p>
      </div>
    {:else if error || renderError}
      <div class="viewer-state" role="alert">
        <div class="state-message state-error">
          <p class="state-title">Could not load this file</p>
          <p class="state-detail">{error || renderError}</p>
          <button class="state-action" type="button" onclick={retryDiff}>Retry</button>
        </div>
      </div>
    {:else if diff?.isBinary}
      <div class="viewer-state" role="status">
        <div class="state-message">
          <p class="state-title">Binary file</p>
          <p class="state-detail">{diff.message ?? "This file cannot be displayed as text."}</p>
        </div>
      </div>
    {:else if noContentChanges && contentViewMode === "diff" && diffViewMode === "hunks"}
      <div class="viewer-state" role="status">
        <div class="state-message">
          <p class="state-title">No content changes</p>
          <p class="state-detail">The original and modified contents are identical.</p>
          <button class="state-action" type="button" onclick={() => (contentViewMode = "file")}>Show file</button>
        </div>
      </div>
    {:else if displayedFileIsEmpty && (contentViewMode === "file" || noContentChanges)}
      <div class="viewer-state" role="status">
        <div class="state-message">
          <p class="state-title">Empty file</p>
          <p class="state-detail">This file has no text content.</p>
        </div>
      </div>
    {/if}
  </div>
</section>

<style>
  .diff-viewer {
    container-type: inline-size;
    background: var(--app-theme-code-background);
    color: var(--app-theme-code-foreground);
  }

  .diff-toolbar {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto auto;
    align-items: center;
    gap: 12px;
    flex-shrink: 0;
    min-height: 48px;
    padding: 8px 12px;
    border-bottom: 1px solid var(--app-theme-toolbar-border);
    background: var(--app-theme-toolbar);
    color: var(--app-theme-toolbar-foreground);
  }

  .file-heading {
    display: flex;
    align-items: center;
    gap: 10px;
    min-width: 0;
  }

  .file-status {
    display: grid;
    place-items: center;
    flex-shrink: 0;
    width: 24px;
    height: 24px;
    border-radius: 4px;
    background: var(--app-theme-accent-surface);
    color: var(--app-theme-accent-surface-foreground);
    font-size: 11px;
    font-weight: 600;
  }

  .file-path,
  .file-detail {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .file-path {
    font-size: 13px;
    font-weight: 600;
    line-height: 20px;
  }

  .file-detail {
    color: var(--app-theme-text-muted);
    font-size: 11px;
    line-height: 16px;
  }

  .viewer-controls {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
    min-width: 0;
  }

  .mode-group {
    display: inline-flex;
    flex-shrink: 0;
    isolation: isolate;
  }

  .viewer-button,
  .close-button,
  .state-action {
    min-height: 28px;
    border-radius: 4px;
    font-size: 12px;
    font-weight: 500;
    cursor: pointer;
    transition: background-color 120ms ease, color 120ms ease;
  }

  .viewer-button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    height: 32px;
    min-height: 32px;
    padding: 0 12px;
    position: relative;
    border: 1px solid var(--app-theme-toolbar-border);
    border-radius: 0;
    background: transparent;
    color: var(--app-theme-toolbar-control-foreground);
    font-size: 12px;
    font-weight: 600;
    white-space: nowrap;
  }

  .viewer-button + .viewer-button {
    margin-left: -1px;
  }

  .viewer-button:first-child {
    border-radius: 2px 0 0 2px;
  }

  .viewer-button:last-child {
    border-radius: 0 2px 2px 0;
  }

  .viewer-button:hover,
  .close-button:hover {
    background: var(--app-theme-toolbar-control-hover);
  }

  .viewer-button[aria-pressed="true"] {
    z-index: 1;
    border-color: color-mix(in srgb, var(--app-theme-accent) 35%, transparent);
    background: color-mix(in srgb, var(--app-theme-accent) 10%, transparent);
    color: var(--app-theme-accent);
  }

  .viewer-button[aria-pressed="true"]:hover {
    border-color: color-mix(in srgb, var(--app-theme-accent) 55%, transparent);
    background: color-mix(in srgb, var(--app-theme-accent) 20%, transparent);
  }

  .viewer-button:focus-visible {
    z-index: 2;
    outline-offset: -2px;
  }

  .viewer-button.wrap-control {
    border-radius: 2px;
  }

  .close-button {
    display: grid;
    place-items: center;
    width: 28px;
    padding: 0;
    background: transparent;
    color: var(--app-theme-toolbar-control-foreground);
  }

  button:focus-visible {
    outline: 2px solid var(--app-theme-focus);
    outline-offset: 2px;
  }

  .hunk-controls {
    flex-shrink: 0;
    max-height: 180px;
    overflow: auto;
    padding: 10px 12px;
    border-bottom: 1px solid var(--app-theme-toolbar-border);
    background: var(--app-theme-toolbar);
  }
  .diff-content :global(.inline-hunk-actions) {
    display: flex;
    align-items: center;
    gap: 12px;
    min-height: 36px;
    padding: 4px 12px;
    border-block: 1px solid var(--app-theme-toolbar-border);
    background: var(--app-theme-toolbar);
    color: var(--app-theme-toolbar-control-foreground);
    font-family: var(--font-sans, system-ui, sans-serif);
    font-size: 12px;
  }
  .diff-content :global(.inline-hunk-actions:has(input:checked)) {
    background: var(--app-theme-accent-surface);
  }

  .diff-content :global(.inline-hunk-actions label) {
    display: flex;
    align-items: center;
    gap: 8px;
    white-space: nowrap;
    cursor: pointer;
  }

  .diff-content :global(.inline-hunk-actions input) {
    accent-color: var(--app-theme-accent);
  }

  .diff-content :global(.inline-hunk-actions code) {
    min-width: 0;
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--app-theme-text-muted);
    font-size: 11px;
  }

  .diff-content :global(.inline-hunk-actions button) {
    margin-left: auto;
    flex-shrink: 0;
    padding: 2px 8px;
    border: 1px solid var(--app-theme-border);
    border-radius: 4px;
    background: var(--app-theme-toolbar-control);
    cursor: pointer;
  }

  .diff-content :global(.inline-hunk-actions button:hover) {
    background: var(--app-theme-toolbar-control-hover);
  }

  .diff-content :global(.inline-hunk-actions button:disabled),
  .diff-content :global(.inline-hunk-actions input:disabled) {
    cursor: not-allowed;
    opacity: 0.45;
  }

  .diff-content :global(.inline-hunk-actions :focus-visible) {
    outline: 2px solid var(--app-theme-focus);
    outline-offset: 2px;
  }

  button:disabled { cursor: not-allowed; opacity: 0.45; }

  .diff-body {
    position: relative;
    flex: 1;
    min-height: 0;
    min-width: 0;
  }

  .diff-content {
    --diffs-font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace);
    --diffs-header-font-family: var(--font-sans, system-ui, sans-serif);
    --diffs-font-size: 13px;
    --diffs-line-height: 20px;
  }

  .diff-content:focus-visible {
    outline: 2px solid var(--app-theme-focus);
    outline-offset: -2px;
  }

  /* Match T3's host styles as well as the styles inside Pierre's shadow root. */
  .diff-content :global(diffs-container) {
    --diffs-bg: var(--app-theme-code-background) !important;
    --diffs-light-bg: var(--app-theme-code-background) !important;
    --diffs-dark-bg: var(--app-theme-code-background) !important;
    border: 0;
    border-radius: 0;
    overflow: clip;
    background-color: var(--app-theme-code-background) !important;
    color: var(--app-theme-code-foreground) !important;
  }

  .viewer-state {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: safe center;
    gap: 12px;
    overflow: auto;
    padding: 24px;
    background: var(--app-theme-code-background);
    text-align: center;
  }

  .state-message {
    width: 100%;
    max-width: 480px;
  }

  .state-title {
    color: var(--app-theme-code-foreground);
    font-size: 13px;
    font-weight: 600;
    line-height: 20px;
  }

  .state-detail {
    margin-top: 6px;
    overflow-wrap: anywhere;
    white-space: pre-wrap;
    color: var(--app-theme-text-muted);
    font-size: 12px;
    line-height: 20px;
  }

  .state-error {
    padding: 16px;
    border: 1px solid var(--app-theme-error-border);
    border-radius: 6px;
    background: var(--app-theme-error-surface);
  }

  .state-error .state-title,
  .state-error .state-detail {
    color: var(--app-theme-error-foreground);
  }

  .state-action {
    margin-top: 14px;
    padding: 4px 12px;
    border: 1px solid var(--app-theme-border);
    background: var(--app-theme-toolbar-control);
    color: var(--app-theme-toolbar-control-foreground);
  }

  .state-action:hover {
    background: var(--app-theme-toolbar-control-hover);
  }

  .loading-indicator {
    width: 18px;
    height: 18px;
    border: 2px solid var(--app-theme-border);
    border-top-color: var(--app-theme-accent);
    border-radius: 50%;
    animation: loading-spin 800ms linear infinite;
  }

  @keyframes loading-spin {
    to { transform: rotate(360deg); }
  }

  @container (max-width: 720px) {
    .diff-toolbar {
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 8px;
    }

    .viewer-controls {
      grid-column: 1 / -1;
      grid-row: 2;
    }

    .close-button {
      grid-column: 2;
      grid-row: 1;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .viewer-button,
    .close-button,
    .state-action {
      transition: none;
    }

    .loading-indicator {
      animation: none;
    }
  }
</style>
