import { nextTick, type Ref } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import {
  CONFIG_TRANSFER_ITERATIONS,
  CONFIG_TRANSFER_SECRET,
} from "../constants/app";
import { saveExportBytes } from "../services/exportService";
import { errorMessage, isTauriRuntime } from "../services/runtimeService";
import { today } from "../utils/format";
import type {
  ConfigurationTransferPayload,
  EncryptedConfigurationEnvelope,
  LlmProfile,
  OcrProfile,
  Profile,
} from "../types/models";

export interface ConfigurationTransferContext {
  profiles: Ref<Profile[]>;
  companyNames: Ref<string[]>;
  expenseReasons: Ref<string[]>;
  arrangers: Ref<string[]>;
  defaultCompany: Ref<string>;
  defaultReason: Ref<string>;
  defaultArranger: Ref<string>;
  ocrProfiles: Ref<OcrProfile[]>;
  llmProfiles: Ref<LlmProfile[]>;
  configImportInput: Ref<HTMLInputElement | null>;
  normalizeOcrProfile: (value: Partial<OcrProfile>) => OcrProfile;
  normalizeLlmProfile: (value: Partial<LlmProfile>) => LlmProfile;
  normalizeProfile: (value: Partial<Profile>, index: number) => Profile;
  ensureSingleDefault: <T extends { isDefault: boolean }>(items: T[]) => void;
  dirty: () => void;
  persistDraft: (showMessage?: boolean) => Promise<boolean>;
}

function uniqueStrings(value: unknown) {
  if (!Array.isArray(value)) return [];
  return Array.from(
    new Set(
      value
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  );
}

function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return btoa(binary);
}

function base64ToBytes(value: string) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1)
    bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export function useConfigurationTransfer(
  context: ConfigurationTransferContext,
) {
  const {
    profiles,
    companyNames,
    expenseReasons,
    arrangers,
    defaultCompany,
    defaultReason,
    defaultArranger,
    ocrProfiles,
    llmProfiles,
    configImportInput,
    normalizeOcrProfile,
    normalizeLlmProfile,
    normalizeProfile,
    ensureSingleDefault,
    dirty,
    persistDraft,
  } = context;

  async function configurationTransferKey(
    salt: Uint8Array,
    usages: KeyUsage[],
  ) {
    const encoder = new TextEncoder();
    const material = await window.crypto.subtle.importKey(
      "raw",
      encoder.encode(CONFIG_TRANSFER_SECRET),
      "PBKDF2",
      false,
      ["deriveKey"],
    );
    return window.crypto.subtle.deriveKey(
      {
        name: "PBKDF2",
        salt,
        iterations: CONFIG_TRANSFER_ITERATIONS,
        hash: "SHA-256",
      },
      material,
      { name: "AES-GCM", length: 256 },
      false,
      usages,
    );
  }

  async function encryptConfiguration(payload: ConfigurationTransferPayload) {
    const salt = window.crypto.getRandomValues(new Uint8Array(16));
    const iv = window.crypto.getRandomValues(new Uint8Array(12));
    const key = await configurationTransferKey(salt, ["encrypt"]);
    const plaintext = new TextEncoder().encode(JSON.stringify(payload));
    const encrypted = await window.crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      key,
      plaintext,
    );
    const envelope: EncryptedConfigurationEnvelope = {
      format: "sheepfinance-encrypted-configuration",
      version: 1,
      algorithm: "AES-256-GCM",
      keyDerivation: "PBKDF2-SHA256",
      iterations: CONFIG_TRANSFER_ITERATIONS,
      salt: bytesToBase64(salt),
      iv: bytesToBase64(iv),
      ciphertext: bytesToBase64(new Uint8Array(encrypted)),
    };
    return JSON.stringify(envelope);
  }

  async function decryptConfiguration(text: string) {
    const envelope = JSON.parse(
      text,
    ) as Partial<EncryptedConfigurationEnvelope>;
    if (
      envelope.format !== "sheepfinance-encrypted-configuration" ||
      envelope.version !== 1 ||
      envelope.algorithm !== "AES-256-GCM" ||
      envelope.keyDerivation !== "PBKDF2-SHA256" ||
      envelope.iterations !== CONFIG_TRANSFER_ITERATIONS ||
      !envelope.salt ||
      !envelope.iv ||
      !envelope.ciphertext
    ) {
      throw new Error("不是有效的报销单助手加密配置文件");
    }
    const salt = base64ToBytes(envelope.salt);
    const iv = base64ToBytes(envelope.iv);
    const ciphertext = base64ToBytes(envelope.ciphertext);
    const key = await configurationTransferKey(salt, ["decrypt"]);
    const plaintext = await window.crypto.subtle.decrypt(
      { name: "AES-GCM", iv },
      key,
      ciphertext,
    );
    return JSON.parse(new TextDecoder().decode(plaintext)) as unknown;
  }

  function validateImportedConfiguration(value: unknown) {
    const payload = value as Partial<ConfigurationTransferPayload>;
    if (
      !payload ||
      payload.format !== "sheepfinance-configuration" ||
      payload.version !== 1
    ) {
      throw new Error("配置文件版本或内容不受支持");
    }
    const importedOcrProfiles = Array.isArray(payload.services?.ocrProfiles)
      ? payload.services.ocrProfiles.map(normalizeOcrProfile)
      : [];
    const importedLlmProfiles = Array.isArray(payload.services?.llmProfiles)
      ? payload.services.llmProfiles.map(normalizeLlmProfile)
      : [];
    const importedProfiles = Array.isArray(payload.profiles)
      ? payload.profiles.map(normalizeProfile)
      : [];
    const companies = uniqueStrings(payload.dictionaries?.companies);
    const reasons = uniqueStrings(payload.dictionaries?.reasons);
    const importedArrangers = uniqueStrings(payload.dictionaries?.arrangers);
    if (
      !importedOcrProfiles.length ||
      !importedLlmProfiles.length ||
      !importedProfiles.length ||
      !companies.length ||
      !reasons.length ||
      !importedArrangers.length
    ) {
      throw new Error("配置文件缺少 OCR、大模型、申请人或字典数据");
    }
    ensureSingleDefault(importedOcrProfiles);
    ensureSingleDefault(importedLlmProfiles);
    ensureSingleDefault(importedProfiles);
    return {
      ocrProfiles: importedOcrProfiles,
      llmProfiles: importedLlmProfiles,
      profiles: importedProfiles,
      companies,
      reasons,
      arrangers: importedArrangers,
      defaultCompany: companies.includes(
        payload.dictionaries?.defaultCompany ?? "",
      )
        ? (payload.dictionaries?.defaultCompany ?? companies[0])
        : companies[0],
      defaultReason: reasons.includes(payload.dictionaries?.defaultReason ?? "")
        ? (payload.dictionaries?.defaultReason ?? reasons[0])
        : reasons[0],
      defaultArranger: importedArrangers.includes(
        payload.dictionaries?.defaultArranger ?? "",
      )
        ? (payload.dictionaries?.defaultArranger ?? importedArrangers[0])
        : importedArrangers[0],
    };
  }

  async function exportConfiguration() {
    try {
      if (!window.crypto?.subtle)
        throw new Error("当前系统不支持配置加密，请升级 WebView2 后重试");
      const payload: ConfigurationTransferPayload = {
        format: "sheepfinance-configuration",
        version: 1,
        exportedAt: new Date().toISOString(),
        profiles: JSON.parse(JSON.stringify(profiles.value)),
        dictionaries: {
          companies: [...companyNames.value],
          reasons: [...expenseReasons.value],
          arrangers: [...arrangers.value],
          defaultCompany: defaultCompany.value,
          defaultReason: defaultReason.value,
          defaultArranger: defaultArranger.value,
        },
        services: {
          ocrProfiles: JSON.parse(JSON.stringify(ocrProfiles.value)),
          llmProfiles: JSON.parse(JSON.stringify(llmProfiles.value)),
        },
      };
      const encrypted = await encryptConfiguration(payload);
      const path = await saveExportBytes(
        new TextEncoder().encode(encrypted),
        `报销单助手-配置-${today()}.txt`,
        "text/plain;charset=utf-8",
        "txt",
      );
      if (isTauriRuntime() && !path) return;
      ElMessage.success("加密配置已导出");
    } catch (error) {
      ElMessage.error(`配置导出失败：${errorMessage(error)}`);
    }
  }

  function openConfigurationImport() {
    configImportInput.value?.click();
  }

  async function importConfiguration(event: Event) {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;
    try {
      if (!window.crypto?.subtle)
        throw new Error("当前系统不支持配置解密，请升级 WebView2 后重试");
      const decrypted = await decryptConfiguration(await file.text());
      const imported = validateImportedConfiguration(decrypted);
      await ElMessageBox.confirm(
        "导入后将覆盖本机现有的 OCR、大模型、申请人和字典配置，不会修改报销记录。",
        "导入加密配置",
        {
          confirmButtonText: "确认导入",
          cancelButtonText: "取消",
          type: "warning",
        },
      );
      ocrProfiles.value = imported.ocrProfiles;
      llmProfiles.value = imported.llmProfiles;
      profiles.value = imported.profiles;
      companyNames.value = imported.companies;
      expenseReasons.value = imported.reasons;
      arrangers.value = imported.arrangers;
      defaultCompany.value = imported.defaultCompany;
      defaultReason.value = imported.defaultReason;
      defaultArranger.value = imported.defaultArranger;
      dirty();
      await nextTick();
      await persistDraft(false);
      ElMessage.success("配置导入完成，已保存到本机");
    } catch (error) {
      if (error !== "cancel" && error !== "close")
        ElMessage.error(`配置导入失败：${errorMessage(error)}`);
    }
  }

  return {
    uniqueStrings,
    bytesToBase64,
    base64ToBytes,
    configurationTransferKey,
    encryptConfiguration,
    decryptConfiguration,
    validateImportedConfiguration,
    exportConfiguration,
    openConfigurationImport,
    importConfiguration,
  };
}
