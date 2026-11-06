// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import GroupedRepositoriesHome, { type GroupedRepository } from "./GroupedRepositoriesHome.svelte";

let component: ReturnType<typeof mount> | undefined;

afterEach(async () => {
  if (component) await unmount(component);
  component = undefined;
  document.body.replaceChildren();
});

const repositories: GroupedRepository[] = [
  {
    groupId: "alpha",
    title: "Alpha",
    locations: [
      { target: { environmentId: "local", repositoryId: "alpha-one" }, environmentLabel: "This computer", environmentStatus: "connected", path: "D:/work/alpha" },
      { target: { environmentId: "local", repositoryId: "alpha-two" }, environmentLabel: "This computer", environmentStatus: "connected", path: "D:/work/alpha-copy", missing: true, removeAvailability: { allowed: true, reason: "" } },
      { target: { environmentId: "remote", repositoryId: "alpha-agent" }, environmentLabel: "Agentbox", environmentStatus: "offline", path: "/workspace/alpha" },
    ],
  },
  {
    groupId: "solo",
    title: "Solo",
    locations: [
      { target: { environmentId: "local", repositoryId: "solo-one" }, environmentLabel: "This computer", environmentStatus: "connected", path: "D:/work/solo" },
    ],
  },
];

function render(props: { repositories?: readonly GroupedRepository[]; onOpenLocation?: ReturnType<typeof vi.fn>; onRemoveLocation?: ReturnType<typeof vi.fn> } = {}) {
  const container = document.createElement("div");
  document.body.append(container);
  component = mount(GroupedRepositoriesHome, {
    target: container,
    props: {
      repositories: props.repositories ?? repositories,
      onOpenLocation: props.onOpenLocation ?? vi.fn(),
      onRemoveLocation: props.onRemoveLocation,
    },
  });
  flushSync();
  return container;
}

describe("grouped repositories home", () => {
  it("omits the local machine label while retaining remote environment names", () => {
    const container = render({ repositories: [
      { groupId: "single", title: "Solo", locations: [{ target: { environmentId: "local", repositoryId: "solo" }, environmentLabel: "GitGui on DESKTOP", local: true, path: "D:/solo" }] },
      { groupId: "mixed", title: "Shared", locations: [
        { target: { environmentId: "local", repositoryId: "one" }, environmentLabel: "GitGui on DESKTOP", local: true, path: "D:/shared" },
        { target: { environmentId: "remote", repositoryId: "two" }, environmentLabel: "agentbox", path: "/shared" },
      ] },
    ] });
    expect(container.textContent).not.toContain("GitGui on DESKTOP");
    expect(container.textContent).toContain("agentbox");
    expect(container.querySelector('[aria-label="Solo, Local, D:/solo"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="Shared, Local, D:/shared"]')).not.toBeNull();
  });

  it("displays and searches a readable Windows path without changing the scoped target", () => {
    const open = vi.fn();
    const target = { environmentId: "local", repositoryId: "repo" };
    const container = render({ onOpenLocation: open, repositories: [{ groupId: "repo", title: "Repo", locations: [
      { target, local: true, environmentLabel: "Desktop", path: "\\\\?\\D:\\ProgrammingProjects\\GitGui" },
    ] }] });
    expect(container.textContent).toContain("D:\\ProgrammingProjects\\GitGui");
    expect(container.textContent).not.toContain("\\\\?\\");
    const search = container.querySelector<HTMLInputElement>("#grouped-repository-search")!;
    search.value = "d:\\programmingprojects";
    search.dispatchEvent(new Event("input", { bubbles: true })); flushSync();
    [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.getAttribute("aria-label") === "Repo, Local, D:\\ProgrammingProjects\\GitGui")!.click();
    expect(open).toHaveBeenCalledWith(target);
  });
  it("shows one logical repository row and every scoped location with environment and path labels", () => {
    const container = render();
    expect(container.querySelectorAll("h3")).toHaveLength(2);
    expect(container.textContent).toContain("Alpha");
    expect(container.textContent).toContain("This computer");
    expect(container.textContent).toContain("Agentbox");
    expect(container.textContent).toContain("D:/work/alpha-copy");
    expect(container.textContent).toContain("/workspace/alpha");
    expect(container.querySelectorAll("[aria-label^='Alpha,']")).toHaveLength(3);
    expect(container.querySelector("button[aria-label='Solo, This computer, D:/work/solo']")).not.toBeNull();
    expect(container.querySelectorAll("details")).toHaveLength(1);
    expect(container.querySelector("summary")?.textContent).toContain("This computer");
  });

  it("filters by repository, environment, or path", () => {
    const container = render();
    const search = container.querySelector<HTMLInputElement>("#grouped-repository-search")!;
    search.value = "agentbox";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    flushSync();
    expect(container.querySelectorAll("h3")).toHaveLength(1);
    expect(container.querySelector("h3")?.textContent).toBe("Alpha");
    expect(container.textContent).toContain("/workspace/alpha");
    expect(container.textContent).not.toContain("D:/work/solo");
  });

  it("keeps removal permission visible to keyboard users and reports the filtered result count", () => {
    const container = render({ onRemoveLocation: vi.fn() });
    expect(container.querySelector('[aria-live="polite"]')?.textContent).toContain("2 repositories");
    const remove = container.querySelector<HTMLButtonElement>('button[aria-label="Remove Alpha at D:/work/alpha-copy from GitGui"]')!;
    expect(remove.disabled).toBe(false);
    expect(remove.className).toContain("focus-visible:opacity-100");
    expect(remove.title).toContain("files stay on disk");
    const search = container.querySelector<HTMLInputElement>("#grouped-repository-search")!;
    search.value = "solo";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    flushSync();
    expect(container.querySelector('[aria-live="polite"]')?.textContent).toContain("1 repository");
  });

  it("exposes unavailable removal reasons to keyboard users without executing removal", () => {
    const onRemoveLocation = vi.fn();
    const container = render({ onRemoveLocation });
    const denied = container.querySelector<HTMLButtonElement>('button[aria-label^="Remove Solo at"]')!;
    expect(denied.disabled).toBe(false);
    expect(denied.getAttribute("aria-disabled")).toBe("true");
    expect(denied.getAttribute("aria-label")).toContain("Session authorization is unavailable.");
    denied.focus();
    expect(document.activeElement).toBe(denied);
    denied.click();
    expect(onRemoveLocation).not.toHaveBeenCalled();
  });

  it("opens and removes the exact scoped target, and keeps Missing compact and readable", () => {
    const onOpenLocation = vi.fn();
    const onRemoveLocation = vi.fn();
    const container = render({ onOpenLocation, onRemoveLocation });
    const target = repositories[0].locations[1].target;
    container.querySelector("summary")!.click();
    flushSync();
    const missing = container.querySelector<HTMLButtonElement>('button[aria-label="Alpha, This computer, D:/work/alpha-copy, Missing"]')!;
    expect(missing.textContent).toContain("Missing");
    expect(missing.querySelector("span:last-child")?.className).toContain("text-xs");
    missing.click();
    expect(onOpenLocation).toHaveBeenCalledExactlyOnceWith(target);

    container.querySelector<HTMLButtonElement>('button[aria-label="Remove Alpha at D:/work/alpha-copy from GitGui"]')!.click();
    expect(onRemoveLocation).toHaveBeenCalledExactlyOnceWith(target);
  });

  it("uses a native disclosure for multiple clones in one environment", () => {
    const container = render();
    const details = container.querySelector("details")!;
    const summary = details.querySelector("summary")!;
    expect(details.open).toBe(false);
    expect(summary.tagName).toBe("SUMMARY");
    summary.click();
    flushSync();
    expect(details.open).toBe(true);
    expect(details.querySelectorAll("[aria-label^='Alpha,']")).toHaveLength(2);
    expect(container.textContent).toContain("Offline");
    expect(container.querySelector('[aria-label="Alpha, Agentbox, /workspace/alpha, Offline"]')).not.toBeNull();
  });
});
