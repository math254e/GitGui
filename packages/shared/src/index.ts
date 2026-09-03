export function exhaustive(value: never): never {
  throw new Error(`Unhandled value: ${String(value)}`);
}
