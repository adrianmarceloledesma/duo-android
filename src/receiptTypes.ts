export const RECEIPT_BUCKET = 'duo-receipts';
export const MAX_RECEIPT_BYTES = 5 * 1024 * 1024;
export const MAX_RECEIPT_DIMENSION = 1600;
export const RECEIPT_QUALITY = 0.78;
export const RECEIPT_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'] as const;
export type ReceiptMime = typeof RECEIPT_MIME_TYPES[number];

export type ReceiptFile = {
  id: string;
  name: string;
  mimeType: ReceiptMime;
  bytes: Uint8Array;
  uri: string;
};

export type ExpenseReceipt = {
  id: string;
  expense_id: string;
  file_name: string;
  mime_type: ReceiptMime;
  byte_size: number;
  object_path: string;
};

export function receiptName(name: string) {
  return name.replace(/[\u0000-\u001f\u007f/\\]/g, '_').trim().slice(0, 140) || 'Comprobante';
}

// File signatures keep renamed executables, SVG and HTML out of the image/PDF picker.
export function receiptMime(bytes: Uint8Array): ReceiptMime {
  const ascii = (start: number, end: number) => String.fromCharCode(...bytes.slice(start, end));
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (ascii(0, 8) === '\x89PNG\r\n\x1a\n') return 'image/png';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp';
  if (ascii(0, 5) === '%PDF-') return 'application/pdf';
  throw new Error('Elegí un archivo JPG, PNG, WebP o PDF válido.');
}

export function validateReceiptSize(size: number) {
  if (!size) throw new Error('El archivo está vacío.');
  if (size > MAX_RECEIPT_BYTES) throw new Error('El comprobante debe pesar hasta 5 MB.');
}

export function receiptDimensions(width: number, height: number) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new Error('No pudimos leer la imagen.');
  }
  const ratio = Math.min(1, MAX_RECEIPT_DIMENSION / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * ratio)), height: Math.max(1, Math.round(height * ratio)) };
}
