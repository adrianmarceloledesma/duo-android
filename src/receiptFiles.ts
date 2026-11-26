import { Image, Linking, Platform } from 'react-native';
import { randomUUID } from 'expo-crypto';
import { getDocumentAsync } from 'expo-document-picker';
import { File, Paths } from 'expo-file-system';
import { StorageAccessFramework, EncodingType, readAsStringAsync, writeAsStringAsync } from 'expo-file-system/legacy';
import { manipulateAsync, SaveFormat } from 'expo-image-manipulator';
import { isAvailableAsync, shareAsync } from 'expo-sharing';
import { RECEIPT_MIME_TYPES, RECEIPT_QUALITY, receiptDimensions, receiptMime, receiptName, validateReceiptSize } from './receiptTypes';
import type { ExpenseReceipt, ReceiptFile } from './receiptTypes';

export async function pickReceipt(): Promise<ReceiptFile | null> {
  const picked = await getDocumentAsync({ type: [...RECEIPT_MIME_TYPES], multiple: false, copyToCacheDirectory: true });
  if (picked.canceled) return null;
  const asset = picked.assets[0];
  const temporary = new Set([asset.uri]);
  try {
    if (asset.size !== undefined) validateReceiptSize(asset.size);
    let bytes = await new File(asset.uri).bytes();
    validateReceiptSize(bytes.length);
    let mimeType = receiptMime(bytes);
    let uri = asset.uri;
    let name = receiptName(asset.name);
    if (mimeType !== 'application/pdf') {
      const size = await new Promise<{ width: number; height: number }>((resolve, reject) =>
        Image.getSize(uri, (width, height) => resolve({ width, height }), reject));
      const dimensions = receiptDimensions(size.width, size.height);
      const resized = dimensions.width !== size.width || dimensions.height !== size.height;
      const image = await manipulateAsync(uri, resized ? [{ resize: dimensions }] : [], { format: SaveFormat.WEBP, compress: RECEIPT_QUALITY });
      temporary.add(image.uri);
      const compressed = await new File(image.uri).bytes();
      if (compressed.length < bytes.length || resized) {
        bytes = compressed;
        uri = image.uri;
        mimeType = receiptMime(bytes);
        name = receiptName(name.replace(/\.[^.]+$/, '') + '.webp');
      }
    }
    validateReceiptSize(bytes.length);
    for (const path of temporary) if (path !== uri) removeTemporary(path);
    return { id: randomUUID(), bytes, mimeType, uri, name };
  } catch (error) {
    for (const path of temporary) removeTemporary(path);
    throw error;
  }
}

function removeTemporary(uri: string) {
  try { const file = new File(uri); if (file.exists) file.delete(); } catch { /* Cache can be cleared by Android. */ }
}

export function releaseReceipt(file: ReceiptFile) { removeTemporary(file.uri); }

export async function viewReceiptPdf(uri: string) {
  if (!uri.startsWith('https://')) throw new Error('Guardá el gasto para abrir el PDF.');
  await Linking.openURL(uri);
}

export async function downloadReceipt(url: string, receipt: ExpenseReceipt) {
  const extension = receipt.mime_type === 'application/pdf' ? 'pdf' : receipt.mime_type === 'image/jpeg' ? 'jpg' : receipt.mime_type === 'image/png' ? 'png' : 'webp';
  // Remote display names never become paths inside the app's filesystem.
  const file = await File.downloadFileAsync(url, new File(Paths.cache, `${randomUUID()}.${extension}`));
  try {
    if (Platform.OS === 'android') {
      const access = await StorageAccessFramework.requestDirectoryPermissionsAsync();
      if (!access.granted) return;
      const destination = await StorageAccessFramework.createFileAsync(access.directoryUri, receiptName(receipt.file_name), receipt.mime_type);
      const base64 = await readAsStringAsync(file.uri, { encoding: EncodingType.Base64 });
      await writeAsStringAsync(destination, base64, { encoding: EncodingType.Base64 });
    } else {
      if (!await isAvailableAsync()) throw new Error('No hay una aplicación disponible para guardar este archivo.');
      await shareAsync(file.uri, { mimeType: receipt.mime_type, dialogTitle: 'Guardar comprobante' });
    }
  } finally { removeTemporary(file.uri); }
}
