/**
 * Counts the calls in flight on one carrier. Once it is retired, it closes the carrier when the last call settles,
 * or at once when it is idle; the close runs exactly once.
 */
export class Drainable {
  private readonly onClose: () => void;
  private inflight: number = 0;
  private retired: boolean = false;
  private closed: boolean = false;

  public constructor(onClose: () => void) {
    this.onClose = onClose;
  }

  public begin(): void {
    this.inflight++;
  }

  public end(): void {
    this.inflight--;
    this.closeIfDrained();
  }

  public retire(): void {
    if(this.retired) {
      return;
    }

    this.retired = true;
    this.closeIfDrained();
  }

  public isRetired(): boolean {
    return this.retired;
  }

  private closeIfDrained(): void {
    if(this.retired && this.inflight === 0 && !this.closed) {
      this.closed = true;
      this.onClose();
    }
  }
}
