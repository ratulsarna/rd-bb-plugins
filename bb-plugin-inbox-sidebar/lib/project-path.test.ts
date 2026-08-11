import { describe, expect, it } from "vitest";
import {
  getProjectPathError,
  normalizeProjectPath,
  projectNameFromPath,
} from "./project-path";

describe("project paths", () => {
  it("normalizes a project folder and derives its name", () => {
    expect(normalizeProjectPath("  /home/ratul/Developer/bb/// ")).toBe(
      "/home/ratul/Developer/bb",
    );
    expect(projectNameFromPath("/home/ratul/Developer/bb///")).toBe("bb");
  });

  it.each(["", "repo", "/", "C:\\Developer\\repo", "\\\\server\\repo"])(
    "rejects a path bb cannot use: %j",
    (path) => {
      expect(getProjectPathError(path)).toBeTruthy();
      expect(projectNameFromPath(path)).toBe("");
    },
  );
});
