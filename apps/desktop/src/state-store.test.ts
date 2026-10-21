import { mkdtemp, mkdir, readFile, rename, rm, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

// Exercise the real filesystem store; only the Electron encryption primitive
// is substituted so these tests run without launching the desktop shell.
vi.mock("electron", () => ({ safeStorage: {
  isEncryptionAvailable: () => true,
  encryptString: (value: string) => Buffer.from(value),
  decryptString: (value: Buffer) => value.toString(),
} }));
import { DesktopStateStore } from "./state-store.js";

const registration = (id: string) => ({ environmentId: id, displayName: id, record: "{}", capabilities: [], protocolVersion: 2 });
const credential = { kind: "bearer" as const, token: "test-fixture-session" };

describe("desktop state persistence failures", () => {
  it.each(["write", "rename"])("retains cached registrations and credentials after a failed %s, including the next commit", async (failure) => {
    const directory = await mkdtemp(join(tmpdir(), "gitgui-state-test-"));
    const path = join(directory, "state.json");
    const temporary = `${path}.tmp-${process.pid}`;
    const backup = join(directory, "previous-state.json");
    try {
      const store = new DesktopStateStore(path);
      await store.saveRegistration(registration("remote"));
      await store.setCredential("remote", credential);
      const original = await readFile(path, "utf8");
      if (failure === "write") await mkdir(temporary);
      else { await rename(path, backup); await mkdir(path); }

      await expect(store.removeRegistration("remote")).rejects.toThrow();
      expect(await store.listRegistrations()).toEqual([registration("remote")]);
      expect(await store.getCredential("remote")).toEqual(credential);
      expect(await readFile(failure === "write" ? path : backup, "utf8")).toBe(original);

      if (failure === "write") await rmdir(temporary);
      else { await rmdir(path); await rename(backup, path); }
      await store.saveRegistration(registration("another"));
      const reopened = new DesktopStateStore(path);
      expect((await reopened.listRegistrations()).map((entry) => entry.environmentId)).toEqual(["remote", "another"]);
      expect(await reopened.getCredential("remote")).toEqual(credential);
      await store.removeRegistration("remote");
      expect(await store.getCredential("remote")).toBeUndefined();
      expect((await store.listRegistrations()).map((entry) => entry.environmentId)).toEqual(["another"]);
    } finally {
      // Only the exact isolated directory created above is removed.
      await rm(directory, { recursive: true, force: true });
    }
  });
});
