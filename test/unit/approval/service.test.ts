import { beforeEach, describe, expect, it } from "vitest";
import { ApprovalCapacityError, ApprovalService } from "../../../src/approval/service.js";
import { summary } from "../../support/approval.js";

describe("ApprovalService", () => {
  let t: number;
  let svc: ApprovalService;
  beforeEach(() => {
    t = 0;
    let n = 0;
    svc = new ApprovalService({ ttlMs: 1000, now: () => t, newId: () => `id${++n}`, maxLivePerSubject: 2 });
  });

  it("reuses the live request for the same cart instead of spawning new ones", () => {
    const a = svc.request("u1", "c", "h1", summary);
    expect(svc.request("u1", "c", "h1", summary)).toBe(a);
    expect(svc.request("u1", "c", "h2", summary)).not.toBe(a);
  });
  it("only the customer it was issued to can decide", () => {
    const a = svc.request("u1", "c", "h1", summary);
    expect(svc.decide(a.id, "u2", true)).toBe("wrong_user");
    expect(a.status).toBe("pending");
    expect(svc.decide(a.id, "u1", true)).toBe("ok");
    expect(a.status).toBe("approved");
    expect(svc.decide(a.id, "u1", false)).toBe("gone"); // decided once
  });
  it("expires", () => {
    const a = svc.request("u1", "c", "h1", summary);
    t = 1001;
    expect(svc.get(a.id)).toBeUndefined();
    expect(svc.decide(a.id, "u1", true)).toBe("gone");
  });
  it("remembers a declined cart so the agent cannot re-ask in a loop", () => {
    const a = svc.request("u1", "c", "h1", summary);
    svc.decide(a.id, "u1", false);
    expect(svc.request("u1", "c", "h1", summary).status).toBe("denied");
  });
  it("bounds open requests per customer by dropping the oldest, so a spammer cannot block the real customer", () => {
    const first = svc.request("u1", "c", "h1", summary);
    svc.request("u1", "c", "h2", summary);
    const newest = svc.request("u1", "c", "h3", summary);
    expect(svc.get(first.id)).toBeUndefined();
    expect(svc.get(newest.id)).toBe(newest);
    expect(() => svc.request("u2", "c", "h3", summary)).not.toThrow();
  });
  it("refuses only when the whole service is full", () => {
    const tiny = new ApprovalService({ ttlMs: 1000, maxLive: 1 });
    tiny.request("a", "c", "h", summary);
    expect(() => tiny.request("b", "c", "h", summary)).toThrow(ApprovalCapacityError);
  });
  it("tracks the consumed approval for idempotent retries", () => {
    const a = svc.request("u1", "c", "h1", summary);
    svc.decide(a.id, "u1", true);
    svc.consume(a.id, "ord_1");
    expect(svc.recentlyConsumed("u1")?.orderId).toBe("ord_1");
    expect(svc.recentlyConsumed("u2")).toBeUndefined();
  });
});
