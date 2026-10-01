/** The PostgreSQL database every command targets, or undefined after reporting why not. */
export function requireDatabaseUrl(): string | undefined {
  const url = process.env['DATABASE_URL'];
  if (!url) console.error('error: DATABASE_URL must be set to the target PostgreSQL database.');
  return url;
}
