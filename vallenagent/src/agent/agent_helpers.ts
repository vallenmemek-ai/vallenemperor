export function safeCallback(callback?: (...args: any[]) => void, ...args: any[]): void {
  try { callback?.(...args) } catch {}
}
