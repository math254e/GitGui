/** Mount only while the caller's dialog is open; the browser owns focus and inertness. */
export function modalDialog(node: HTMLDialogElement) {
  const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  node.showModal();
  queueMicrotask(() => {
    if (node.isConnected && node.open) {
      node.querySelector<HTMLElement>("[data-dialog-initial-focus]")?.focus();
    }
  });
  return {
    destroy: () => {
      node.close();
      // Conditional Svelte dialogs can be detached before close(), which loses
      // native focus restoration. Let a replacement dialog or focused control win.
      queueMicrotask(() => {
        const active = document.activeElement;
        if (opener?.isConnected && !document.querySelector("dialog[open]") &&
          (!active || active === document.body || node.contains(active))) {
          opener.focus();
        }
      });
    },
  };
}

export function dismissModalOnBackdrop(event: MouseEvent, dismiss: () => void) {
  const dialog = event.currentTarget as HTMLDialogElement;
  if (event.target !== dialog) return;
  const bounds = dialog.getBoundingClientRect();
  if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) dismiss();
}
