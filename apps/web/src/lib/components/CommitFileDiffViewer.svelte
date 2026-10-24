<script lang="ts">
  import { X } from "@lucide/svelte";
  import LargeFileNotice from "./LargeFileNotice.svelte";
  import { fileViewState } from "./file-view-state";
  import { onMount, untrack } from "svelte";
  import type { CodeView, DiffLineAnnotation, FileContents, FileDiffMetadata } from "@pierre/diffs";
  import type { GitHunkPreview, GitApplyHunksParams } from "@gitgui/contracts";
  import type { GitGuiClient } from "@gitgui/client-runtime";
  import { DIFF_VIEW_UNSAFE_CSS, resolveDiffThemeName } from "$lib/theme/diffTheme";
  import { parseDiffInWorker } from "$lib/diff/parser";
  import { acquireDiffRenderer } from "$lib/diff/renderer";
  import { themeStore } from "$lib/theme/useTheme";
  import type { ThemeAppearance } from "$lib/theme/types";
  import type { CommitFile, CommitFileDiff, CommitInfo, RepositorySnapshot, StashInfo } from "$lib/types/repository";
  import { buildFileDiffRequestKey, buildFileDiffSelectionKey } from "./file-diff-request-key";
  import { hasCurrentHunkReview, resolveFileDiffPatch, reuseFileDiff, reuseHunkPreview } from "./file-diff-response";
  import { canMutateFileDiff, requestFileDiff, type DiffSource } from "./file-diff-source";

  type HunkAnnotation = { id: number; header: string; request: number; revision: string };
  type DiffViewMode = "hunks" | "inline" | "split";
  type ContentViewMode = "diff" | "file";
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
    selectedStash?: StashInfo | null;
    selectedFile: CommitFile;
    contentRevision?: number;
    onClose: () => void;
    onApplyHunks?: (params: GitApplyHunksParams) => void;
    pending?: boolean;
  };

  let { client, repositoryId, snapshot, diffSource, selectedCommit, selectedStash = null, selectedFile, contentRevision = 0, onClose, onApplyHunks, pending = false }: Props = $props();
  const viewerId = $props.id();
  let releaseRendererResources: (() => void) | undefined;
  let viewerContainer: HTMLDivElement;
  let renderer = $state.raw<{ viewer: CodeView<HunkAnnotation>; annotationName: (annotation: DiffLineAnnotation<HunkAnnotation>) => string } | null>(null);
  let parsedDiff = $state.raw<{ source: CommitFileDiff; preview: GitHunkPreview | null; metadata: FileDiffMetadata } | null>(null);
  let parsing = $state(false);
  let reviewedRequestKey = $state("");
  let parseError = $state("");
  let diff = $state.raw<CommitFileDiff | null>(null);
  let hunkPreview = $state.raw<GitHunkPreview | null>(null);
  let hunkError = $state("");
  let selectedHunks = $state<number[]>([]);
  let hunkActions = new Map<string, HunkAnnotation>();
  const mountedHunkActions = new WeakMap<HTMLElement, Map<string, { element: HTMLElement; hunk: HunkAnnotation }>>();
  let loading = $state(false);
  let error = $state("");
  let renderError = $state("");
  let contentViewMode = $state<ContentViewMode>("diff");
  let diffViewMode = $state<DiffViewMode>("inline");
  let wordWrap = $state(false);
  let appearance = $state<ThemeAppearance>(themeStore.getSnapshot().resolvedAppearance);
  let activeRequest = 0;
  let activeSelection = 0;
  let activeSelectionKey = "";
  let activeStatusSnapshot: RepositorySnapshot["status"] | null = null;
  let selectionController: AbortController | undefined;
  // CodeView ignores new payloads with an unchanged item version, including
  // hunk annotations arriving after the file contents.
  let renderVersion = 0;
  let parseVersion = 0;
  let contentVersion = 0;
  let activeDiffRequestKey = "";
  let activeDiffClient: GitGuiClient | null = null;
  let destroyed = false;
  const diffRequestKey = $derived(buildFileDiffRequestKey(repositoryId, snapshot, diffSource, selectedCommit, selectedFile, contentRevision, selectedStash, client.serverWelcome.environment_id));
  const noContentChanges = $derived(diff !== null && diff.originalContent === diff.modifiedContent);
  const showingDeletedFile = $derived(statusLabel(selectedFile) === "D");
  const displayedFileIsEmpty = $derived(diff !== null &&
    (showingDeletedFile ? diff.originalContent : diff.modifiedContent) === "");
  const viewState = $derived(fileViewState(diff, (loading && diff === null) || (contentViewMode === "diff" && parsing && parsedDiff === null),
    error || (contentViewMode === "diff" ? parseError : ""), renderError, renderer !== null));
  const hunkActionsDisabled = $derived(!canMutateFileDiff(diffSource) || pending || Boolean(error) || Boolean(parseError) ||
    Boolean(hunkError) || Boolean(renderError) || !onApplyHunks ||
    !hasCurrentHunkReview(diff, hunkPreview, parsedDiff, reviewedRequestKey, diffRequestKey));

  $effect(() => {
    const requestKey = diffRequestKey;

    const currentSnapshot = snapshot;
    const currentClient = client;
    if (currentClient === activeDiffClient && requestKey === activeDiffRequestKey &&
        (diffSource === "stash" || diffSource === "commit" || diffSource === "commitWorkingTree" || currentSnapshot.status === activeStatusSnapshot)) {
      return;
    }

    activeDiffClient = currentClient;
    activeDiffRequestKey = requestKey;
    activeStatusSnapshot = currentSnapshot.status;
    untrack(() => { void loadDiff(repositoryId, diffSource, selectedCommit, selectedFile, currentSnapshot); });
  });

  $effect(() => {
    const currentDiff = diff;
    const preview = hunkPreview;
    parseError = "";
    parsing = false;
    if (!currentDiff || currentDiff.isBinary || currentDiff.omittedContent ||
        currentDiff.originalContent === currentDiff.modifiedContent) {
      parsedDiff = null;
      return;
    }

    // Worktree text can have CRLF/clean-filter differences from the index.
    // The snapshot patch is not the reviewed Git patch: displaying it first
    // can turn a small edit into a full rewrite until the review arrives.
    // Keep an existing display during revalidation and parse only the review,
    // or the snapshot fallback once review has explicitly failed.
    const patch = resolveFileDiffPatch(currentDiff, preview, canMutateFileDiff(diffSource), hunkError);
    if (!patch) {
      parsing = true;
      return;
    }

    const controller = new AbortController();
    parsing = true;
    void parseDiffInWorker({
      originalPath: currentDiff.originalPath,
      modifiedPath: currentDiff.modifiedPath,
      originalContent: currentDiff.originalContent,
      modifiedContent: currentDiff.modifiedContent,
      patch: patch.patch,
      cacheKey: `${viewerId}:diff:${++parseVersion}`,
    }, controller.signal).then(({ metadata, durationMs }) => {
      if (destroyed || controller.signal.aborted) return;
      parsedDiff = { source: currentDiff, preview, metadata };
      recordDiffDiagnostic("parse", durationMs, currentDiff);
    }).catch((caught) => {
      if (!destroyed && !controller.signal.aborted) parseError = formatError(caught);
    }).finally(() => {
      if (!destroyed && !controller.signal.aborted) parsing = false;
    });
    // Terminating the worker interrupts synchronous parsing immediately; stale
    // results cannot replace the current selection, even on older servers.
    return () => controller.abort();
  });

  $effect(() => {
    const currentDiff = diff;
    const startedAt = performance.now();
    renderView(renderer, currentDiff, parsedDiff, contentViewMode, diffViewMode, wordWrap, appearance);
    if (renderer && currentDiff && !currentDiff.isBinary) {
      recordDiffDiagnostic("render", performance.now() - startedAt, currentDiff);
    }
  });

  $effect(() => {
    const selection = selectedHunks;
    const disabled = hunkActionsDisabled;
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
      activeSelection += 1;
      selectionController?.abort();
      unsubscribeTheme();
      renderer?.viewer.cleanUp();
      releaseRendererResources?.();
      parsedDiff = null;
    };
  });

  async function initializeViewer() {
    const resources = acquireDiffRenderer();
    releaseRendererResources = resources.release;
    try {
      const { library, workers } = await resources.ready;
      if (destroyed) { resources.release(); return; }
      const viewer = new library.CodeView<HunkAnnotation>({}, workers);
      viewer.setup(viewerContainer);
      renderer = { viewer, annotationName: library.getLineAnnotationName };
    } catch (caught) {
      resources.release();
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
    const requestKey = buildFileDiffRequestKey(repositoryId, currentSnapshot, source, commit, file, contentRevision, selectedStash, client.serverWelcome.environment_id);
    const selectionKey = buildFileDiffSelectionKey(repositoryId, source, commit, file, selectedStash, client.serverWelcome.environment_id);
    if (selectionKey !== activeSelectionKey) {
      activeSelectionKey = selectionKey;
      activeSelection += 1;
      diff = null;
      parsedDiff = null;
      hunkPreview = null;
      reviewedRequestKey = "";
      selectedHunks = [];
    }
    hunkError = "";
    error = "";
    if (renderer) renderError = "";
    loading = true;

    try {
      const resultPromise = requestFileDiff(client, repositoryId, source, commit, selectedStash, file, currentSnapshot, signal);

      const result = await resultPromise;
      if (!destroyed && request === activeRequest) {
        const nextDiff = reuseFileDiff(diff, result.diff);
        if (nextDiff !== diff) {
          contentVersion += 1;
          hunkPreview = null;
          selectedHunks = [];
          diff = nextDiff;
        }
        // Contents are ready before the Git patch. The continuation shares
        // their status/index snapshot and first full-file read with preview.
        if (canMutateFileDiff(source) && !diff.isBinary && !diff.omittedContent) {
          if (result.hunkError) {
            hunkError = result.hunkError;
            hunkPreview = null;
            selectedHunks = [];
          }
          else void loadHunkPreview(request, repositoryId, source, file.path, signal, requestKey, result.hunkContextId);
        }
      }
    } catch (caught) {
      if (!destroyed && request === activeRequest) {
        error = formatError(caught);
        reviewedRequestKey = "";
      }
    } finally {
      if (!destroyed && request === activeRequest) {
        loading = false;
      }
    }
  }

  async function loadHunkPreview(request: number, repositoryId: string, source: DiffSource, filePath: string, signal: AbortSignal, requestKey: string, contextId?: string) {
    try {
      const preview = await client.getHunkPreview({ repositoryId, filePath, staged: source === "staged", ...(contextId ? { contextId } : {}) }, signal);
      if (!destroyed && request === activeRequest) {
        const nextPreview = reuseHunkPreview(hunkPreview, preview);
        if (nextPreview !== hunkPreview) selectedHunks = [];
        hunkPreview = nextPreview;
        reviewedRequestKey = requestKey;
      }
    } catch (caught) {
      if (!destroyed && request === activeRequest) {
        hunkError = formatError(caught);
        reviewedRequestKey = "";
      }
    }
  }

  function renderView(
    currentRenderer: typeof renderer,
    currentDiff: CommitFileDiff | null,
    prepared: typeof parsedDiff,
    view: ContentViewMode,
    mode: DiffViewMode,
    wrap: boolean,
    themeAppearance: ThemeAppearance,
  ) {
    if (!currentRenderer || destroyed) {
      return;
    }

    const { viewer } = currentRenderer;
    if (!currentDiff || currentDiff.isBinary || currentDiff.omittedContent) {
      hunkActions = new Map();
      renderError = "";
      viewer.setItems([]);
      return;
    }

    const unchanged = currentDiff.originalContent === currentDiff.modifiedContent;
    // Keep the displayed rows and highlighting while a refreshed snapshot or
    // reviewed hunk patch is parsed. Replace them only with a complete result.
    if (view === "diff" && !unchanged &&
        (prepared?.source !== currentDiff || prepared.preview !== hunkPreview)) return;

    try {
      hunkActions = new Map();
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
        // Keep very large files as virtualized text; highlighting is optional
        // and must not allocate a whole-file token tree for enormous inputs.
        tokenizeMaxLength: currentDiff.originalContent.length + currentDiff.modifiedContent.length > 256 * 1024 ? 0 : 20_000,
        tokenizeMaxLineLength: 1000,
        overflow: wrap ? "wrap" : "scroll",
        enableLineSelection: true,
        lineHoverHighlight: "both",
        // Pierre eagerly creates every annotation's DOM even in virtualized
        // views. Mount action controls only for slots in the rendered window.
        renderAnnotation: undefined,
        onPostRender: (node, _instance, phase) => untrack(() => syncVisibleHunkActions(node, phase === "unmount")),
        // These measurements match the shared T3 separator stylesheet.
        itemMetrics: { hunkSeparatorHeight: 24, spacing: 0, paddingTop: 0, paddingBottom: 8 },
        layout: { paddingTop: 0, paddingBottom: 0, gap: 0 },
      });

      const modifiedFile: FileContents = {
        name: currentDiff.modifiedPath,
        contents: currentDiff.modifiedContent,
        cacheKey: `${viewerId}:file:${contentVersion}:modified`,
      };

      // A pure rename has no hunks for Diffs to render. Keep its full contents
      // available in the expanded views and show an empty state in Hunks.
      if (unchanged && view === "diff" && mode === "hunks") {
        viewer.setItems([]);
        return;
      }

      if (view === "file" || unchanged) {
        // Deleted files still have useful original contents to inspect.
        const file = view === "file" && showingDeletedFile
          ? { name: currentDiff.originalPath ?? currentDiff.modifiedPath, contents: currentDiff.originalContent, cacheKey: `${viewerId}:file:${contentVersion}:original` }
          : modifiedFile;
        viewer.setItems(file.contents === "" ? [] : [{ id: file.cacheKey!, type: "file", file, version: ++renderVersion }]);
        return;
      }

      // Layout, theme, and wrapping reuse the worker result without reparsing.
      if (prepared?.source !== currentDiff || prepared.preview !== hunkPreview) {
        return;
      }

      const preview = hunkPreview;
      const annotations: DiffLineAnnotation<HunkAnnotation>[] = canMutateFileDiff(diffSource) && preview && !preview.unavailableReason && onApplyHunks
        ? prepared.metadata.hunks.map((hunk, id) => ({
            // Place controls directly after their Git hunk, including additions
            // and deletions where only one side has any lines.
            side: hunk.additionCount ? "additions" : "deletions",
            lineNumber: hunk.additionCount
              ? hunk.additionStart + hunk.additionCount - 1
              : hunk.deletionStart + hunk.deletionCount - 1,
            metadata: { id: preview.hunks[id].id, header: preview.hunks[id].header, request: activeSelection, revision: preview.revision },
          }))
        : [];
      for (const annotation of annotations) hunkActions.set(currentRenderer.annotationName(annotation), annotation.metadata);
      // Pierre retains a reused item's old highlighted text until its next
      // highlight finishes. New content needs a fresh renderer immediately;
      // layout/theme changes keep the same parsed result and item identity.
      viewer.setItems([{ id: prepared.metadata.cacheKey!, type: "diff", fileDiff: prepared.metadata, annotations, version: ++renderVersion }]);
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

  function syncVisibleHunkActions(node: HTMLElement, unmount: boolean) {
    const mounted = mountedHunkActions.get(node) ?? new Map<string, { element: HTMLElement; hunk: HunkAnnotation }>();
    mountedHunkActions.set(node, mounted);
    const visible = new Set<string>();
    if (!unmount) for (const slot of node.shadowRoot?.querySelectorAll<HTMLSlotElement>("slot[name]") ?? []) {
      const hunk = hunkActions.get(slot.name);
      if (!hunk) continue;
      visible.add(slot.name);
      const cached = mounted.get(slot.name);
      if (cached && cached.hunk.request === hunk.request && cached.hunk.revision === hunk.revision) continue;
      cached?.element.remove();
      const element = document.createElement("div");
      element.slot = slot.name;
      element.dataset.annotationSlot = "";
      element.style.whiteSpace = "normal";
      element.appendChild(renderHunkAction(hunk));
      node.appendChild(element);
      mounted.set(slot.name, { element, hunk });
    }
    for (const [name, { element }] of mounted) if (!visible.has(name)) {
      element.remove();
      mounted.delete(name);
    }
  }

  function renderHunkAction(hunk: HunkAnnotation) {
    const row = document.createElement("div");
    row.className = "inline-hunk-actions";
    row.dataset.hunkAction = String(hunk.id);
    const label = document.createElement("label");
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = selectedHunks.includes(hunk.id);
    checkbox.disabled = hunkActionsDisabled;
    checkbox.setAttribute("aria-label", `Select hunk ${hunk.id + 1}`);
    checkbox.onchange = () => {
      if (hunk.request === activeSelection && hunk.revision === hunkPreview?.revision &&
          !destroyed && !hunkActionsDisabled) toggleHunk(hunk.id);
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
      if (!destroyed && hunk.request === activeSelection && hunk.revision === hunkPreview?.revision) submitHunks([hunk.id]);
    };
    row.append(label, header, action);
    return row;
  }

  function submitHunks(ids = [...selectedHunks]) {
    if (!hunkPreview || hunkActionsDisabled || !ids.length) return;
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
    // Retry must restart parsing even when the server returns identical text.
    activeSelectionKey = "";
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
      aria-label={canMutateFileDiff(diffSource) ? "Close changed file" : "Close diff"}
      onclick={onClose}>
      <X aria-hidden="true" size={16} />
    </button>
  </header>

  {#if canMutateFileDiff(diffSource) && diff && !diff.omittedContent}
    {#if hunkError || hunkPreview?.unavailableReason}
      <div class="hunk-controls"><p class="text-xs text-[var(--app-theme-text-muted)]">{hunkError || hunkPreview?.unavailableReason}</p></div>
    {:else if selectedHunks.length && contentViewMode === "diff"}
      <div class="hunk-controls flex items-center justify-between gap-3" aria-label="Selected hunks">
        <span class="text-xs text-[var(--app-theme-text-muted)]">{selectedHunks.length} {selectedHunks.length === 1 ? "hunk" : "hunks"} selected</span>
        <button type="button" class="state-action !mt-0" disabled={hunkActionsDisabled} onclick={() => submitHunks()}>
          {diffSource === "staged" ? "Unstage selected hunks" : "Stage selected hunks"}
        </button>
      </div>
    {/if}
  {/if}

  <div class="diff-body">
    <!-- svelte-ignore a11y_no_noninteractive_tabindex (Keyboard focus enables scrolling and line selection in this code region.) -->
    <div bind:this={viewerContainer} class="diff-content h-full min-h-0 overflow-auto" role="region"
      aria-label={contentViewMode === "diff" ? "File diff" : "File contents"}
      aria-busy={viewState === "loading"} tabindex="0"></div>

    {#if viewState === "loading"}
      <div class="viewer-state" role="status">
        <span class="loading-indicator" aria-hidden="true"></span>
        <p class="state-title">Loading file...</p>
      </div>
    {:else if viewState === "error"}
      <div class="viewer-state" role="alert">
        <div class="state-message state-error">
          <p class="state-title">Could not load this file</p>
          <p class="state-detail">{error || (contentViewMode === "diff" ? parseError : "") || renderError}</p>
          <button class="state-action" type="button" onclick={retryDiff}>Retry</button>
        </div>
      </div>
    {:else if viewState === "binary" && diff}
      <div class="viewer-state" role="status">
        <div class="state-message">
          <p class="state-title">Binary file</p>
          <p class="state-detail">{diff.message ?? "This file cannot be displayed as text."}</p>
        </div>
      </div>
    {:else if diff?.omittedContent}
      {#key diff}
        <LargeFileNotice omitted={diff.omittedContent} repositoryPath={snapshot.info.root} />
      {/key}
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
