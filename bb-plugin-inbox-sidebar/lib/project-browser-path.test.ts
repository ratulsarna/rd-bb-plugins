import { describe, expect, it } from "vitest";
import {
  getFolderNameError,
  joinHostPath,
  toBreadcrumb,
} from "./project-browser-path";

describe("project browser paths", () => {
  it("builds navigable POSIX breadcrumbs", () => {
    expect(toBreadcrumb("/home/ratul/Developer")).toEqual([
      { label: "/", path: "/" },
      { label: "home", path: "/home" },
      { label: "ratul", path: "/home/ratul" },
      { label: "Developer", path: "/home/ratul/Developer" },
    ]);
  });

  it("joins paths without doubling separators", () => {
    expect(joinHostPath("/home/ratul/", "project")).toBe(
      "/home/ratul/project",
    );
    expect(joinHostPath("C:\\Users\\ratul\\", "project")).toBe(
      "C:\\Users\\ratul\\project",
    );
  });

  it("rejects names that can escape the selected folder", () => {
    expect(getFolderNameError("../project")).toBe(
      "Folder names can't contain slashes.",
    );
    expect(getFolderNameError(" .. ")).toBe("Enter a folder name.");
    expect(getFolderNameError("project")).toBeNull();
  });
});
