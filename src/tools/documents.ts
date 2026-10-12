import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { defineTool, type ToolDefinition } from "./registry.js";
import { encodeId, id } from "./common.js";

/** BILL rejects uploads larger than this. */
export const MAX_UPLOAD_BYTES = 6 * 1024 * 1024;

const TARGETS = {
  bill: (targetId: string) => `/documents/bills/${encodeId(targetId)}`,
  vendor: (targetId: string) => `/attachments/vendors/${encodeId(targetId)}`,
  customer: (targetId: string) => `/attachments/customers/${encodeId(targetId)}`,
  invoice: (targetId: string) => `/attachments/invoices/${encodeId(targetId)}`,
} as const;

const target = z.enum(["bill", "vendor", "customer", "invoice"]).describe(
  "What the file belongs to: bill (bill document), vendor, customer, or invoice (attachments)",
);

const MIME_TYPES: Record<string, string> = {
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
  ".csv": "text/csv",
  ".txt": "text/plain",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

export function guessContentType(fileName: string): string {
  return MIME_TYPES[path.extname(fileName).toLowerCase()] ?? "application/octet-stream";
}

/**
 * Resolves a local file path for upload. Local file access is only allowed beneath BILL_UPLOAD_ROOT, so
 * a prompt-injected instruction cannot exfiltrate arbitrary files from the host into BILL.
 */
export async function resolveUploadPath(filePath: string, uploadRoot: string | undefined): Promise<string> {
  if (!uploadRoot) {
    throw new Error("Uploading from filePath is disabled. Set BILL_UPLOAD_ROOT to a directory to allow it, or pass contentBase64.");
  }
  const root = await realpath(path.resolve(uploadRoot));
  const resolved = await realpath(path.resolve(root, filePath));
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error(`filePath must be inside BILL_UPLOAD_ROOT (${root}).`);
  }
  return resolved;
}

export const documentTools: ToolDefinition[] = [
  defineTool({
    name: "bill_upload_document",
    title: "Upload document",
    description:
      "Uploads a file (max 6 MB) and attaches it to a bill, vendor, customer, or invoice. Provide contentBase64, or a filePath inside BILL_UPLOAD_ROOT. BILL processes uploads asynchronously; check with bill_get_document_upload_status.",
    toolset: "documents",
    kind: "write",
    input: {
      target,
      targetId: id("bill, vendor, customer, or invoice"),
      fileName: z.string().min(1).describe("File name including extension, e.g. invoice-1042.pdf"),
      contentBase64: z.string().optional().describe("File contents, base64-encoded"),
      filePath: z.string().optional().describe("Path relative to (or inside) BILL_UPLOAD_ROOT"),
      contentType: z.string().optional().describe("MIME type (inferred from fileName when omitted)"),
    },
    handler: async (args, { client, config }) => {
      if (Boolean(args.contentBase64) === Boolean(args.filePath)) {
        throw new Error("Provide exactly one of contentBase64 or filePath.");
      }
      let data: Uint8Array;
      if (args.filePath) {
        const resolved = await resolveUploadPath(args.filePath, config.uploadRoot);
        const info = await stat(resolved);
        if (info.size > MAX_UPLOAD_BYTES) throw new Error(`File is ${info.size} bytes; BILL accepts at most 6 MB.`);
        data = await readFile(resolved);
      } else {
        data = Buffer.from(args.contentBase64!, "base64");
        if (data.byteLength === 0) throw new Error("contentBase64 decoded to an empty file.");
      }
      if (data.byteLength > MAX_UPLOAD_BYTES) {
        throw new Error(`File is ${data.byteLength} bytes; BILL accepts at most 6 MB.`);
      }
      return client.request({
        method: "POST",
        path: TARGETS[args.target](args.targetId),
        query: { name: args.fileName },
        rawBody: { data, contentType: args.contentType ?? guessContentType(args.fileName) },
      });
    },
  }),

  defineTool({
    name: "bill_list_documents",
    title: "List documents",
    description: "Lists documents/attachments on a bill, vendor, customer, or invoice, with download links.",
    toolset: "documents",
    kind: "read",
    input: { target, targetId: id("bill, vendor, customer, or invoice") },
    handler: (args, { client }) => client.get(TARGETS[args.target](args.targetId)),
  }),

  defineTool({
    name: "bill_get_document",
    title: "Get document",
    description: "Gets a document or attachment's metadata and a time-limited download link.",
    toolset: "documents",
    kind: "read",
    input: {
      kind: z.enum(["document", "attachment"]).describe("document (bill documents) or attachment (ids begin with att)"),
      documentId: id("document or attachment"),
    },
    handler: (args, { client }) =>
      client.get(`/${args.kind === "document" ? "documents" : "attachments"}/${encodeId(args.documentId)}`),
  }),

  defineTool({
    name: "bill_get_document_upload_status",
    title: "Get document upload status",
    description: "Checks whether an uploaded document has finished processing.",
    toolset: "documents",
    kind: "read",
    input: { uploadId: z.string().min(1).describe("Upload id returned by bill_upload_document") },
    handler: (args, { client }) => client.get("/documents/upload-status", { uploadId: args.uploadId }),
  }),
];
