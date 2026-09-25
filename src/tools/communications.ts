import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import z from "zod";
import { clioGet, extractNextPageToken } from "../utils/clioClient.js";
import { appendAuditLog } from "../utils/auditLog.js";
import { stripHtml } from "../utils/text.js";

const COMMUNICATION_FIELDS =
  "id,type,subject,body,date,received_at,senders{id,name,type},receivers{id,name,type},user{id,name},matter{id,display_number},created_at,updated_at";

// senders/receivers are polymorphic (Contact or User); flatten to one shape.
function toParticipant(p: any) {
  return { id: p?.id ?? null, name: p?.name ?? null, kind: p?.type ?? null };
}

export function registerCommunicationTools(server: McpServer): void {
  server.registerTool(
    "list_communications",
    {
      description:
        "List the logged emails and phone calls (Clio's Communications log) on a matter. Filters on type and the received_since/received_before window are native Clio filters; body is omitted unless include_body is true, and body_max_chars truncation is applied in-tool.",
      inputSchema: {
        matter_id: z.number().int().positive().describe("Matter whose communications to list"),
        type: z.enum(["EmailCommunication", "PhoneCommunication"]).optional().describe("Only emails or only phone calls; omit for both"),
        received_since: z.string().optional().describe("ISO-8601 date; only communications dated on or after this"),
        received_before: z.string().optional().describe("ISO-8601 date; only communications dated on or before this"),
        include_body: z.boolean().default(false).describe("Include the communication body (default false)"),
        body_max_chars: z.number().int().min(1).default(2000).describe("Truncate each body to this many characters when include_body is true"),
        limit: z.number().int().min(1).max(200).default(50).describe("Max results to return (1-200)"),
        page_token: z.string().optional().describe("Cursor from a previous list_communications response to fetch the next page"),
      },
    },
    async ({ matter_id, type, received_since, received_before, include_body, body_max_chars, limit, page_token }) => {
      const auditArgs = { matter_id, type, received_since, received_before, include_body, body_max_chars, limit, page_token };
      try {
        const params: Record<string, string> = {
          fields: COMMUNICATION_FIELDS,
          limit: String(limit),
          matter_id: String(matter_id),
        };
        if (type) params["type"] = type;
        if (received_since) params["received_since"] = received_since;
        if (received_before) params["received_before"] = received_before;
        if (page_token) params["page_token"] = page_token;

        const data = await clioGet("/communications.json", params);
        const comms = (data.data ?? []) as any[];
        const nextPageToken = comms.length >= limit ? extractNextPageToken(data.meta) : null;

        await appendAuditLog({
          tool: "list_communications",
          args: auditArgs,
          outcome: "success",
          result_count: comms.length,
          matter_id,
        });

        if (comms.length === 0) {
          return { content: [{ type: "text", text: "No communications found." }] };
        }

        const result = {
          communications: comms.map((c) => {
            let body: unknown;
            let body_truncated = false;
            if (include_body) {
              const text = stripHtml(c.body);
              if (typeof text === "string" && text.length > body_max_chars) {
                body = text.slice(0, body_max_chars);
                body_truncated = true;
              } else {
                body = text ?? null;
              }
            }
            return {
              id: c.id,
              type: c.type,
              subject: c.subject ?? null,
              date: c.date ?? null,
              received_at: c.received_at ?? null,
              senders: (c.senders ?? []).map(toParticipant),
              receivers: (c.receivers ?? []).map(toParticipant),
              user: c.user ? { id: c.user.id, name: c.user.name } : null,
              matter: c.matter ? { id: c.matter.id, display_number: c.matter.display_number } : null,
              ...(include_body && { body, body_truncated }),
              created_at: c.created_at,
              updated_at: c.updated_at,
            };
          }),
          total_count: data.meta?.records ?? comms.length,
          has_more: nextPageToken !== null,
          next_page_token: nextPageToken,
        };

        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (err: any) {
        await appendAuditLog({
          tool: "list_communications",
          args: auditArgs,
          outcome: "error",
          error_message: err.message,
          matter_id,
        });
        return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
      }
    }
  );
}
