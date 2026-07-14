import { describe, expect, it, vi } from "vitest";
import { validateSystemRequest, type SystemRequest } from "./system-protocol.js";
import { executeSystemRequest } from "./system-helper.js";
import { SystemRequestService } from "./system-service.js";

describe("system request validation", () => {
  it.each(["curl", "libssl3", "nodejs-doc", "g++", "fonts.noto-core"])("accepts package %s", (name) => {
    expect(validateSystemRequest({ action: "apt-install", packages: [name] }).ok).toBe(true);
  });

  it.each(["-oApt::x=y", "foo bar", "../../etc", "pkg;id", "pkg:amd64", "pkg=1", "Apt"])("rejects package %s", (name) => {
    expect(validateSystemRequest({ action: "apt-install", packages: [name] }).ok).toBe(false);
  });

  it("rejects empty, duplicate, and oversized package lists", () => {
    expect(validateSystemRequest({ action: "apt-install", packages: [] }).ok).toBe(false);
    expect(validateSystemRequest({ action: "apt-install", packages: ["curl", "curl"] }).ok).toBe(false);
    expect(validateSystemRequest({ action: "apt-install", packages: Array.from({ length: 33 }, (_, i) => `pkg${String(i)}`) }).ok).toBe(false);
  });

  it("validates bounded journal arguments", () => {
    expect(validateSystemRequest({ action: "journal-read", lines: 200, since: "2026-07-13T10:20:30Z" }).ok).toBe(true);
    for (const value of [0, 501, 1.5, "20"]) expect(validateSystemRequest({ action: "journal-read", lines: value }).ok).toBe(false);
    for (const since of ["yesterday", "-1 hour", "2026-07-13;id", "2026-07-13T10:20:30+01:00"]) expect(validateSystemRequest({ action: "journal-read", lines: 20, since }).ok).toBe(false);
  });

  it("rejects unknown fields and actions", () => {
    expect(validateSystemRequest({ action: "service-status", service: "ssh" }).ok).toBe(false);
    expect(validateSystemRequest({ action: "run", command: "id" }).ok).toBe(false);
  });
});

describe("root helper", () => {
  it("uses fixed executables and argument arrays", async () => {
    const run = vi.fn().mockResolvedValue({ exitCode: 0, stdout: "ok", stderr: "" });
    const audit = vi.fn().mockResolvedValue(undefined);
    await executeSystemRequest({ action: "apt-install", packages: ["curl"] }, { run, audit, now: () => new Date("2026-01-01T00:00:00Z") });
    expect(run).toHaveBeenCalledWith("/usr/bin/apt-get", ["install", "--yes", "--no-install-recommends", "--", "curl"], expect.objectContaining({ timeoutMs: 300_000 }));
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: "apt-install", arguments: { packages: ["curl"] }, outcome: "started" }));
    expect(audit).toHaveBeenLastCalledWith(expect.objectContaining({ outcome: "succeeded", exitCode: 0 }));
  });

  it("does not execute denied input and audits sanitized metadata", async () => {
    const run = vi.fn();
    const audit = vi.fn().mockResolvedValue(undefined);
    await expect(executeSystemRequest({ action: "apt-install", packages: ["x;id"] } as SystemRequest, { run, audit })).rejects.toThrow("Invalid system helper request");
    expect(run).not.toHaveBeenCalled();
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: "invalid", arguments: {}, outcome: "denied" }));
  });
});

describe("daemon system request service", () => {
  const read = { action: "service-status" } as const;
  const mutate = { action: "service-restart" } as const;
  it("keeps reads owner-only without confirmation", async () => {
    const invoke = vi.fn().mockResolvedValue({ ok: true, output: "active" });
    const confirm = vi.fn();
    const service = new SystemRequestService({ ownerUserIds: ["owner"], invoke, confirm });
    await expect(service.execute(read, { requesterId: "other", channelId: "c" })).rejects.toThrow("owner-only");
    await expect(service.execute(read, { requesterId: "owner", channelId: "c" })).resolves.toEqual({ ok: true, output: "active" });
    expect(confirm).not.toHaveBeenCalled();
  });

  it("requires confirmation for mutations and honors denial", async () => {
    const invoke = vi.fn().mockResolvedValue({ ok: true, output: "" });
    const confirm = vi.fn().mockResolvedValue(false);
    const service = new SystemRequestService({ ownerUserIds: ["owner"], invoke, confirm });
    await expect(service.execute(mutate, { requesterId: "owner", channelId: "c" })).rejects.toThrow("denied or expired");
    expect(invoke).not.toHaveBeenCalled();
  });

  it("allows an owner mutation after a privileged approver confirms", async () => {
    const invoke = vi.fn().mockResolvedValue({ ok: true, output: "" });
    const confirm = vi.fn().mockResolvedValue(true);
    const service = new SystemRequestService({ ownerUserIds: ["owner"], invoke, confirm });
    await service.execute({ action: "apt-update" }, { requesterId: "owner", channelId: "c" });
    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ requesterId: "owner", summary: "Run apt update" }));
    expect(invoke).toHaveBeenCalledWith({ action: "apt-update" }, expect.objectContaining({ requesterId: "owner" }));
  });
});
