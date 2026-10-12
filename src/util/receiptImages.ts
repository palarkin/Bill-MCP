import path from "node:path";

export type ImageContentType = "image/png" | "image/jpeg";

export interface ReceiptImage {
  fileName: string;
  contentType: ImageContentType;
  data: Uint8Array;
  /** 1-based PDF page this image was rendered from. */
  page?: number;
}

export interface ConversionResult {
  sourceType: "pdf" | "png" | "jpeg" | "converted-image";
  images: ReceiptImage[];
  totalPages?: number;
  /** Pages beyond maxPages that were not rendered. */
  skippedPages?: number;
}

export interface ConversionOptions {
  /** Maximum PDF pages to render (default 5). */
  maxPages?: number;
  /** PDF render scale; 2 ≈ 144 DPI, legible for receipts (default 2). */
  scale?: number;
  /** Re-encode rendered pages larger than this as JPEG (default 1.5 MB). */
  maxPngBytes?: number;
}

export function sniffType(data: Uint8Array, fileName: string): "pdf" | "png" | "jpeg" | "gif" | "webp" | "heic" | "unknown" {
  const head = Buffer.from(data.subarray(0, 16));
  if (head.subarray(0, 5).toString("latin1") === "%PDF-") return "pdf";
  if (head[0] === 0x89 && head.subarray(1, 4).toString("latin1") === "PNG") return "png";
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return "jpeg";
  if (head.subarray(0, 4).toString("latin1") === "GIF8") return "gif";
  if (head.subarray(0, 4).toString("latin1") === "RIFF" && head.subarray(8, 12).toString("latin1") === "WEBP") return "webp";
  if (/^ftyp(heic|heix|hevc|mif1|msf1)/.test(head.subarray(4, 12).toString("latin1"))) return "heic";
  const ext = path.extname(fileName).toLowerCase();
  if (ext === ".pdf") return "pdf";
  if (ext === ".png") return "png";
  if (ext === ".jpg" || ext === ".jpeg") return "jpeg";
  if (ext === ".heic" || ext === ".heif") return "heic";
  return "unknown";
}

const baseName = (fileName: string) => path.basename(fileName, path.extname(fileName));

async function canvasModule() {
  return import("@napi-rs/canvas");
}

async function reencode(data: Uint8Array, as: "png" | "jpeg"): Promise<Uint8Array> {
  const { createCanvas, loadImage } = await canvasModule();
  const img = await loadImage(Buffer.from(data));
  const canvas = createCanvas(img.width, img.height);
  const ctx = canvas.getContext("2d");
  if (as === "jpeg") {
    // JPEG has no alpha; paint white so transparent regions don't turn black.
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, img.width, img.height);
  }
  ctx.drawImage(img, 0, 0);
  return as === "jpeg" ? canvas.encode("jpeg", 85) : canvas.encode("png");
}

/**
 * Converts an invoice file into images BILL Spend & Expense accepts as receipts (JPG/PNG).
 * PDFs are rendered page by page; GIF/WebP are re-encoded as PNG; PNG/JPEG pass through unchanged.
 */
export async function toReceiptImages(data: Uint8Array, fileName: string, options: ConversionOptions = {}): Promise<ConversionResult> {
  const kind = sniffType(data, fileName);
  const name = baseName(fileName);

  switch (kind) {
    case "png":
      return { sourceType: "png", images: [{ fileName: `${name}.png`, contentType: "image/png", data }] };
    case "jpeg":
      return { sourceType: "jpeg", images: [{ fileName: `${name}.jpg`, contentType: "image/jpeg", data }] };
    case "gif":
    case "webp":
      return {
        sourceType: "converted-image",
        images: [{ fileName: `${name}.png`, contentType: "image/png", data: await reencode(data, "png") }],
      };
    case "pdf":
      return renderPdf(data, name, options);
    case "heic":
      throw new Error(`${fileName} is a HEIC photo, which can't be converted here. Export it as JPG or PNG first.`);
    default:
      throw new Error(`${fileName} is not a PDF, PNG, or JPG file.`);
  }
}

async function renderPdf(data: Uint8Array, name: string, options: ConversionOptions): Promise<ConversionResult> {
  const { getDocumentProxy, renderPageAsImage } = await import("unpdf");
  const maxPages = options.maxPages ?? 5;
  const scale = options.scale ?? 2;
  const maxPngBytes = options.maxPngBytes ?? 1_500_000;

  // pdf.js takes ownership of (detaches) the buffer it is given, so hand it a copy.
  const pdf = await getDocumentProxy(new Uint8Array(data));
  try {
    const totalPages = pdf.numPages;
    const pages = Math.min(totalPages, maxPages);
    const images: ReceiptImage[] = [];
    for (let page = 1; page <= pages; page++) {
      const png = new Uint8Array(await renderPageAsImage(pdf, page, { canvasImport: canvasModule, scale }));
      const suffix = totalPages > 1 ? `-page${page}` : "";
      if (png.byteLength > maxPngBytes) {
        images.push({ fileName: `${name}${suffix}.jpg`, contentType: "image/jpeg", data: await reencode(png, "jpeg"), page });
      } else {
        images.push({ fileName: `${name}${suffix}.png`, contentType: "image/png", data: png, page });
      }
    }
    return { sourceType: "pdf", images, totalPages, skippedPages: Math.max(0, totalPages - pages) };
  } finally {
    await pdf.loadingTask.destroy().catch(() => undefined);
  }
}
