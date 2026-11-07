export function commandImage(
  name: string,
  label: string,
  mode: string,
  phase: string,
): string {
  const xml = (value: string, length: number) =>
    Array.from(value)
      .slice(0, length)
      .join("")
      .replace(
        /[&<>"']/gu,
        (character) =>
          ({
            "&": "&amp;",
            "<": "&lt;",
            ">": "&gt;",
            '"': "&quot;",
            "'": "&apos;",
          })[character] ?? character,
      );
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144"><rect width="144" height="144" rx="16" fill="${mode === "ai" ? "#4d397b" : "#28564f"}"/><g fill="#fff" font-family="sans-serif" text-anchor="middle"><text x="72" y="25" font-size="16">${xml(name, 12)}</text><text x="72" y="65" font-size="30" font-weight="bold">${mode === "ai" ? "AI" : "&gt;_"}</text><text x="72" y="98" font-size="18">${xml(label, 10)}</text><text x="72" y="126" font-size="15">${xml(phase, 12)}</text></g></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}
