declare module "sql-formatter" {
  export interface FormatOptions {
    language?: string;
    indent?: string;
    keywordCase?: "upper" | "lower" | "preserve";
    linesBetweenQueries?: number;
    tabWidth?: number;
    [key: string]: unknown;
  }
  export function format(sql: string, options?: FormatOptions): string;
}
