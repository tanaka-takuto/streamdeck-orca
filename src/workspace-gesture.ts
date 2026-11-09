/** Release-to-second-down interval; the second press may itself become a hold. */
export const DOUBLE_CLICK_MS = 500;
export const LONG_PRESS_MS = 700;
export type WorkspaceGestureKind = "short" | "double" | "long";
export class WorkspaceGesture {
  private hold?: ReturnType<typeof setTimeout>;
  private click?: ReturnType<typeof setTimeout>;
  private held = false;
  private second = false;
  private consumed = false;
  private busy = false;
  private revision = 0;
  constructor(
    private readonly execute: (
      kind: WorkspaceGestureKind,
      current: () => boolean,
    ) => Promise<void>,
    private readonly feedback: (message: string) => void,
  ) {}
  down(): void {
    if (this.held) return;
    this.held = true;
    this.consumed = this.busy;
    if (this.busy) return;
    this.second = this.click !== undefined;
    clearTimeout(this.click);
    this.click = undefined;
    this.feedback("登録まで長押し");
    this.hold = setTimeout(() => {
      this.consumed = true;
      this.run("long");
    }, LONG_PRESS_MS);
  }
  up(): void {
    if (!this.held) return;
    this.held = false;
    clearTimeout(this.hold);
    if (this.consumed || this.busy) return;
    if (this.second) this.run("double");
    else {
      this.feedback("移動待ち");
      this.click = setTimeout(() => {
        this.click = undefined;
        this.run("short");
      }, DOUBLE_CLICK_MS);
    }
  }
  cancel(): void {
    ++this.revision;
    clearTimeout(this.hold);
    clearTimeout(this.click);
    this.click = undefined;
    // A key-up belonging to a cancelled press must never start a new gesture.
    this.consumed = true;
    this.second = false;
  }
  private run(kind: WorkspaceGestureKind): void {
    if (this.busy) return;
    this.busy = true;
    const revision = this.revision;
    void this.execute(kind, () => this.revision === revision).finally(() => {
      this.busy = false;
    });
  }
}
