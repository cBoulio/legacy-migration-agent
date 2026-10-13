import { evidenceFrom, mergeFindings } from "./evidence.js";
import { ext, grepLines, isCode, type RepoFile } from "./files.js";
import type { Finding } from "./types.js";

const DRIVERS: Array<{ re: RegExp; name: string }> = [
  { re: /\bmysql_(?:p?connect|query|select_db)\s*\(/, name: "MySQL (ext/mysql, removed in PHP 7)" },
  { re: /\bmysqli_connect\s*\(|new\s+mysqli\s*\(/, name: "MySQL (mysqli)" },
  { re: /new\s+PDO\s*\(\s*['"](\w+):/, name: "PDO" },
  { re: /\bpg_connect\s*\(/, name: "PostgreSQL (pg_connect)" },
  { re: /\bjdbc:(\w+):/, name: "JDBC" },
  { re: /require\(\s*['"](mysql2?|pg|mssql|oracledb|sqlite3|better-sqlite3|mongodb|redis|ioredis)['"]\s*\)|from\s+['"](mysql2?|pg|mssql|oracledb|sqlite3|better-sqlite3|mongodb|redis|ioredis)['"]/, name: "Node DB driver" },
  { re: /\b(sequelize|typeorm|@prisma\/client|mongoose|knex|objection)\b/, name: "Node ORM / query builder" },
  { re: /\b(create_engine|sqlalchemy|psycopg2|pymysql|MySQLdb|pymongo|redis\.Redis)\b/, name: "Python DB library" },
  { re: /\b(Doctrine\\|Illuminate\\Database|Eloquent|ActiveRecord::Base|@Entity\b|hibernate)/, name: "ORM" },
];

const CONNECTION_STRING = /\b(mysql|mysqli|postgres(?:ql)?|mongodb(?:\+srv)?|redis|rediss|mssql|sqlserver|oracle|amqp):\/\/[^\s'"]+/i;
const DB_CONFIG = /['"]?(DB_(?:HOST|NAME|DATABASE|SERVER|DSN)|DATABASE_URL|database\.(?:host|url))['"]?\s*(?:,|=>|=|:)\s*['"]([^'"]+)['"]/i;
const SQL_TABLE_DDL = /^\s*(CREATE|ALTER|DROP)\s+TABLE\s+(?:IF\s+(?:NOT\s+)?EXISTS\s+)?[`"[]?([\w.]+)/i;
const SQL_IN_CODE = /\b(SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM|REPLACE\s+INTO)\b/i;
const TABLE_REF = /\b(FROM|JOIN|INTO|UPDATE)\s+[`"[]?([A-Za-z_][\w.]*)/gi;
const SQL_NOISE = new Set(["select", "set", "where", "values", "dual", "the", "a", "an"]);
const FILE_STORAGE = /define\(\s*['"](\w*(?:DIR|PATH|FOLDER|STORAGE)\w*)['"]\s*,\s*['"](\/[^'"]+)['"]|\bmove_uploaded_file\s*\(|\bfs\.(?:writeFile|createWriteStream)\s*\(/;

function ddlFindings(sqlFiles: RepoFile[]): Finding[] {
  const out: Finding[] = [];
  for (const f of sqlFiles) {
    const engine = /ENGINE\s*=\s*(\w+)/i.exec(f.text)?.[1];
    const charset = /CHARSET\s*=\s*(\w+)/i.exec(f.text)?.[1];
    for (const m of grepLines([f], SQL_TABLE_DDL)) {
      const verb = (m.match[1] ?? "").toUpperCase();
      const notes = [engine && `engine ${engine}`, charset && `charset ${charset}`].filter(Boolean).join(", ");
      out.push({
        category: verb === "CREATE" ? "table" : "schema-change",
        name: m.match[2] ?? "",
        detail: `${verb} TABLE in ${f.path}${notes ? ` (${notes})` : ""}`,
        evidence: [evidenceFrom(m)],
      });
    }
  }
  return out;
}

function tableAccess(code: RepoFile[]): Finding[] {
  const out: Finding[] = [];
  for (const m of grepLines(code, SQL_IN_CODE)) {
    const write = /\b(INSERT|UPDATE|DELETE|REPLACE)\b/i.test(m.text);
    TABLE_REF.lastIndex = 0;
    let t: RegExpExecArray | null;
    const seen = new Set<string>();
    while ((t = TABLE_REF.exec(m.text)) !== null) {
      const table = (t[2] ?? "").toLowerCase();
      if (!table || SQL_NOISE.has(table) || seen.has(table)) continue;
      seen.add(table);
      out.push({
        category: write ? "table-write" : "table-read",
        name: table,
        detail: write ? "Written by application code" : "Read by application code",
        evidence: [evidenceFrom(m)],
      });
    }
  }
  return out;
}

/** Find databases, schemas, table usage, and file storage the app depends on. */
export function findDataStores(files: RepoFile[]): Finding[] {
  const code = files.filter(isCode);
  const out: Finding[] = [];

  for (const d of DRIVERS) {
    for (const m of grepLines(code, d.re)) {
      const sub = m.match[1] ? ` ${m.match[1]}` : "";
      out.push({ category: "driver", name: `${d.name}${d.name === "PDO" || d.name === "JDBC" ? sub : ""}`, evidence: [evidenceFrom(m)] });
    }
  }
  for (const m of grepLines(files, CONNECTION_STRING)) {
    out.push({ category: "connection-string", name: `${(m.match[1] ?? "").toLowerCase()} URL`, evidence: [evidenceFrom(m)] });
  }
  for (const m of grepLines(files, DB_CONFIG)) {
    out.push({ category: "connection-config", name: `${m.match[1] ?? ""} = ${m.match[2] ?? ""}`, evidence: [evidenceFrom(m)] });
  }
  out.push(...ddlFindings(files.filter((f) => ext(f.path) === "sql")));
  out.push(...tableAccess(code));
  for (const m of grepLines(code, FILE_STORAGE)) {
    out.push({
      category: "file-storage",
      name: m.match[2] ? `${m.match[1] ?? ""} = ${m.match[2]}` : "writes files to local disk",
      detail: "Local filesystem state that must move with the app",
      evidence: [evidenceFrom(m)],
    });
  }
  return mergeFindings(out);
}
