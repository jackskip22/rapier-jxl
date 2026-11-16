// Writes a JPEG XL file with Capacitor's Filesystem plug-in (the encoder needs no native code).
// Filesystem's native API takes binary as base64. Returns what Filesystem returns: {uri}.
import {Filesystem, Directory} from '@capacitor/filesystem';

const base64 = blob => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(reader.result.slice(reader.result.indexOf(',') + 1));
  reader.onerror = () => reject(Object.assign(new Error(reader.error?.message || 'Could not prepare the file.'), {code: 'JXL_SAVE'}));
  reader.readAsDataURL(blob);
});

export async function saveJxl(blob, name, directory = Directory.Data) {
  return Filesystem.writeFile({directory, path: `${crypto.randomUUID()}-${name}`, data: await base64(blob)});
}
