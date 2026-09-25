import { describe, expect, it } from "vitest";
import { isProtectedPath, isAuthRoute } from "@/lib/supabase/proxy";

describe("isProtectedPath", () => {
  it("matches an exact protected route", () => {
    expect(isProtectedPath("/overview")).toBe(true);
    expect(isProtectedPath("/settings")).toBe(true);
  });

  it("matches nested protected routes", () => {
    expect(isProtectedPath("/requests/abc-123")).toBe(true);
    expect(isProtectedPath("/settings/members")).toBe(true);
  });

  it("does not match public routes", () => {
    expect(isProtectedPath("/login")).toBe(false);
    expect(isProtectedPath("/register")).toBe(false);
    expect(isProtectedPath("/")).toBe(false);
  });

  it("does not match a route that merely starts with the same prefix text", () => {
    // "/settingsx" is not "/settings" or "/settings/..." — a naive
    // startsWith("/settings") check would wrongly match this.
    expect(isProtectedPath("/settingsx")).toBe(false);
  });
});

describe("isAuthRoute", () => {
  it("matches the four auth routes", () => {
    expect(isAuthRoute("/login")).toBe(true);
    expect(isAuthRoute("/register")).toBe(true);
    expect(isAuthRoute("/forgot-password")).toBe(true);
    expect(isAuthRoute("/reset-password")).toBe(true);
  });

  it("does not match protected or unrelated routes", () => {
    expect(isAuthRoute("/overview")).toBe(false);
    expect(isAuthRoute("/login/extra")).toBe(false);
  });
});
