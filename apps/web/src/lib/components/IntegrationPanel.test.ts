// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import IntegrationPanel from "./IntegrationPanel.svelte";
import type { RepositoryPageModel } from "$lib/workspace/repository-routing";

let component: ReturnType<typeof mount> | undefined;
afterEach(async () => { if (component) await unmount(component); component = undefined; document.body.replaceChildren(); });

function model(overrides: Record<string, unknown> = {}): RepositoryPageModel {
  return {
    snapshot: { refs: [], status: { currentBranch: "feature" } },
    client: { serverWelcome: { capabilities: ["git.integration.inspect", "git.rewrite_push.execute"] } },
    activeRepositoryId: "repo", activeEnvironmentGeneration: 1,
    refreshIntegration: vi.fn(), canIntegrate: true, integrationError: "", integrationState: null,
    integrationReview: null, rewritePushReview: null, rewritePushReviewPending: false,
    integrationRecoveryDialog: null, confirmIntegrationRecovery: vi.fn(),
    recoverIntegration: vi.fn(), openIntegrationReview: vi.fn(), openRewritePushReview: vi.fn(),
    ...overrides,
  } as unknown as RepositoryPageModel;
}

describe("merge and rebase controls", () => {
  it("renders no toolbar when there is no review or confirmation", () => {
    const store = model();
    component = mount(IntegrationPanel, { target: document.body, props: { store } });
    flushSync();
    expect(document.body.textContent?.trim()).toBe("");
    expect(store.refreshIntegration).toHaveBeenCalled();
  });

  it("confirms before skipping a rebased commit", () => {
    const store = model({ integrationRecoveryDialog: { repositoryId: "repo", environmentId: "env", kind: "rebase", action: "skip" } });
    component = mount(IntegrationPanel, { target: document.body, props: { store } });
    flushSync();
    expect(document.querySelector("dialog")?.textContent).toContain("current replayed commit");
    [...document.querySelectorAll("button")].find((button) => button.textContent === "Confirm")?.click();
    expect(store.confirmIntegrationRecovery).toHaveBeenCalledOnce();
  });

  it("states the operation direction and warns about rewritten history", () => {
    const store = model({ integrationReview: { repositoryId: "repo", environmentId: "env", action: "rebase", review: {
      currentRef: "refs/heads/feature", targetRef: "refs/heads/main", headOid: "a".repeat(40), targetOid: "b".repeat(40),
    } } });
    component = mount(IntegrationPanel, { target: document.body, props: { store } });
    flushSync();
    const dialog = document.querySelector('dialog')!;
    expect(dialog.textContent).toContain("Rebase refs/heads/feature onto refs/heads/main");
    expect(dialog.textContent).toContain("rewrites commit IDs");
  });
});
