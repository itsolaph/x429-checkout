/** JSON.stringify that writes bigints as decimal strings. */
export function toJson(value: unknown, space?: number): string {
  return JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v), space);
}

/** Deep copy with bigints turned into decimal strings (for MCP structured content). */
export function plain<T>(value: T): unknown {
  return JSON.parse(toJson(value));
}
