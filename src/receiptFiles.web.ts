import { randomUUID } from 'expo-crypto';
import { RECEIPT_MIME_TYPES, RECEIPT_QUALITY, receiptDimensions, receiptMime, receiptName, validateReceiptSize } from './receiptTypes';
import type { ExpenseReceipt, ReceiptFile } from './receiptTypes';

export function pickReceipt(): Promise<ReceiptFile | null> {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = RECEIPT_MIME_TYPES.join(',');
    input.addEventListener('cancel', () => resolve(null), { once: true });
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      if (!file) { resolve(null); return; }
      prepare(file).then(resolve, reject);
    }, { once: true });
    input.click();
  });
}

async function prepare(file: File): Promise<ReceiptFile> {
  validateReceiptSize(file.size);
  let bytes = new Uint8Array(await file.arrayBuffer());
  let mimeType = receiptMime(bytes);
  let name = receiptName(file.name);
  const originalUrl = URL.createObjectURL(file);
  let result: Blob = file;
  try {
    if (mimeType !== 'application/pdf') {
      const image = new Image();
      image.src = originalUrl;
      await image.decode();
      const dimensions = receiptDimensions(image.naturalWidth, image.naturalHeight);
      const resized = dimensions.width !== image.naturalWidth || dimensions.height !== image.naturalHeight;
      const canvas = document.createElement('canvas');
      canvas.width = dimensions.width;
      canvas.height = dimensions.height;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('Este navegador no permite preparar la imagen.');
      context.drawImage(image, 0, 0, dimensions.width, dimensions.height);
      const compressed = await new Promise<Blob>((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('No pudimos comprimir la imagen.')), 'image/webp', RECEIPT_QUALITY));
      if (compressed.size < file.size || resized) {
        result = compressed;
        bytes = new Uint8Array(await compressed.arrayBuffer());
        mimeType = receiptMime(bytes);
        const extension = mimeType === 'image/png' ? '.png' : mimeType === 'image/jpeg' ? '.jpg' : '.webp';
        name = receiptName(name.replace(/\.[^.]+$/, '') + extension);
      }
    }
    validateReceiptSize(bytes.length);
    return { id: randomUUID(), name, mimeType, bytes, uri: URL.createObjectURL(result) };
  } finally { URL.revokeObjectURL(originalUrl); }
}

export function releaseReceipt(file: ReceiptFile) { URL.revokeObjectURL(file.uri); }

export async function viewReceiptPdf(uri: string) {
  const opened = window.open(uri, '_blank', 'noopener,noreferrer');
  // Browsers can return null even when noopener opened the document successfully.
  if (opened) opened.opener = null;
}

export async function downloadReceipt(url: string, receipt: ExpenseReceipt) {
  const response = await fetch(url);
  if (!response.ok) throw new Error('No se pudo descargar el comprobante. Volvé a intentar.');
  const objectUrl = URL.createObjectURL(await response.blob());
  const link = document.createElement('a');
  link.href = objectUrl;
  link.download = receipt.file_name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(objectUrl), 2000);
}
