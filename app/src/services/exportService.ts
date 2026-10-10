import { save as tauriSave } from "@tauri-apps/plugin-dialog";
import { writeFile as tauriWriteFile } from "@tauri-apps/plugin-fs";
import { isTauriRuntime } from "./runtimeService";

export async function saveExportBytes(
  bytes: Uint8Array,
  filename: string,
  mime: string,
  extension: string,
) {
  if (isTauriRuntime()) {
    const selectedPath = await tauriSave({
      defaultPath: filename,
      filters: [
        { name: extension.toUpperCase() + " 文件", extensions: [extension] },
      ],
    });
    if (!selectedPath) return null;
    await tauriWriteFile(selectedPath, bytes);
    return selectedPath;
  }
  const blob = new Blob([bytes], { type: mime });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  return null;
}
