export interface Heading {
  id: string;
  text: string;
  level: number;
  chunk: number;
}
export interface Info {
  id: number;
  path: string;
  name: string;
  bytes: number;
  headings: Heading[];
  chunks: number;
  readMs: number;
  parseMs: number;
}
export interface OpenResult {
  info: Info;
  first: string;
}
export const native = "__TAURI_INTERNALS__" in window;
export async function command<T>(
  name: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  if (native)
    return (await import("@tauri-apps/api/core")).invoke<T>(name, args);
  if (!import.meta.env.DEV)
    throw new Error("Open Paneless as a desktop application.");
  const response = await fetch(`/api/${name}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(args),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error);
  return data;
}

export const LARGE_DOCUMENT_BYTES = 2 * 1024 * 1024;
export function navigateToHeading(id: string) {
  window.dispatchEvent(new CustomEvent("paneless:anchor", { detail: id }));
}
