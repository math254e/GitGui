/** An aborted or superseded inspection must never publish into a new selection. */
export class StashRead {
  private controller?: AbortController;
  begin() {
    this.cancel();
    const controller = new AbortController();
    this.controller = controller;
    return { signal: controller.signal, current: () => this.controller === controller && !controller.signal.aborted };
  }
  cancel() { this.controller?.abort(); }
}
