import type { DayPass } from "./types.js";

export class PaymentTracker {
  private dayPasses: Map<string, DayPass> = new Map();
  private durationMs: number;

  constructor(durationHours: number) {
    this.durationMs = durationHours * 60 * 60 * 1000;
  }

  grantDayPass(unicityId: string): DayPass {
    const now = Date.now();
    const pass: DayPass = {
      unicityId,
      grantedAt: now,
      expiresAt: now + this.durationMs,
    };
    this.dayPasses.set(unicityId.toLowerCase(), pass);
    return pass;
  }

  hasValidPass(unicityId: string): boolean {
    const pass = this.dayPasses.get(unicityId.toLowerCase());
    if (!pass) return false;
    return Date.now() < pass.expiresAt;
  }

  getPass(unicityId: string): DayPass | null {
    const pass = this.dayPasses.get(unicityId.toLowerCase());
    if (!pass) return null;
    if (Date.now() >= pass.expiresAt) {
      this.dayPasses.delete(unicityId.toLowerCase());
      return null;
    }
    return pass;
  }

  getRemainingTime(unicityId: string): number {
    const pass = this.getPass(unicityId);
    if (!pass) return 0;
    return Math.max(0, pass.expiresAt - Date.now());
  }

  formatRemainingTime(unicityId: string): string {
    const ms = this.getRemainingTime(unicityId);
    if (ms === 0) return "No active pass";

    const hours = Math.floor(ms / (60 * 60 * 1000));
    const minutes = Math.floor((ms % (60 * 60 * 1000)) / (60 * 1000));

    if (hours > 0) {
      return `${hours}h ${minutes}m remaining`;
    }
    return `${minutes}m remaining`;
  }

  // Cleanup expired passes (optional, for memory management in long-running server)
  cleanup(): void {
    const now = Date.now();
    for (const [id, pass] of this.dayPasses) {
      if (now >= pass.expiresAt) {
        this.dayPasses.delete(id);
      }
    }
  }
}
