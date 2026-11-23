/**
 * 轻量 Valve Data Format (VDF / ACF) 解析器（零依赖），用于读取 Steam 本地 libraryfolders.vdf、appmanifest_*.acf、loginusers.vdf。
 */

export type VdfObject = { [key: string]: string | VdfObject };

export function parseVdf(text: string): VdfObject {
  const tokens: string[] = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === " " || ch === "\t" || ch === "\r" || ch === "\n") {
      i++;
      continue;
    }
    if (ch === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      continue;
    }
    if (ch === "{" || ch === "}") {
      tokens.push(ch);
      i++;
      continue;
    }
    if (ch === '"') {
      i++;
      let s = "";
      while (i < text.length && text[i] !== '"') {
        if (text[i] === "\\" && i + 1 < text.length) {
          i++;
          s += text[i] === "n" ? "\n" : text[i] === "t" ? "\t" : text[i];
        } else {
          s += text[i];
        }
        i++;
      }
      i++;
      tokens.push(s);
      continue;
    }
    let s = "";
    while (i < text.length && !/[\s{}"]/.test(text[i])) {
      s += text[i++];
    }
    if (s) tokens.push(s);
  }

  let pos = 0;
  function parseBlock(): VdfObject {
    const obj: VdfObject = {};
    while (pos < tokens.length) {
      const tok = tokens[pos++];
      if (tok === "}") break;
      const next = tokens[pos];
      if (next === "{") {
        pos++;
        obj[tok] = parseBlock();
      } else if (next !== undefined && next !== "}") {
        pos++;
        obj[tok] = next;
      }
    }
    return obj;
  }

  return parseBlock();
}
