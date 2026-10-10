import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { Chat } from "./tree";

it("logs only the missing records when a crash cut an entry's split text short", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "optchat-source-"));
  const date = "2026-09-01T10:00:00+05:30";
  let chat = Chat.open(dir);
  chat.append("user", "before", date, { stream: "e", at: 3, n: 0 });
  const view = fs.readFileSync(path.join(dir, "view.json"));
  // 70,000 characters: three records of at most 30,000.
  const long = ["a", "b", "c"].map((ch) => ch.repeat(30_000)).join("").slice(0, 70_000);
  chat.append("unii", long, date, { stream: "e", at: 7, n: 0 });
  expect(chat.T).toBe(4);
  chat.close();

  // The crash: the third record and the view save never happened.
  const file = path.join(dir, "main", "2026-09-01.jsonl");
  fs.writeFileSync(file, fs.readFileSync(file, "utf8").split("\n").filter(Boolean).slice(0, 3).join("\n") + "\n");
  fs.writeFileSync(path.join(dir, "view.json"), view);

  chat = Chat.open(dir);
  expect(chat.T).toBe(3);
  expect(chat.resumeAt("e")).toBe(7);
  // The replay offers the whole entry again; only its third record is new.
  expect(chat.append("unii", long, date, { stream: "e", at: 7, n: 0 })).toEqual([3]);
  expect(chat.msgs.map((m) => m.src)).toEqual(["e:3#0", "e:7#0", "e:7#1", "e:7#2"]);
  expect(chat.msgs.slice(1).map((m) => m.text).join("")).toBe(long);
  // Older positions are never logged again; newer ones are.
  expect(chat.append("user", "before", date, { stream: "e", at: 3, n: 0 })).toEqual([]);
  expect(chat.append("user", "after", date, { stream: "e", at: 8, n: 0 })).toEqual([4]);
  expect(chat.viewLines().map((l) => l.split("|")[0])).toEqual(["0+1", "1+1", "2+1", "3+1", "4+1"]);
  chat.close();
});
