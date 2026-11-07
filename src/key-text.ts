/** Key/dial labels only. Never use this to change a path, ID or input body. */
export function displayText(value: string): string {
  return Array.from(value)
    .filter((c) => {
      const code = c.codePointAt(0) ?? 0;
      return (
        /[ \t\r\n\f]/u.test(c) || (code >= 32 && !(code >= 127 && code <= 159))
      );
    })
    .join("")
    .replace(/[ \t\r\n\f]+/gu, " ")
    .replace(/^ +| +$/gu, "")
    .normalize("NFC");
}

export function xml(value: string): string {
  return displayText(value).replace(
    /[&<>"']/gu,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&apos;",
      })[c] ?? c,
  );
}
const segmenter = new Intl.Segmenter("ja", { granularity: "grapheme" });
const graphemes = (s: string) =>
  Array.from(segmenter.segment(s), (x) => x.segment);
const units = (s: string) =>
  graphemes(s).reduce(
    (n, c) =>
      n +
      (/^[A-Z]$/u.test(c) && !/^[MW]$/u.test(c)
        ? 1.6
        : /^[\x20-\x7e]$/u.test(c) && !/^[MWmw@]$/u.test(c)
          ? 1.2
          : 2),
    0,
  );
/** Conservative width budget; final layout is also checked with the rendered font. */
export function shorten(value: string, budget: number): string {
  value = displayText(value);
  if (units(value) <= budget) return value;
  const parts = graphemes(value);
  let left = "",
    right = "",
    used = 2;
  while (parts.length) {
    const front = units(left) <= units(right);
    const part = front ? parts.shift() : parts.pop();
    if (part === undefined || used + units(part) > budget) break;
    used += units(part);
    if (front) left += part;
    else right = part + right;
  }
  return `${left}…${right}`;
}
export function twoLines(value: string, lineBudget = 14): [string, string] {
  const name = shorten(value, lineBudget * 2 - 2);
  let first = "",
    second = "";
  for (const part of graphemes(name)) {
    if (!second && units(first + part) <= lineBudget) first += part;
    else second += part;
  }
  return [displayText(first), displayText(second)];
}
export function svgText(
  value: string,
  y: number,
  size: number,
  x = 72,
): string {
  return `<text x="${x}" y="${y}" font-size="${size}">${xml(value)}</text>`;
}
