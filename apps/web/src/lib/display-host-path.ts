/** Make Windows extended-length paths readable without changing the host path. */
export function displayHostPath(path: string): string {
  if (/^\\\\\?\\UNC\\/i.test(path)) return "\\\\" + path.slice(8);
  if (/^\\\\\?\\[a-z]:\\/i.test(path)) return path.slice(4);
  return path;
}
