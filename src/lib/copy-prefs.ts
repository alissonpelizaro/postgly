/** Client-side export/clipboard preferences. Kept in localStorage (like
 *  the language and theme) since they only shape how data leaves the app
 *  and don't otherwise belong to the backend settings document. */

const COLUMN_SEPARATOR_KEY = "postgly-copy-column-separator";
const EXPORT_DELIMITER_KEY = "postgly-export-delimiter";

/** Default delimiter used when copying a whole row to the clipboard. */
export const DEFAULT_COLUMN_SEPARATOR = ";";

/** Default delimiter used when exporting a table to CSV (Postgres' own
 *  COPY default). */
export const DEFAULT_EXPORT_DELIMITER = ",";

function read(key: string, fallback: string): string {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Storage unavailable (private mode, quota) — ignore; the default applies.
  }
}

/** The delimiter to place between column values when copying a row. */
export function getColumnSeparator(): string {
  return read(COLUMN_SEPARATOR_KEY, DEFAULT_COLUMN_SEPARATOR);
}

/** Persist the row-copy delimiter. */
export function setColumnSeparator(value: string): void {
  write(COLUMN_SEPARATOR_KEY, value);
}

/** The single-character delimiter used for CSV export. */
export function getExportDelimiter(): string {
  return read(EXPORT_DELIMITER_KEY, DEFAULT_EXPORT_DELIMITER);
}

/** Persist the CSV export delimiter. */
export function setExportDelimiter(value: string): void {
  write(EXPORT_DELIMITER_KEY, value);
}
