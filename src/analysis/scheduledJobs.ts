import { evidenceFrom, mergeFindings } from "./evidence.js";
import { basename, grepLines, isCode, type RepoFile } from "./files.js";
import type { Finding } from "./types.js";

const CRON_LINE =
  /^\s*(@(?:reboot|yearly|annually|monthly|weekly|daily|midnight|hourly)|(?:[\d*/,-]+\s+){4}[\d*/,A-Za-z-]+)\s+(?:(?:root|www-data|apache|nginx|nobody)\s+)?(.+)$/;

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** Plain-English reading of the common cron shapes. Falls back to the raw expression. */
export function describeCron(expr: string): string {
  const named: Record<string, string> = {
    "@reboot": "at boot",
    "@yearly": "yearly",
    "@annually": "yearly",
    "@monthly": "monthly",
    "@weekly": "weekly",
    "@daily": "daily at 00:00",
    "@midnight": "daily at 00:00",
    "@hourly": "hourly",
  };
  if (named[expr]) return named[expr];
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return expr;
  const [min, hour, dom, mon, dow] = parts as [string, string, string, string, string];
  const isNum = (s: string): boolean => /^\d+$/.test(s);
  const time = isNum(min) && isNum(hour) ? `${hour.padStart(2, "0")}:${min.padStart(2, "0")}` : undefined;
  if (time && dom === "*" && mon === "*" && dow === "*") return `daily at ${time}`;
  if (time && dom === "*" && mon === "*" && isNum(dow)) return `weekly on ${DAYS[Number(dow) % 7]} at ${time}`;
  if (time && isNum(dom) && mon === "*" && dow === "*") return `monthly on day ${dom} at ${time}`;
  const every = /^\*\/(\d+)$/.exec(min);
  if (every && hour === "*" && dom === "*" && mon === "*" && dow === "*") return `every ${every[1]} minutes`;
  if (isNum(min) && hour === "*" && dom === "*" && mon === "*" && dow === "*") return `hourly at :${min.padStart(2, "0")}`;
  return expr;
}

function isCronFile(f: RepoFile): boolean {
  const name = basename(f.path).toLowerCase();
  return /cron/.test(f.path.toLowerCase()) && !/\.(php|js|ts|py|rb|java|cs|go)$/.test(name);
}

const IN_CODE: Array<{ re: RegExp; name: string }> = [
  { re: /cron\.schedule\(\s*['"]([^'"]+)['"]/, name: "node-cron schedule" },
  { re: /new\s+CronJob\(\s*['"]([^'"]+)['"]/, name: "cron CronJob" },
  { re: /schedule\.scheduleJob\(\s*['"]([^'"]+)['"]/, name: "node-schedule job" },
  { re: /\bschedule\.every\(/, name: "python schedule" },
  { re: /\.add_job\(/, name: "APScheduler job" },
  { re: /@Scheduled\(([^)]*)\)/, name: "Spring @Scheduled" },
  { re: /\$schedule->(?:command|call|job)\(/, name: "Laravel scheduler" },
  { re: /\bsetInterval\(/, name: "in-process setInterval timer" },
];

const INFRA: Array<{ re: RegExp; name: string }> = [
  { re: /^\s*kind:\s*CronJob\b/, name: "Kubernetes CronJob" },
  { re: /^\s*OnCalendar\s*=\s*(.+)$/, name: "systemd timer" },
  { re: /\bschtasks(?:\.exe)?\s+\/create\b/i, name: "Windows scheduled task" },
  { re: /^\s*-\s*cron:\s*['"]([^'"]+)['"]/, name: "CI scheduled workflow" },
];

/** Find cron entries, in-process schedulers, and infrastructure timers. */
export function findScheduledJobs(files: RepoFile[]): Finding[] {
  const out: Finding[] = [];

  for (const m of grepLines(files.filter(isCronFile), CRON_LINE)) {
    if (m.text.trim().startsWith("#")) continue;
    const schedule = (m.match[1] ?? "").trim();
    const command = (m.match[2] ?? "").trim();
    const script = /([\w./-]+\.(?:php|py|sh|js|rb|pl))\b/.exec(command)?.[1];
    const tool = command.split(/\s+/)[0] ?? command;
    out.push({
      category: "cron",
      name: script ?? tool,
      detail: `${describeCron(schedule)} (${schedule}): ${command}`,
      evidence: [evidenceFrom(m)],
    });
  }

  for (const s of IN_CODE) {
    for (const m of grepLines(files.filter(isCode), s.re)) {
      out.push({
        category: "in-process-scheduler",
        name: `${s.name}: ${m.file.path}`,
        detail: m.match[1] ? `schedule ${m.match[1]}` : undefined,
        evidence: [evidenceFrom(m)],
      });
    }
  }

  for (const s of INFRA) {
    for (const m of grepLines(files, s.re)) {
      out.push({ category: "infrastructure-scheduler", name: `${s.name}: ${m.file.path}`, detail: m.match[1], evidence: [evidenceFrom(m)] });
    }
  }

  return mergeFindings(out);
}
