// The chat log, its summary tree and the view, as Taelin's optchat.md describes them.
// No model calls here: the host takes jobs, runs the compactions and hands back lines.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** A summary line's hard limit in bytes: the retry trigger, and the most a target may ask for. */
export const LINE = 512;
/** Summaries in flight at once. The gist uses 8 for a cloud API. */
export const DEFAULT_POOL = 8;
const VIEW_HI = 128_000;
const VIEW_LO = 64_000;
const CVIEW_HI = 32_000;
const CVIEW_LO = 16_000;
/** Longest text of one stored message, in characters. */
export const CLIP = 30_000;
const PENDING = "(not summarized yet: zoom it)";

export const KINDS = ["user", "unii", "tool", "echo", "work", "note"] as const;
export type Kind = (typeof KINDS)[number];
/** `src` is where the record came from, `<stream>:<position>#<n>`: the n-th record made at that position. */
export type Msg = { i: number; kind: Kind; text: string; size: number; date: string; src?: string };
/** A position in a source stream, such as an entry of a conversation or a line of a file; `n` counts its records. */
export type Source = { stream: string; at: number; n: number };
export type Node = { l: number; i: number; text: string; size: number };
/** node(l, i): the 2^l messages from i·2^l on. */
export type Ref = [l: number, i: number];
type View = { refs: Ref[]; shrinking: boolean };

export const bytes = (s: string) => Buffer.byteLength(s);
const start = ([l, i]: Ref) => i * 2 ** l;
const end = ([l, i]: Ref) => (i + 1) * 2 ** l;
export const label = (r: Ref) => `${start(r)}+${2 ** r[0]}`;
const key = ([l, i]: Ref) => `${l}:${i}`;

/**
 * Index of the most due sibling pair whose parent is built, the oldest on ties, or -1.
 * due = (T - last) / 2^l, written as (T + 1) / 2^l - i: the same order, shifted by 2.
 */
export function pickMerge(view: Ref[], T: number, built: (r: Ref) => boolean): number {
  let best = -1;
  let bestDue = -Infinity;
  for (let k = 0; k + 1 < view.length; k++) {
    const [l, i] = view[k];
    const [l2, i2] = view[k + 1];
    if (l !== l2 || i % 2 !== 0 || i2 !== i + 1 || !built([l + 1, i / 2])) continue;
    const due = (T + 1) / 2 ** l - i;
    if (due > bestDue) [best, bestDue] = [k, due];
  }
  return best;
}

export function mergeAt(view: Ref[], k: number): void {
  const [l, i] = view[k];
  view.splice(k, 2, [l + 1, i / 2]);
}

/** The first `max` bytes of `s`, never splitting a character. */
function head(s: string, max: number): string {
  let out = "";
  let used = 0;
  for (const ch of s) {
    used += bytes(ch);
    if (used > max) break;
    out += ch;
  }
  return out;
}

export function tooLong(reply: string): string {
  return `Too long: your line is ${bytes(reply)} bytes, over the 512-byte limit. Write
the whole line again for the same <input>, cutting just enough of the
least valuable items to fit before this cut:
${head(reply, LINE)}| ← LIMIT`;
}

/** The reply as a node line: trimmed, without an id+n| head the model may add anyway. */
export const cleanLine = (reply: string) => reply.trim().replace(/^\d+\+\d+\|\s*/, "");

/** Tool output keeps its head and tail; other long text becomes several messages in a row. */
function pieces(kind: Kind, text: string): string[] {
  const chars = [...text];
  if (chars.length <= CLIP) return [text];
  if (kind === "echo") {
    const half = CLIP / 2;
    return [`${chars.slice(0, half).join("")}\n[... ${chars.length - CLIP} characters clipped ...]\n${chars.slice(-half).join("")}`];
  }
  const out: string[] = [];
  for (let k = 0; k < chars.length; k += CLIP) out.push(chars.slice(k, k + CLIP).join(""));
  return out;
}

const today = () => new Date().toISOString().slice(0, 10);

/**
 * This boot: a pid from an earlier boot names no live process. The kernel's boot id, or off Linux the boot
 * time to the minute.
 */
const BOOT = (() => {
  try {
    return fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  } catch {
    return String(Math.round((Date.now() / 1000 - os.uptime()) / 60));
  }
})();

/** Chats open in this process, which shares one pid. */
const OPEN = new Set<string>();

function readLines<T>(dir: string): T[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .sort()
    .flatMap((f) => {
      const file = path.join(dir, f);
      let text = fs.readFileSync(file, "utf8");
      // A write a crash cut short leaves an unterminated tail: cut it, so the next append starts a clean
      // line. A corrupt record that did end its line still throws.
      const whole = text.lastIndexOf("\n") + 1;
      if (whole < text.length) {
        text = text.slice(0, whole);
        fs.truncateSync(file, Buffer.byteLength(text));
      }
      return text.split("\n").filter(Boolean).map((x) => JSON.parse(x) as T);
    });
}

export type Job = { ref: Ref; prompt: string };

export class Chat {
  readonly dir: string;
  readonly msgs: Msg[] = [];
  private nodes = new Map<string, Node>();
  private view: View = { refs: [], shrinking: false };
  private cview: View = { refs: [], shrinking: false };
  /** Long messages not built yet, oldest first: only the first `pool` may start. */
  private unbuilt: number[] = [];
  /** Merges whose halves are built. */
  private merges: Ref[] = [];
  /** Queued or running, so nothing is started twice. */
  private claimed = new Set<string>();
  private running = new Set<string>();
  /** Failed calls wait here until the next message. */
  private failed: Ref[] = [];
  /** Per source stream, its newest position in the log and how many records came from it. */
  private sources = new Map<string, { at: number; records: number }>();
  /** A log or tree write failed: memory may be ahead of the disk until `reload`. */
  damaged = false;
  /** Summaries in flight at once. A lower one starts nothing until fewer run; running ones go on. */
  pool = DEFAULT_POOL;
  /** The line length a new task asks for; `LINE` stays the limit that sends a line back. */
  target = LINE;

  private constructor(dir: string) {
    this.dir = dir;
  }

  static open(dir: string): Chat {
    fs.mkdirSync(dir, { recursive: true });
    const chat = new Chat(path.resolve(dir));
    chat.lock();
    try {
      chat.load();
    } catch (error) {
      chat.close();
      throw error;
    }
    return chat;
  }

  private load(): void {
    for (const m of readLines<Msg>(path.join(this.dir, "main")).sort((a, b) => a.i - b.i)) {
      if (m.i !== this.msgs.length) throw new Error(`log gap at message ${this.msgs.length}`);
      this.msgs.push(m);
      if (m.src) this.track(m.src);
    }
    for (const n of readLines<Node>(path.join(this.dir, "tree"))) this.nodes.set(key([n.l, n.i]), n);
    const saved = path.join(this.dir, "view.json");
    if (fs.existsSync(saved)) Object.assign(this, JSON.parse(fs.readFileSync(saved, "utf8")));
    // A crash between a log write and the view save leaves lines to append, never to rebuild.
    for (let i = end(this.view.refs.at(-1) ?? [0, -1]); i < this.msgs.length; i++) {
      this.view.refs.push([0, i]);
      this.cview.refs.push([0, i]);
    }
    // One pass at open to find the work a restart left; after that only queues.
    for (const m of this.msgs) if (!this.built([0, m.i])) this.place(m);
    for (const n of [...this.nodes.values()].sort((a, b) => a.l - b.l)) this.climb([n.l, n.i]);
  }

  /**
   * Read the chat back from the disk as an open does, which repairs what a failed write left out.
   * Compactions still running stay claimed, so none starts twice.
   */
  reload(): void {
    const fresh = new Chat(this.dir);
    fresh.load();
    const running = [...this.running];
    Object.assign(this, fresh, { pool: this.pool, target: this.target });
    for (const k of running) this.resumed(k.split(":").map(Number) as Ref);
  }

  /** Apply the plugin's settings; each is a positive integer, and a target over `LINE` asks for `LINE`. */
  tune({ pool, target }: { pool?: number; target?: number }): void {
    for (const [name, v] of Object.entries({ pool, target })) {
      if (v !== undefined && !(Number.isInteger(v) && v > 0)) throw new Error(`${name} must be a positive whole number, not ${v}`);
    }
    if (pool !== undefined) this.pool = pool;
    if (target !== undefined) this.target = Math.min(target, LINE);
  }

  private lock(): void {
    if (OPEN.has(this.dir)) throw new Error(`chat ${this.dir} is already open`);
    const file = path.join(this.dir, "lock");
    const mine = `${process.pid} ${BOOT}`;
    try {
      fs.writeFileSync(file, mine, { flag: "wx" });
    } catch {
      const [owner, boot = ""] = fs.readFileSync(file, "utf8").split(" ");
      const pid = Number(owner);
      let alive = boot === BOOT;
      try {
        if (alive) process.kill(pid, 0);
      } catch {
        alive = false;
      }
      // This pid, but not in OPEN: a lock an earlier process with the same pid left.
      if (alive && pid !== process.pid) throw new Error(`chat ${this.dir} is owned by process ${pid}`);
      fs.writeFileSync(file, mine);
    }
    OPEN.add(this.dir);
  }

  close(): void {
    fs.rmSync(path.join(this.dir, "lock"), { force: true });
    OPEN.delete(this.dir);
  }

  /** After a failed write nothing is appended, so a torn line stays the last one, until `reload`. */
  private appendLine(file: string, value: unknown): void {
    if (this.damaged) throw new Error(`chat ${this.dir}: a write failed; it is read back before the next turn`);
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.appendFileSync(file, JSON.stringify(value) + "\n", { flush: true });
    } catch (error) {
      this.damaged = true;
      throw error;
    }
  }

  get T(): number {
    return this.msgs.length;
  }

  built(r: Ref): boolean {
    return this.nodes.has(key(r));
  }

  /**
   * Append a message (or several, for long text). Returns the new ids. With `src`, a replay of a position
   * a crash cut off skips the records the log already holds from it.
   */
  append(kind: Kind, text: string, date: string, src?: Source): number[] {
    if (!KINDS.includes(kind)) throw new Error(`unknown kind ${kind}`);
    const ids: number[] = [];
    for (const part of pieces(kind, text)) {
      const n = src ? src.n++ : 0;
      if (src && n < this.logged(src)) continue;
      const m: Msg = { i: this.T, kind, text: part, size: bytes(part), date };
      if (src) m.src = `${src.stream}:${src.at}#${n}`;
      this.appendLine(path.join(this.dir, "main", `${/^\d{4}-\d\d-\d\d/.test(date) ? date.slice(0, 10) : today()}.jsonl`), m);
      if (m.src) this.track(m.src);
      this.msgs.push(m);
      ids.push(m.i);
      this.view.refs.push([0, m.i]);
      this.cview.refs.push([0, m.i]);
      this.place(m);
    }
    // A replay that logged nothing is no new message: failed calls wait for a real one.
    if (ids.length === 0) return ids;
    this.retryFailed();
    this.saw();
    return ids;
  }

  /** The newest position of `stream` in the log: a replay starts there. */
  resumeAt(stream: string): number | undefined {
    return this.sources.get(stream)?.at;
  }

  private logged({ stream, at }: Source): number {
    const p = this.sources.get(stream);
    return !p || p.at < at ? 0 : p.at === at ? p.records : Infinity;
  }

  private track(src: string): void {
    const [, stream, at] = /^(.*):(\d+)#\d+$/.exec(src)!;
    const p = this.sources.get(stream);
    if (p?.at === Number(at)) p.records++;
    else this.sources.set(stream, { at: Number(at), records: 1 });
  }

  /** A message that fits is its own node, word for word; a longer one waits for a compaction. */
  private place(m: Msg): void {
    const own = `${m.kind}: ${m.text}`;
    if (bytes(own) <= LINE) this.addNode([0, m.i], own);
    else this.unbuilt.push(m.i);
  }

  /**
   * Each new message may trigger one batch: 128 KB down to 64 KB, the compaction view 32 KB down to 16 KB.
   * Also run before a turn renders the view: summaries that landed since the last message make it grow.
   */
  saw(): void {
    if (this.view.shrinking || this.size(this.view.refs) > VIEW_HI) {
      const before = this.view.refs.length;
      this.view.shrinking = !this.shrink(this.view.refs, VIEW_LO);
      if (this.view.refs.length < before) this.cview = { refs: [...this.view.refs], shrinking: true };
    }
    if (this.cview.shrinking || this.size(this.cview.refs) > CVIEW_HI) {
      this.cview.shrinking = !this.shrink(this.cview.refs, CVIEW_LO);
    }
    const tmp = path.join(this.dir, "view.json.tmp");
    fs.writeFileSync(tmp, JSON.stringify({ view: this.view, cview: this.cview }), { flush: true });
    fs.renameSync(tmp, path.join(this.dir, "view.json"));
  }

  /** Merge the most due pairs until `refs` fits `target`; false when built parents run out first. */
  private shrink(refs: Ref[], target: number): boolean {
    let size = this.size(refs);
    while (size > target) {
      const k = pickMerge(refs, this.T, (r) => this.built(r));
      if (k < 0) return false;
      size -= this.lineBytes(refs[k]) + this.lineBytes(refs[k + 1]);
      mergeAt(refs, k);
      size += this.lineBytes(refs[k]);
    }
    return true;
  }

  line(r: Ref): string {
    const n = this.nodes.get(key(r));
    return `${label(r)}|${n ? n.text.replace(/\n/g, " ") : PENDING}`;
  }

  private lineBytes(r: Ref): number {
    return bytes(this.line(r)) + 1;
  }

  private size(refs: Ref[]): number {
    return refs.reduce((sum, r) => sum + this.lineBytes(r), 0);
  }

  viewLines(): string[] {
    return this.view.refs.map((r) => this.line(r));
  }

  viewBytes(): { view: number; cview: number; lines: number; shrinking: boolean } {
    const { refs, shrinking } = this.view;
    return { view: this.size(refs), cview: this.size(this.cview.refs), lines: refs.length, shrinking };
  }

  /** Every message summarized and nothing queued, running or failed. */
  idle(): boolean {
    return this.unbuilt.length === 0 && this.merges.length === 0 && this.running.size === 0 && this.failed.length === 0;
  }

  /** Nodes waiting for a call, running ones included, for backpressure while importing. */
  backlog(): number {
    return this.unbuilt.length + this.merges.length;
  }

  /** Long messages not summarized yet. */
  get unsummarized(): number {
    return this.unbuilt.length;
  }

  get inFlight(): number {
    return this.running.size;
  }

  get failures(): number {
    return this.failed.length;
  }

  /** Failed calls are tried again at the next message. */
  retryFailed(): void {
    for (const r of this.failed.splice(0)) {
      this.claimed.delete(key(r));
      if (r[0] > 0) this.queueMerge(r);
    }
  }

  private addNode(r: Ref, text: string): void {
    const n: Node = { l: r[0], i: r[1], text, size: bytes(text) };
    this.appendLine(path.join(this.dir, "tree", `${today()}.jsonl`), n);
    this.nodes.set(key(r), n);
    if (r[0] === 0) {
      const k = this.unbuilt.indexOf(r[1]);
      if (k >= 0) this.unbuilt.splice(k, 1);
    }
    this.climb(r);
  }

  /** Once both halves exist, build the parent: joined when it fits, else as a merge call. */
  private climb([l, i]: Ref): void {
    const a: Ref = [l, i - (i % 2)];
    const b: Ref = [l, a[1] + 1];
    const parent: Ref = [l + 1, a[1] / 2];
    if (!this.built(a) || !this.built(b) || this.built(parent)) return;
    const joined = `${this.nodes.get(key(a))!.text}\n${this.nodes.get(key(b))!.text}`;
    if (bytes(joined) <= LINE) this.addNode(parent, joined);
    else this.queueMerge(parent);
  }

  private queueMerge(r: Ref): void {
    if (this.claimed.has(key(r))) return;
    this.claimed.add(key(r));
    this.merges.push(r);
  }

  /** The node `take` starts next, slots aside: messages in their window first, then merges. */
  private next(): Ref | undefined {
    const i = this.unbuilt.slice(0, this.pool).find((i) => !this.claimed.has(key([0, i])));
    return i !== undefined ? [0, i] : this.merges[0];
  }

  /** Work `take` could start once a slot is free; a failed claim is not such work until `retryFailed`. */
  canTake(): boolean {
    return this.next() !== undefined;
  }

  /** Next node to build, if a slot is free. */
  take(): Job | undefined {
    if (this.running.size >= this.pool) return;
    const r = this.next();
    if (!r) return;
    // Merges are always above level 0, so this one came off the merge queue.
    if (r[0] > 0) this.merges.shift();
    this.claimed.add(key(r));
    this.running.add(key(r));
    return { ref: r, prompt: this.compactionPrompt(r) };
  }

  /** Mark a node as running, for a compaction a restart found still in flight. */
  resumed(r: Ref): void {
    const k = this.merges.findIndex((m) => key(m) === key(r));
    if (k >= 0) this.merges.splice(k, 1);
    this.claimed.add(key(r));
    this.running.add(key(r));
  }

  /** A node whose write throws stays claimed, so only `fail` and the retry at the next message free it. */
  done(r: Ref, text: string): void {
    if (!this.built(r)) this.addNode(r, text);
    this.running.delete(key(r));
    this.claimed.delete(key(r));
  }

  fail(r: Ref): void {
    this.running.delete(key(r));
    this.failed.push(r);
  }

  /** [compaction view] [task]: the view ends at the node and stops at the first unbuilt line. */
  compactionPrompt(r: Ref): string {
    const [s, e] = [start(r), end(r)];
    const limit = r[0] === 0 ? s : e;
    const lines: string[] = [];
    for (const v of this.cview.refs) {
      if (end(v) > limit || !this.built(v)) break;
      lines.push(this.line(v));
    }
    // The word hint scales as 512 bytes read "about 70 words", to the nearest 10.
    const words = Math.round((this.target * 70) / LINE / 10) * 10;
    const ruler = "-".repeat(this.target);
    let task: string;
    if (r[0] === 0) {
      const m = this.msgs[s];
      task = `Compaction: compress message ${s} into one line of at most ${this.target} bytes
(about ${words} words), the length of this ruler:
${ruler}
<input>
${m.kind}: ${m.text}
</input>`;
    } else {
      const a: Ref = [r[0] - 1, r[1] * 2];
      const b: Ref = [r[0] - 1, r[1] * 2 + 1];
      task = `Compaction: merge lines ${label(a)} and ${label(b)}, adjacent, into one line of at most
${this.target} bytes (about ${words} words), the length of this ruler:
${ruler}
<chat> may hold their messages, ${s} to ${e - 1}, in more detail: take details
of them from there too.
<input>
${this.line(a)}
${this.line(b)}
</input>`;
    }
    return `<chat>\n${lines.map((x) => x + "\n").join("")}</chat>\n${task}`;
  }

  /** Open line id+n into the two lines under it; n = 1 gives the message whole. */
  zoom(id: number, n: number): string {
    if (!Number.isInteger(id) || !Number.isInteger(n) || n < 1 || (n & (n - 1)) !== 0 || id % n !== 0 || id < 0 || id + n > this.T) {
      throw new Error(`no line ${id}+${n}: n must be a power of 2 and id a multiple of n, within the ${this.T} messages`);
    }
    if (n === 1) return `${this.msgs[id].kind}: ${this.msgs[id].text}`;
    const l = Math.log2(n) - 1;
    const j = (id / n) * 2;
    return `${this.line([l, j])}\n${this.line([l, j + 1])}`;
  }

  date(id: number): string {
    const m = this.msgs[id];
    if (!m) throw new Error(`no message ${id}: the chat has ${this.T}`);
    return m.date;
  }
}
