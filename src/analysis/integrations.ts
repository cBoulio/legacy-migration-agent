import { evidenceFrom, mergeFindings } from "./evidence.js";
import { ext, grepLines, isCode, type RepoFile } from "./files.js";
import type { Finding } from "./types.js";

const CLIENTS: Array<{ re: RegExp; name: string }> = [
  { re: /new\s+SoapClient\s*\(/, name: "SOAP client (PHP SoapClient)" },
  { re: /\bnusoap_client\b/, name: "SOAP client (NuSOAP)" },
  { re: /\bcurl_init\s*\(/, name: "HTTP client (curl)" },
  { re: /\bfile_get_contents\s*\(\s*['"]https?:/, name: "HTTP client (file_get_contents)" },
  { re: /\bfsockopen\s*\(/, name: "raw socket (fsockopen)" },
  { re: /\baxios(?:\.\w+)?\s*\(/, name: "HTTP client (axios)" },
  { re: /\b(?:https?)\.(?:request|get)\s*\(/, name: "HTTP client (node http)" },
  { re: /\brequests\.(?:get|post|put|delete|patch)\s*\(/, name: "HTTP client (python requests)" },
  { re: /\burllib\d?\.request\b|\burlopen\s*\(/, name: "HTTP client (urllib)" },
  { re: /\b(?:RestTemplate|WebClient|HttpClient)\b/, name: "HTTP client (JVM/.NET)" },
  { re: /(?<![.\w])fetch\s*\(\s*['"`]https?:/, name: "HTTP client (fetch)" },
];

const SERVICES: Array<{ re: RegExp; name: string }> = [
  { re: /\bPHPMailer\b|\bnodemailer\b|\bsmtplib\b|\bJavaMailSender\b|\bSMTP_HOST\b/, name: "Email (SMTP)" },
  { re: /(?<![\w>])mail\s*\(\s*\$/, name: "Email (PHP mail())" },
  { re: /\bstripe\b/i, name: "Stripe" },
  { re: /\bbraintree\b/i, name: "Braintree" },
  { re: /\bpaypal\b/i, name: "PayPal" },
  { re: /\btwilio\b/i, name: "Twilio" },
  { re: /\bsendgrid\b/i, name: "SendGrid" },
  { re: /\baws-sdk\b|@aws-sdk\/|\bboto3\b/, name: "AWS SDK" },
  { re: /@google-cloud\/|google\.cloud\b/, name: "Google Cloud SDK" },
  { re: /\bldap_connect\s*\(|\bldapjs\b/, name: "LDAP directory" },
  { re: /\bftp_connect\s*\(|\bftplib\b|\bssh2_sftp\b/, name: "FTP/SFTP transfer" },
];

const URL_LITERAL = /\bhttps?:\/\/([a-z0-9.-]+\.[a-z]{2,}|localhost|\d{1,3}(?:\.\d{1,3}){3})(:\d+)?[^\s'"<>)]*/i;
const IGNORED_HOSTS = /(^|\.)(w3\.org|xmlsoap\.org|schemas\.\w+|json-schema\.org|php\.net|apache\.org|mozilla\.org|example\.com)$/i;
const FRONTEND_CALL = /(?:\$\.(?:ajax|get|post|getJSON)|fetch|axios\.\w+)\s*\(\s*(?:\{\s*)?(?:url\s*:\s*)?['"`](\/[^'"`]*)['"`]|\burl\s*:\s*['"`](\/[^'"`]+)['"`]/;
const CONSUMER_HINT = /(?:\/\/|#|\*|--)\s*.*\b(polls?|polled|consumed by|called by|webhook|callback url|used by|integrat\w*)\b/i;
const IP_ALLOW = /\b(\d{1,3}(?:\.\d{1,3}){3}(?:\/\d{1,2})?)\b\s+(.+)$/;
const OUTBOUND_HOST = /^\s*-?\s*([a-z0-9.-]+\.[a-z]{2,}):(\d+)\s*(.*)$/i;
const HOST_CONFIG = /define\(\s*['"](?!DB_)(\w*(?:HOST|URL|WSDL|ENDPOINT)\w*)['"]\s*,\s*['"]([^'"]+)['"]/;

/** Find outbound calls, third-party services, and hints about who calls this app. */
export function findExternalIntegrations(files: RepoFile[]): Finding[] {
  const code = files.filter(isCode);
  const out: Finding[] = [];

  for (const c of CLIENTS) {
    for (const m of grepLines(code, c.re)) out.push({ category: "outbound-client", name: c.name, evidence: [evidenceFrom(m)] });
  }
  for (const s of SERVICES) {
    for (const m of grepLines(code, s.re)) out.push({ category: "third-party-service", name: s.name, evidence: [evidenceFrom(m)] });
  }
  for (const m of grepLines(files.filter((f) => ext(f.path) !== "md"), URL_LITERAL)) {
    const host = (m.match[1] ?? "").toLowerCase();
    if (IGNORED_HOSTS.test(host)) continue;
    out.push({ category: "external-host", name: host, detail: "URL literal in source or config", evidence: [evidenceFrom(m)] });
  }
  for (const m of grepLines(code, HOST_CONFIG)) {
    out.push({ category: "endpoint-config", name: `${m.match[1] ?? ""} = ${m.match[2] ?? ""}`, evidence: [evidenceFrom(m)] });
  }
  for (const m of grepLines(code, FRONTEND_CALL)) {
    const url = m.match[1] ?? m.match[2] ?? "";
    out.push({ category: "frontend-call", name: url, detail: "Browser code calls this app endpoint", evidence: [evidenceFrom(m)] });
  }
  for (const m of grepLines(files, CONSUMER_HINT)) {
    out.push({
      category: "consumer-hint",
      name: `${m.file.path}:${m.line}`,
      detail: "Comment or note that names a caller or integration; confirm with the owning team",
      evidence: [evidenceFrom(m)],
    });
  }
  const notes = files.filter((f) => /firewall|allowlist|whitelist|network|ports?/i.test(f.path) && !isCode(f));
  for (const m of grepLines(notes, IP_ALLOW)) {
    out.push({ category: "network-allowlist", name: m.match[1] ?? "", detail: (m.match[2] ?? "").trim(), evidence: [evidenceFrom(m)] });
  }
  for (const m of grepLines(notes, OUTBOUND_HOST)) {
    out.push({ category: "network-egress", name: `${m.match[1] ?? ""}:${m.match[2] ?? ""}`, detail: (m.match[3] ?? "").trim() || undefined, evidence: [evidenceFrom(m)] });
  }
  return mergeFindings(out);
}
