/**
 * Whether a directory written in a spec starts from a root rather than from
 * the project, on any platform: `/x`, `\\x` (a Windows root or UNC path) or
 * a drive (`D:\\x`, `D:/x`, and `D:x`, relative to that drive).
 */
export const isRooted = (dir: string): boolean =>
	dir.startsWith("/") || dir.startsWith("\\") || /^[A-Za-z]:/.test(dir);
