// Textareas normalize line endings; splice the edit into the original text to retain its bytes.
export function applyInstructionEdit(current: string, edited: string, caret = edited.length): string {
  if (!current.includes("\r")) return edited;
  const displayed = current.replace(/\r\n?/g, "\n");
  const prefixLimit = Math.max(0, caret - Math.max(0, edited.length - displayed.length));
  let start = 0;
  while (start < displayed.length && start < prefixLimit && displayed[start] === edited[start]) start += 1;
  let beforeEnd = displayed.length;
  let afterEnd = edited.length;
  while (beforeEnd > start && afterEnd > start && displayed[beforeEnd - 1] === edited[afterEnd - 1]) {
    beforeEnd -= 1; afterEnd -= 1;
  }
  function offset(position: number) {
    let raw = 0;
    for (let index = 0; index < position; index += 1) raw += current[raw] === "\r" && current[raw + 1] === "\n" ? 2 : 1;
    return raw;
  }
  const ending = current.match(/\r\n?|\n/)?.[0] ?? "\n";
  return current.slice(0, offset(start)) + edited.slice(start, afterEnd).replace(/\n/g, ending) + current.slice(offset(beforeEnd));
}
