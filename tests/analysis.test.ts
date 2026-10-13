import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { collectSecretValues, inventoryFor, loadRepo, scrubSecrets } from "../src/analysis/index.js";
import { redact } from "../src/analysis/evidence.js";
import { isSensitivePath } from "../src/analysis/files.js";
import { describeCron } from "../src/analysis/scheduledJobs.js";
import type { Finding } from "../src/analysis/types.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.resolve(HERE, "../examples/legacy-invoicing/app");
const inv = inventoryFor(FIXTURE);

const names = (fs: Finding[], category?: string): string[] =>
  fs.filter((f) => !category || f.category === category).map((f) => f.name);

describe("loadRepo", () => {
  it("loads the fixture with repo-relative forward-slash paths", () => {
    const snap = loadRepo(FIXTURE);
    const paths = snap.files.map((f) => f.path);
    expect(paths).toContain("includes/config.php");
    expect(paths).toContain("public/.htaccess");
    expect(paths.every((p) => !p.includes("\\"))).toBe(true);
  });
});

describe("dependency_inventory", () => {
  it("parses composer.json and flags the missing lockfile", () => {
    const deps = inv.dependencies;
    expect(deps.manifests).toEqual(["composer.json"]);
    expect(deps.missingLockfiles[0]).toMatch(/composer\.json/);
    const php = deps.dependencies.find((d) => d.name === "php");
    expect(php).toMatchObject({ ecosystem: "composer", scope: "platform", version: ">=5.4" });
    const mailer = deps.dependencies.find((d) => d.name === "phpmailer/phpmailer");
    expect(mailer?.version).toBe("5.2.9");
    expect(mailer?.evidence[0]).toMatchObject({ path: "composer.json", line: 6 });
  });

  it("finds frontend libraries loaded with script tags", () => {
    const jq = inv.dependencies.dependencies.find((d) => d.name === "jquery");
    expect(jq).toMatchObject({ version: "1.7.2", scope: "frontend-asset" });
    expect(jq?.evidence[0]?.path).toBe("public/index.php");
  });
});

describe("find_entry_points", () => {
  it("maps web-root PHP files to URLs and separates JSON endpoints", () => {
    expect(names(inv.entryPoints, "web-page")).toEqual(expect.arrayContaining(["/index.php", "/login.php"]));
    expect(names(inv.entryPoints, "http-endpoint")).toEqual(
      expect.arrayContaining(["/api/charge.php", "/api/invoice_status.php"]),
    );
  });

  it("finds rewrite rules and CLI scripts", () => {
    expect(names(inv.entryPoints, "rewrite-rule")).toContain("^status\\.json$ -> api/invoice_status.php");
    const cli = inv.entryPoints.find((f) => f.category === "cli-script");
    expect(cli?.evidence[0]).toMatchObject({ path: "cron/send_overdue_reminders.php", line: 4 });
  });
});

describe("find_data_stores", () => {
  it("detects the removed mysql_* extension and the DB host", () => {
    expect(names(inv.dataStores, "driver")).toContain("MySQL (ext/mysql, removed in PHP 7)");
    expect(names(inv.dataStores, "connection-config")).toContain("DB_HOST = db01.internal.example");
  });

  it("lists tables from SQL files, with engine and charset", () => {
    expect(names(inv.dataStores, "table").sort()).toEqual(["customers", "invoices", "payments", "tax_rates", "users"]);
    const invoices = inv.dataStores.find((f) => f.category === "table" && f.name === "invoices");
    expect(invoices?.detail).toMatch(/MyISAM.*latin1/);
    expect(names(inv.dataStores, "schema-change")).toContain("invoices");
  });

  it("separates tables the code reads from tables it writes", () => {
    expect(names(inv.dataStores, "table-write").sort()).toEqual(["invoices", "payments"]);
    const writes = inv.dataStores.find((f) => f.category === "table-write" && f.name === "invoices");
    expect(writes?.evidence.map((e) => e.path)).toEqual(
      expect.arrayContaining(["cron/send_overdue_reminders.php", "public/api/charge.php"]),
    );
  });

  it("finds local file storage", () => {
    expect(names(inv.dataStores, "file-storage")).toContain("PDF_DIR = /var/www/invoicing/storage/pdf");
  });
});

describe("find_scheduled_jobs", () => {
  it("parses the crontab with a readable schedule", () => {
    const reminder = inv.scheduledJobs.find((f) => f.name.endsWith("send_overdue_reminders.php"));
    expect(reminder?.detail).toMatch(/^daily at 02:15/);
    expect(reminder?.detail).toContain("php /var/www/invoicing/cron/send_overdue_reminders.php");
    expect(reminder?.evidence[0]).toMatchObject({ path: "ops/crontab.txt", line: 3 });
    const backup = inv.scheduledJobs.find((f) => f.name === "mysqldump");
    expect(backup?.detail).toMatch(/^weekly on Sunday at 03:00/);
  });

  it("describes common cron shapes", () => {
    expect(describeCron("*/5 * * * *")).toBe("every 5 minutes");
    expect(describeCron("0 6 1 * *")).toBe("monthly on day 1 at 06:00");
    expect(describeCron("@hourly")).toBe("hourly");
    expect(describeCron("0 9 * 1-6 1")).toBe("0 9 * 1-6 1");
  });
});

describe("find_external_integrations", () => {
  it("finds the SOAP payment gateway and SMTP", () => {
    expect(names(inv.integrations, "outbound-client")).toContain("SOAP client (PHP SoapClient)");
    expect(names(inv.integrations, "external-host")).toContain("soap.paygate.example");
    expect(names(inv.integrations, "third-party-service")).toContain("Email (SMTP)");
  });

  it("finds browser calls and the ERP consumer in ops notes", () => {
    expect(names(inv.integrations, "frontend-call")).toContain("/api/charge.php");
    const erp = inv.integrations.find((f) => f.category === "network-allowlist" && f.name === "10.20.0.15");
    expect(erp?.detail).toMatch(/accounting ERP/);
  });
});

describe("find_hardcoded_config", () => {
  it("reports credential keys without their values", () => {
    expect(names(inv.hardcodedConfig, "hardcoded-secret").sort()).toEqual(["DB_PASS", "PAYGATE_API_KEY", "SMTP_PASS"]);
    const text = JSON.stringify(inv);
    expect(text).not.toContain("Winter2013!");
    expect(text).not.toContain("mailpass123");
    expect(text).not.toContain("pg-key-0000");
  });
});

describe("collectSecretValues / scrubSecrets", () => {
  it("collects literal secrets from code and scrubs them from model output", () => {
    const secrets = collectSecretValues(loadRepo(FIXTURE).files);
    expect(secrets).toEqual(expect.arrayContaining(["Winter2013!", "mailpass123", "pg-key-0000-fixture-not-real"]));
    const leaked = "The DB password is Winter2013! and SMTP uses mailpass123.";
    expect(scrubSecrets(leaked, secrets)).toBe("The DB password is [redacted] and SMTP uses [redacted].");
  });
});

describe("redact", () => {
  it("masks key/value secrets and URL credentials", () => {
    expect(redact("define('DB_PASS', 'hunter2');")).toBe("define('DB_PASS', '***');");
    expect(redact('password: "x1"')).toBe('password: "***"');
    expect(redact("postgres://app:s3cret@db:5432/x")).toBe("postgres://app:***@db:5432/x");
    expect(redact("define('DB_HOST', 'db01');")).toBe("define('DB_HOST', 'db01');");
  });
});

describe("isSensitivePath", () => {
  it("flags secrets files but not templates", () => {
    expect(isSensitivePath(".env")).toBe(true);
    expect(isSensitivePath("config/.env.production")).toBe(true);
    expect(isSensitivePath("certs/server.pem")).toBe(true);
    expect(isSensitivePath(".env.example")).toBe(false);
    expect(isSensitivePath("includes/config.php")).toBe(false);
  });
});
