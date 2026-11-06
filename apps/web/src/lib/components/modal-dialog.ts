/** Mount only while the caller's dialog is open; the browser owns focus and inertness. */
export function modalDialog(node: HTMLDialogElement) {
  node.showModal();
  queueMicrotask(() => {
    if (node.isConnected && node.open) {
      node.querySelector<HTMLElement>("[data-dialog-initial-focus]")?.focus();
    }
  });
  return { destroy: () => node.close() };
}

export function dismissModalOnBackdrop(event: MouseEvent, dismiss: () => void) {
  const dialog = event.currentTarget as HTMLDialogElement;
  if (event.target !== dialog) return;
  const bounds = dialog.getBoundingClientRect();
  if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) dismiss();
}
