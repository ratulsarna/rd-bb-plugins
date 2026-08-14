const HTML_TAG = /<\/?(?:a|abbr|address|article|aside|b|blockquote|body|br|button|caption|cite|code|col|colgroup|dd|del|details|dfn|dialog|div|dl|dt|em|fieldset|figcaption|figure|footer|form|h[1-6]|head|header|hr|html|i|img|input|ins|kbd|label|legend|li|link|main|mark|menu|meta|meter|nav|ol|optgroup|option|p|picture|pre|progress|q|rp|rt|ruby|s|samp|script|search|section|select|slot|small|source|span|strong|style|sub|summary|sup|table|tbody|td|template|textarea|tfoot|th|thead|time|title|tr|track|u|ul|var|video|wbr)\b(?:\s[^<>]*?)?\s*\/?>/gi;

export function mdToSpeakable(markdown: string): string {
  return markdown
    .replace(/(^|\n)[ \t]*(?:```|~~~)[^\n]*\n[\s\S]*?\n[ \t]*(?:```|~~~)[ \t]*(?=\n|$)/g, "$1code omitted")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/<https?:\/\/[^>]+>/g, "")
    .replace(/`([^`]+)`/g, "$1")
    .replace(HTML_TAG, "")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s*>\s?/gm, "")
    .replace(/^\s*(?:[-+*]|\d+[.)])\s+/gm, "")
    .replace(/[*_~]+/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

export function truncateSpeakable(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;

  const prefix = text.slice(0, maxLength);
  const sentenceEnd = Math.max(
    prefix.lastIndexOf(". "),
    prefix.lastIndexOf("! "),
    prefix.lastIndexOf("? "),
    prefix.lastIndexOf(".\n"),
    prefix.lastIndexOf("!\n"),
    prefix.lastIndexOf("?\n"),
  );
  if (sentenceEnd >= Math.floor(maxLength * 0.75)) {
    return prefix.slice(0, sentenceEnd + 1).trimEnd();
  }

  const wordEnd = Math.max(prefix.lastIndexOf(" "), prefix.lastIndexOf("\n"));
  return wordEnd > 0 ? prefix.slice(0, wordEnd).trimEnd() : prefix;
}
