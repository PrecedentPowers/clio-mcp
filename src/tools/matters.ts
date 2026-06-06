import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import z from "zod";
import { clioGet, clioPost, ClioApiError, extractNextPageToken } from "../utils/clioClient.js";
import { appendAuditLog } from "../utils/auditLog.js";
import { getSessionContext } from "../utils/sessionContext.js";

// Optional firm-configurable default responsible attorney.
// Shown in tool hints; auto-applied to create_matter only in stdio (single-user) mode.
const DEFAULT_ATTORNEY_ID = process.env.CLIO_DEFAULT_ATTORNEY_ID?.trim();
const DEFAULT_ATTORNEY_NUM =
  DEFAULT_ATTORNEY_ID && /^\d+$/.test(DEFAULT_ATTORNEY_ID)
    ? parseInt(DEFAULT_ATTORNEY_ID, 10)
    : undefined;
const ATTORNEY_HINT = DEFAULT_ATTORNEY_ID
  ? ` Default firm attorney user ID = ${DEFAULT_ATTORNEY_ID}.`
  : "";

const MATTER_LIST_FIELDS =
  "id,display_number,description,status,client{id,name},practice_area{id,name},open_date,close_date";

// Custom-field shape VERIFIED against the live Clio v4 API (2026-06-05):
// valid sub-fields are id,value,field_type,field_name. There is NO custom_field{}
// association on a custom_field_value (requesting it returns HTTP 400). The field name
// arrives via `field_name`; `value` is already typed (currency→number, checkbox→boolean,
// text→string) and is `null` (not omitted) when unset.
const MATTER_DETAIL_FIELDS =
  "id,display_number,description,status,client{id,name},practice_area{id,name}," +
  "open_date,close_date,billable," +
  "responsible_attorney{id,name}," +
  "custom_field_values{id,value,field_type,field_name}";

// Flatten Clio custom_field_values into a { "Field Name": value } map.
// Uses field_name (live-verified primary); custom_field?.name kept as a defensive
// fallback for any future API variant. `??` preserves false / 0 / null correctly.
function flattenCustomFields(cfvs: any[] | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const cfv of cfvs ?? []) {
    const name = cfv?.field_name ?? cfv?.custom_field?.name;
    if (!name) continue;
    const value =
      cfv?.value ??
      cfv?.picklist_option?.option ??
      cfv?.picklist_option?.name ??
      null;
    out[name] = value;
  }
  return out;
}

export function registerMatterTools(server: McpServer): void {
  server.registerTool(
    "list_matters",
    {
      description: "List matters from the connected Clio account",
      inputSchema: {
        status: z.enum(["open", "pending", "closed"]).optional().describe("Filter by matter status"),
        limit: z.number().int().min(1).max(200).default(25).describe("Max results to return (1-200)"),
        responsible_attorney_id: z.number().int().positive().optional().describe("Filter by responsible attorney Clio user ID. Use list_users to find IDs." + ATTORNEY_HINT),
        page_token: z.string().optional().describe("Cursor from a previous list_matters response to fetch the next page"),
      },
    },
    async ({ status, limit, responsible_attorney_id, page_token }) => {
      try {
        const params: Record<string, string> = {
          fields: MATTER_LIST_FIELDS,
          limit: String(limit),
        };
        if (status) params["status"] = status;
        if (responsible_attorney_id) params["responsible_attorney_id"] = String(responsible_attorney_id);
        if (page_token) params["page_token"] = page_token;

        const data = await clioGet("/matters.json", params);
        const matters = data.data as any[];

        await appendAuditLog({ tool: "list_matters", args: { status, limit, responsible_attorney_id, page_token }, outcome: "success", result_count: matters?.length ?? 0 });

        if (!matters || matters.length === 0) {
          return { content: [{ type: "text", text: "No matters found." }] };
        }

        const result = matters.map((m) => ({
          id: m.id,
          display_number: m.display_number,
          description: m.description,
          status: m.status,
          client: m.client?.name ?? null,
          practice_area: m.practice_area?.name ?? null,
          open_date: m.open_date,
          close_date: m.close_date ?? null,
        }));

        const next_page_token = extractNextPageToken(data.meta);

        return {
          content: [{ type: "text", text: JSON.stringify({ matters: result, next_page_token }, null, 2) }],
        };
      } catch (err: any) {
        await appendAuditLog({ tool: "list_matters", args: { status, limit, responsible_attorney_id, page_token }, outcome: "error", error_message: err.message });
        return {
          content: [{ type: "text", text: `Error: ${err.message}` }],
          isError: true,
        };
      }
    }
  );

  server.registerTool(
    "get_matter",
    {
      description: "Get full detail for a single matter by ID",
      inputSchema: {
        matter_id: z.number().int().describe("The Clio matter ID"),
      },
    },
    async ({ matter_id }) => {
      try {
        const data = await clioGet(`/matters/${matter_id}.json`, { fields: MATTER_DETAIL_FIELDS });
        const m = data.data;

        const result = {
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
          custom_fields: flattenCustomFields(m.custom_field_values),   // { "Docket Number": "...", ... }
          custom_field_values_raw: m.custom_field_values ?? [],        // raw, for inspection
        };

        await appendAuditLog({ tool: "get_matter", args: { matter_id }, outcome: "success", matter_id });

        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      } catch (err: any) {
        if (err instanceof ClioApiError && err.statusCode === 404) {
          await appendAuditLog({ tool: "get_matter", args: { matter_id }, outcome: "success", matter_id });
          return { content: [{ type: "text", text: `Matter ${matter_id} not found.` }] };
        }
        await appendAuditLog({ tool: "get_matter", args: { matter_id }, outcome: "error", error_message: err.message, matter_id });
        return {
          content: [{ type: "text", text: `Error: ${err.message}` }],
          isError: true,
        };
      }
    }
  );

  server.registerTool(
    "create_matter",
    {
      description: "Create a new matter in the connected Clio account. Requires numeric IDs: look up client_id via search_contacts, attorney IDs via list_users or get_user.",
      inputSchema: {
        client_id: z.number().int().positive().describe("Clio contact ID of the client for this matter"),
        description: z.string().min(1).describe("Matter subject / description"),
        practice_area_id: z.number().int().positive().optional().describe("Clio practice area ID"),
        status: z.enum(["open", "pending", "closed"]).default("open").describe("Initial matter status"),
        open_date: z.string().date().optional().describe("Open date (YYYY-MM-DD); defaults to today if omitted"),
        billable: z.boolean().default(true).describe("Whether this matter is billable (default true)"),
        responsible_attorney_id: z.number().int().positive().optional().describe("Clio user ID of the responsible attorney. Use list_users to find IDs." + ATTORNEY_HINT),
        originating_attorney_id: z.number().int().positive().optional().describe("Clio user ID of the originating attorney"),
        client_reference: z.string().optional().describe("External reference string for cross-linking with other systems"),
      },
    },
    async ({ client_id, description, practice_area_id, status, open_date,
             billable, responsible_attorney_id, originating_attorney_id, client_reference }) => {
      // Auto-apply default attorney only in single-user (stdio) mode, never in HTTP multi-user mode
      // (a single global default would be wrong per authenticated user).
      const isStdio = getSessionContext() === undefined;
      let effectiveAttorneyId = responsible_attorney_id;
      let attorneyDefaulted = false;
      if (effectiveAttorneyId === undefined && isStdio && DEFAULT_ATTORNEY_NUM !== undefined) {
        effectiveAttorneyId = DEFAULT_ATTORNEY_NUM;
        attorneyDefaulted = true;
      }
      try {
        const _d = new Date();
        const todayLocal = `${_d.getFullYear()}-${String(_d.getMonth() + 1).padStart(2, '0')}-${String(_d.getDate()).padStart(2, '0')}`;
        const matterData: Record<string, unknown> = {
          client: { id: client_id },
          description,
          status,
          billable,
          open_date: open_date ?? todayLocal,
        };
        if (practice_area_id) matterData["practice_area"] = { id: practice_area_id };
        if (effectiveAttorneyId) matterData["responsible_attorney"] = { id: effectiveAttorneyId };
        if (originating_attorney_id) matterData["originating_attorney"] = { id: originating_attorney_id };
        if (client_reference) matterData["client_reference"] = client_reference;

        const data = await clioPost("/matters.json", { data: matterData });
        const m = data.data;

        await appendAuditLog({
          tool: "create_matter",
          args: { client_id, description, practice_area_id, status, open_date,
                  billable, responsible_attorney_id: effectiveAttorneyId,
                  responsible_attorney_defaulted: attorneyDefaulted,
                  originating_attorney_id, client_reference },
          outcome: "success",
          matter_id: m.id,
        });

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: true,
              matter: {
                id: m.id,
                display_number: m.display_number,
                description: m.description,
                status: m.status,
                billable: m.billable ?? billable,
                client: m.client ? { id: m.client.id, name: m.client.name } : null,
                practice_area: m.practice_area ? { id: m.practice_area.id, name: m.practice_area.name } : null,
                responsible_attorney: m.responsible_attorney ? { id: m.responsible_attorney.id, name: m.responsible_attorney.name } : null,
                originating_attorney: m.originating_attorney ? { id: m.originating_attorney.id, name: m.originating_attorney.name } : null,
                client_reference: m.client_reference ?? client_reference ?? null,
                open_date: m.open_date,
              },
            }, null, 2),
          }],
        };
      } catch (err: any) {
        const auditArgs = { client_id, description, practice_area_id, status, open_date,
                            billable, responsible_attorney_id: effectiveAttorneyId,
                            responsible_attorney_defaulted: attorneyDefaulted,
                            originating_attorney_id, client_reference };
        if (err instanceof ClioApiError && err.statusCode === 422) {
          await appendAuditLog({ tool: "create_matter", args: auditArgs, outcome: "error", error_message: err.message });
          return {
            content: [{ type: "text", text: `Validation error: ${err.message}` }],
            isError: true,
          };
        }
        await appendAuditLog({ tool: "create_matter", args: auditArgs, outcome: "error", error_message: err.message });
        return {
          content: [{ type: "text", text: `Error: ${err.message}` }],
          isError: true,
        };
      }
    }
  );
}