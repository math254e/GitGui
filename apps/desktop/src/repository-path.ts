/** Convert Windows canonical paths to the form expected by desktop apps. */
export function desktopRepositoryPath(value: string, platform: NodeJS.Platform): string {
  if (platform !== "win32") return value;
  return value.replace(/^\\\\\?\\UNC\\/i, "\\\\").replace(/^\\\\\?\\(?=[A-Za-z]:\\)/, "");
}
