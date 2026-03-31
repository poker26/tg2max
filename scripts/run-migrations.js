import "dotenv/config";
import pg from "pg";
import { readdir, readFile } from "fs/promises";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(__dirname, "../src/db/migrations");

function getConnectionConfig() {
  if (process.env.SUPABASE_DATABASE_URL) {
    return { connectionString: process.env.SUPABASE_DATABASE_URL };
  }

  const user = process.env.DB_USER || "postgres";
  const password = process.env.DB_PASSWORD || process.env.POSTGRES_PASSWORD;
  const host = process.env.DB_HOST || "localhost";
  const port = parseInt(process.env.DB_PORT || "5432", 10);
  const database = process.env.DB_NAME || "postgres";

  if (!password) {
    throw new Error(
      "Set SUPABASE_DATABASE_URL or DB_* (DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME)."
    );
  }

  return { user, password, host, port, database, ssl: false };
}

async function runMigrations() {
  const client = new pg.Client(getConnectionConfig());
  const files = (await readdir(migrationsDir)).filter((name) => name.endsWith(".sql")).sort();

  await client.connect();
  for (const fileName of files) {
    const migrationPath = join(migrationsDir, fileName);
    const migrationSql = await readFile(migrationPath, "utf8");
    console.log(`Running ${fileName}...`);
    await client.query(migrationSql);
    console.log("  OK");
  }
  await client.end();
  console.log("Migrations done.");
}

runMigrations().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
