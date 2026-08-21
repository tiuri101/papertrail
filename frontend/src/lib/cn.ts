export type ClassValue = string | number | null | undefined | false | Record<string, boolean | null | undefined> | ClassValue[]

function flatten(value: ClassValue, out: string[]): void {
  if (!value && value !== 0) return
  if (typeof value === 'string' || typeof value === 'number') {
    out.push(String(value))
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) flatten(item, out)
    return
  }
  for (const key in value) {
    if (value[key]) out.push(key)
  }
}

/** Joins conditional class names, skipping falsy values. */
export function cn(...values: ClassValue[]): string {
  const out: string[] = []
  for (const value of values) flatten(value, out)
  return out.join(' ')
}
