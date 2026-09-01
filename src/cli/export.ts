import fs from "fs/promises";
import path from "path";
import { clioGet, extractNextPageToken, ClioApiError } from "../utils/clioClient.js";
import { appendAuditLog } from "../utils/auditLog.js";
import { MATTER_DETAIL_FIELDS, flattenCustomFields } from "../tools/matters.js";

const USAGE =
  "Usage: clio-mcp clio-export --out-dir <path> [--status open|pending|closed] [--limit 1-200]";

type MatterStatus = "open" | "pending" | "closed";

interface ParsedArgs {
  outDir: string;
  status: MatterStatus;
  limit: number;
}

interface ParseError {
  error: string;
}

function parseArgs(argv: string[]): ParsedArgs | ParseError {
  let outDir: string | undefined;
  let status: MatterStatus = "open";
  let limit = 200;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--out-dir":
        outDir = argv[++i];
        break;
      case "--status": {
        const v = argv[++i];
        if (v !== "open" && v !== "pending" && v !== "closed") {
          return { error: `Invalid --status value: ${v}. Must be one of open, pending, closed.` };
        }
        status = v;
        break;
      }
      case "--limit": {
        const raw = argv[++i];
        const v = Number(raw);
        if (!Number.isInteger(v) || v < 1 || v > 200) {
          return { error: `Invalid --limit value: ${raw}. Must be an integer 1-200.` };
        }
        limit = v;
        break;
      }
      default:
        return { error: `Unknown argument: ${arg}` };
    }
  }

  if (!outDir) {
    return { error: "--out-dir is required." };
  }

  return { outDir, status, limit };
}

// Maps a raw Clio matter EXACTLY like get_matter's result mapping (src/tools/matters.ts),
// omitting custom_field_values_raw (this is a bulk export, not a single-record inspection tool).
function mapMatter(m: any) {
  return {
    id: m.id,
    display_number: m.display_number,
    description: m.description,
    status: m.status,
    client: m.client ? { id: m.client.id, name: m.client.name } : null,
    practice_area: m.practice_area ? { id: m.practice_area.id, name: m.practice_area.name } : null,
    open_date: m.open_date,
    close_date: m.close_date ?? null,
    billable: m.billable,
    responsible_attorney: m.responsible_attorney
      ? { id: m.responsible_attorney.id, name: m.responsible_attorney.name }
      : null,
    custom_fields: flattenCustomFields(m.custom_field_values),
  };
}

function pageFileName(pageNum: number): string {
  return `page_${String(pageNum).padStart(2, "0")}.json`;
}

// Atomic write: write to a sibling temp file, then rename into place, so a crash
// mid-write never leaves a truncated/partial page_NN.json for assemble to read.
async function writePageAtomic(outDir: string, pageNum: number, content: unknown): Promise<void> {
  const finalName = pageFileName(pageNum);
  const finalPath = path.join(outDir, finalName);
  const tmpPath = path.join(outDir, `${finalName}.tmp`);
  await fs.writeFile(tmpPath, JSON.stringify(content, null, 2), "utf8");
  await fs.rename(tmpPath, finalPath);
}

async function clearStalePages(outDir: string): Promise<void> {
  await fs.mkdir(outDir, { recursive: true });
  const existing = await fs.readdir(outDir);
  for (const f of existing) {
    if (/^page_\d+\.json$/.test(f)) {
      await fs.unlink(path.join(outDir, f));
    }
  }
}

export async function runClioExport(argv: string[]): Promise<number> {
  const parsed = parseArgs(argv);
  if ("error" in parsed) {
    console.error(`EXPORT: FAIL — ${parsed.error}`);
    console.error(USAGE);
    return 1;
  }
  const { outDir, status, limit } = parsed;
  const auditArgs = { status, limit };

  // A prior larger export must not leave stale pages behind that a later, smaller
  // export's assemble step would incorrectly merge in.
  try {
    await clearStalePages(outDir);
  } catch (err: any) {
    await appendAuditLog({ tool: "clio_export_cli", args: auditArgs, outcome: "error", error_message: err.message });
    console.error(`EXPORT: FAIL — ${err.message}`);
    return 1;
  }

  let pageNum = 0;
  let totalMatters = 0;
  let pageToken: string | undefined;

  for (;;) {
    pageNum++;
    const params: Record<string, string> = {
      fields: MATTER_DETAIL_FIELDS,
      status,
      limit: String(limit),
    };
    if (pageToken) params["page_token"] = pageToken;

    let data: any;
    try {
      data = await clioGet("/matters.json", params);
    } catch (err: any) {
      await appendAuditLog({ tool: "clio_export_cli", args: auditArgs, outcome: "error", error_message: err.message });
      // ClioApiError means the Clio API responded (token resolution already succeeded) —
      // any other error means clioGet failed before/while resolving the access token
      // (missing tokens, refresh failure, etc). getValidAccessToken() is never called
      // directly here and no browser/OAuth flow is ever triggered by this CLI path.
      if (!(err instanceof ClioApiError)) {
        console.error("EXPORT: FAIL — no valid Clio token; re-authenticate via the Clio MCP in Claude, then re-run");
        return 2;
      }
      console.error(`EXPORT: FAIL — ${err.message}`);
      return 1;
    }

    const matters = (data.data as any[]) ?? [];
    const mapped = matters.map(mapMatter);
    totalMatters += mapped.length;
    const nextToken = extractNextPageToken(data.meta);

    try {
      await writePageAtomic(outDir, pageNum, { matters: mapped, next_page_token: nextToken });
    } catch (err: any) {
      await appendAuditLog({ tool: "clio_export_cli", args: auditArgs, outcome: "error", error_message: err.message });
      console.error(`EXPORT: FAIL — ${err.message}`);
      return 1;
    }

    console.error(`EXPORT: page ${pageNum} — ${mapped.length} matters`);

    if (!nextToken) break;
    pageToken = nextToken;
  }

  await appendAuditLog({
    tool: "clio_export_cli",
    args: auditArgs,
    outcome: "success",
    result_count: totalMatters,
  });

  console.log(`EXPORT: OK — ${totalMatters} matters / ${pageNum} pages`);
  return 0;
}
