export const FOREGROUND_PRESENCE_TTL_MS = 25_000;

export class InvalidPresenceError extends Error {
  constructor() {
    super("Invalid foreground presence.");
    this.name = "InvalidPresenceError";
  }
}

export class ForegroundPresence {
  private readonly pages = new Map<string, number>();
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  update(pageId: unknown, foreground: unknown): boolean {
    if (
      typeof pageId !== "string" ||
      pageId.length === 0 ||
      pageId.length > 128 ||
      typeof foreground !== "boolean"
    ) {
      throw new InvalidPresenceError();
    }

    if (foreground) {
      this.pages.set(pageId, this.now() + FOREGROUND_PRESENCE_TTL_MS);
    } else {
      this.pages.delete(pageId);
    }
    return this.isForeground();
  }

  count(): number {
    const now = this.now();
    for (const [pageId, expiresAt] of this.pages) {
      if (expiresAt <= now) this.pages.delete(pageId);
    }
    return this.pages.size;
  }

  isForeground(): boolean {
    return this.count() > 0;
  }
}
