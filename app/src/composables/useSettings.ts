import { computed, ref } from "vue";
import { ElMessage } from "element-plus";
import type {
  Draft,
  DictionaryType,
  LlmProfile,
  OcrProfile,
  Profile,
} from "../types/models";
import { DEFAULT_LLM_MODEL } from "../constants/app";
import { id } from "../utils/format";

export interface SettingsContext {
  getDraft: () => Draft;
  dirty: () => void;
  changePreviewProfile?: (profile: Profile) => void;
}

export function useSettings(context: SettingsContext) {
  const companyNames = ref(["xxxx有限公司"]);
  const expenseReasons = ref(["办公费", "招待费", "差旅费", "固定资产"]);
  const arrangers = ref(["王董", "张英姿", "解柳婷", "用户自行选择"]);
  const defaultCompany = ref("xxxx有限公司");
  const defaultReason = ref("办公费");
  const defaultArranger = ref("王董");
  const profiles = ref<Profile[]>([
    {
      id: "default-profile",
      name: "默认申请人",
      applicant: "",
      department: "",
      payeeName: "",
      account: "",
      bank: "",
      isDefault: true,
    },
  ]);
  const ocrProfiles = ref<OcrProfile[]>([
    {
      id: "aliyun-default",
      name: "阿里云 OCR",
      endpoint: "https://ocr-api.cn-hangzhou.aliyuncs.com",
      region: "cn-hangzhou",
      accessKeyId: "",
      accessKeySecret: "",
      timeoutSeconds: 30,
      isDefault: true,
    },
  ]);
  const llmProfiles = ref<LlmProfile[]>([
    {
      id: "deepseek-default",
      name: "DeepSeek",
      baseUrl: "https://api.deepseek.com/v1",
      apiKey: "",
      model: DEFAULT_LLM_MODEL,
      timeoutSeconds: 30,
      multimodal: false,
      isDefault: true,
    },
  ]);
  const newCompany = ref("");
  const newReason = ref("");
  const newArranger = ref("");
  const dictionaryDragState = ref<{
    type: DictionaryType;
    value: string;
    pointerId: number;
  } | null>(null);
  const dictionaryDropTarget = ref<{
    type: DictionaryType;
    value: string;
    placement: "before" | "after";
  } | null>(null);

  const defaultOcrProfile = computed(
    () =>
      ocrProfiles.value.find((item) => item.isDefault) ?? ocrProfiles.value[0],
  );
  const defaultLlmProfile = computed(
    () =>
      llmProfiles.value.find((item) => item.isDefault) ?? llmProfiles.value[0],
  );
  const currentProfileId = computed({
    get() {
      const draft = context.getDraft();
      return (
        profiles.value.find(
          (profile) =>
            profile.applicant === draft.applicant &&
            profile.department === draft.department &&
            profile.payeeName === draft.payeeName &&
            profile.account === draft.account &&
            profile.bank === draft.bank,
        )?.id ?? ""
      );
    },
    set(profileId: string) {
      const profile = profiles.value.find((item) => item.id === profileId);
      if (!profile) return;
      if (context.changePreviewProfile) {
        context.changePreviewProfile(profile);
        return;
      }
      const draft = context.getDraft();
      draft.applicant = profile.applicant;
      draft.department = profile.department;
      draft.payeeName = profile.payeeName;
      draft.account = profile.account;
      draft.bank = profile.bank;
      context.dirty();
    },
  });

  function dictionaryValues(type: DictionaryType) {
    if (type === "company") return companyNames.value;
    if (type === "reason") return expenseReasons.value;
    return arrangers.value;
  }
  function setDictionaryValues(type: DictionaryType, values: string[]) {
    if (type === "company") companyNames.value = values;
    else if (type === "reason") expenseReasons.value = values;
    else arrangers.value = values;
  }
  function reorderDictionary(
    type: DictionaryType,
    sourceValue: string,
    targetValue: string,
    placement: "before" | "after",
  ) {
    const values = dictionaryValues(type);
    const sourceIndex = values.indexOf(sourceValue);
    if (sourceIndex < 0 || sourceValue === targetValue) return;
    const next = [...values];
    next.splice(sourceIndex, 1);
    const targetIndex = next.indexOf(targetValue);
    if (targetIndex < 0) return;
    next.splice(targetIndex + (placement === "after" ? 1 : 0), 0, sourceValue);
    if (next.every((value, index) => value === values[index])) return;
    setDictionaryValues(type, next);
    context.dirty();
  }
  function startDictionaryDrag(
    event: PointerEvent,
    type: DictionaryType,
    value: string,
  ) {
    if (event.button !== 0) return;
    if (
      event.target instanceof Element &&
      event.target.closest("button, input, label.el-radio") &&
      !event.target.closest(".dictionary-drag-handle")
    )
      return;
    event.preventDefault();
    event.stopPropagation();
    dictionaryDragState.value = { type, value, pointerId: event.pointerId };
    document.body.style.userSelect = "none";
    (event.currentTarget as HTMLElement | null)?.setPointerCapture?.(
      event.pointerId,
    );
  }
  function isDictionaryDragging(type: DictionaryType, value: string) {
    const state = dictionaryDragState.value;
    return state?.type === type && state.value === value;
  }
  function isDictionaryDropTarget(
    type: DictionaryType,
    value: string,
    placement: "before" | "after",
  ) {
    const target = dictionaryDropTarget.value;
    return (
      target?.type === type &&
      target.value === value &&
      target.placement === placement
    );
  }
  function moveDictionaryDrag(event: PointerEvent) {
    const state = dictionaryDragState.value;
    if (!state) return;
    if (event.pointerId !== state.pointerId) return;
    if (!(event.buttons & 1)) {
      stopDictionaryDrag(event);
      return;
    }
    event.preventDefault();
    const container = document.querySelector<HTMLElement>(
      `.dictionary-options[data-dictionary-type="${state.type}"]`,
    );
    const target = document
      .elementFromPoint(event.clientX, event.clientY)
      ?.closest<HTMLElement>(".dictionary-option");
    const targetValue = target?.dataset.dictionaryValue;
    if (
      !container ||
      !target ||
      !container.contains(target) ||
      !targetValue ||
      targetValue === state.value
    ) {
      dictionaryDropTarget.value = null;
      return;
    }
    const rect = target.getBoundingClientRect();
    const placement =
      event.clientX < rect.left + rect.width / 2 ? "before" : "after";
    dictionaryDropTarget.value = {
      type: state.type,
      value: targetValue,
      placement,
    };
    reorderDictionary(state.type, state.value, targetValue, placement);
  }
  function stopDictionaryDrag(event?: PointerEvent) {
    const state = dictionaryDragState.value;
    if (!state || (event && event.pointerId !== state.pointerId)) return;
    dictionaryDragState.value = null;
    dictionaryDropTarget.value = null;
    document.body.style.userSelect = "";
  }
  function addCompany() {
    const value = newCompany.value.trim();
    if (!value || companyNames.value.includes(value)) return;
    companyNames.value.push(value);
    newCompany.value = "";
    context.dirty();
  }
  function removeCompany(value: string) {
    if (companyNames.value.length <= 1)
      return ElMessage.warning("至少保留一个公司名称");
    companyNames.value = companyNames.value.filter((item) => item !== value);
    if (defaultCompany.value === value)
      defaultCompany.value = companyNames.value[0];
    const draft = context.getDraft();
    if (draft.companyName === value) draft.companyName = defaultCompany.value;
    context.dirty();
  }
  function addReason() {
    const value = newReason.value.trim();
    if (!value || expenseReasons.value.includes(value)) return;
    expenseReasons.value.push(value);
    newReason.value = "";
    context.dirty();
  }
  function removeReason(value: string) {
    if (expenseReasons.value.length <= 1)
      return ElMessage.warning("至少保留一个事由");
    expenseReasons.value = expenseReasons.value.filter(
      (item) => item !== value,
    );
    if (defaultReason.value === value)
      defaultReason.value = expenseReasons.value[0];
    context.dirty();
  }
  function addArranger() {
    const value = newArranger.value.trim();
    if (!value || arrangers.value.includes(value)) return;
    arrangers.value.push(value);
    newArranger.value = "";
    context.dirty();
  }
  function removeArranger(value: string) {
    if (arrangers.value.length <= 1)
      return ElMessage.warning("至少保留一个安排人");
    arrangers.value = arrangers.value.filter((item) => item !== value);
    if (defaultArranger.value === value)
      defaultArranger.value = arrangers.value[0];
    context.dirty();
  }
  function setDictionaryDefault(
    type: "company" | "reason" | "arranger",
    value: string,
  ) {
    if (type === "company") {
      defaultCompany.value = value;
      context.getDraft().companyName = value;
    } else if (type === "reason") defaultReason.value = value;
    else defaultArranger.value = value;
    context.dirty();
  }
  function makeOcrDefault(profile: OcrProfile) {
    ocrProfiles.value.forEach((item) => {
      item.isDefault = item.id === profile.id;
    });
    context.dirty();
  }
  function makeLlmDefault(profile: LlmProfile) {
    llmProfiles.value.forEach((item) => {
      item.isDefault = item.id === profile.id;
    });
    context.dirty();
  }
  function addOcrProfile() {
    ocrProfiles.value.push({
      id: id("ocr"),
      name: "阿里云 OCR 配置" + (ocrProfiles.value.length + 1),
      endpoint: "https://ocr-api.cn-hangzhou.aliyuncs.com",
      region: "cn-hangzhou",
      accessKeyId: "",
      accessKeySecret: "",
      timeoutSeconds: 30,
      isDefault: false,
    });
    context.dirty();
  }
  function addLlmProfile() {
    llmProfiles.value.push({
      id: id("llm"),
      name: "大模型配置" + (llmProfiles.value.length + 1),
      baseUrl: "https://api.deepseek.com/v1",
      apiKey: "",
      model: DEFAULT_LLM_MODEL,
      timeoutSeconds: 30,
      multimodal: false,
      isDefault: false,
    });
    context.dirty();
  }
  function removeOcrProfile(profile: OcrProfile) {
    if (ocrProfiles.value.length <= 1)
      return ElMessage.warning("至少保留一个OCR配置");
    if (profile.isDefault) return ElMessage.warning("请先设置其他默认OCR配置");
    ocrProfiles.value = ocrProfiles.value.filter(
      (item) => item.id !== profile.id,
    );
    context.dirty();
  }
  function removeLlmProfile(profile: LlmProfile) {
    if (llmProfiles.value.length <= 1)
      return ElMessage.warning("至少保留一个大模型配置");
    if (profile.isDefault)
      return ElMessage.warning("请先设置其他默认大模型配置");
    llmProfiles.value = llmProfiles.value.filter(
      (item) => item.id !== profile.id,
    );
    context.dirty();
  }
  function setDefault(profile: Profile) {
    profiles.value.forEach((item) => {
      item.isDefault = item.id === profile.id;
    });
    const draft = context.getDraft();
    draft.applicant = profile.applicant;
    draft.department = profile.department;
    draft.payeeName = profile.payeeName;
    draft.account = profile.account;
    draft.bank = profile.bank;
    context.dirty();
    ElMessage.success(`已将“${profile.name}”设为默认申请人`);
  }
  function addProfile() {
    profiles.value.push({
      id: id("profile"),
      name: `申请人${profiles.value.length + 1}`,
      applicant: "",
      department: "",
      payeeName: "",
      account: "",
      bank: "",
      isDefault: false,
    });
    context.dirty();
  }
  function removeProfile(profile: Profile) {
    if (profiles.value.length <= 1)
      return ElMessage.warning("至少保留一个申请人");
    if (profile.isDefault)
      return ElMessage.warning("请先设置其他默认申请人，再删除当前申请人");
    profiles.value = profiles.value.filter((item) => item.id !== profile.id);
    context.dirty();
  }
  function normalizeOcrProfile(value: Partial<OcrProfile>): OcrProfile {
    return {
      id: value.id ?? id("ocr"),
      name: value.name ?? "阿里云 OCR",
      endpoint: value.endpoint ?? "https://ocr-api.cn-hangzhou.aliyuncs.com",
      region: value.region ?? "cn-hangzhou",
      accessKeyId: value.accessKeyId ?? "",
      accessKeySecret: value.accessKeySecret ?? "",
      timeoutSeconds: Number(value.timeoutSeconds) || 30,
      isDefault: Boolean(value.isDefault),
    };
  }
  function normalizeLlmProfile(value: Partial<LlmProfile>): LlmProfile {
    const model =
      value.id === "deepseek-default" &&
      (!value.model || value.model === "deepseek-chat")
        ? DEFAULT_LLM_MODEL
        : (value.model ?? DEFAULT_LLM_MODEL);
    return {
      id: value.id ?? id("llm"),
      name: value.name ?? "大模型",
      baseUrl: value.baseUrl ?? "https://api.deepseek.com/v1",
      apiKey: value.apiKey ?? "",
      model,
      timeoutSeconds: Number(value.timeoutSeconds) || 30,
      multimodal: Boolean(value.multimodal),
      isDefault: Boolean(value.isDefault),
    };
  }
  function normalizeProfile(value: Partial<Profile>, index: number): Profile {
    return {
      id: value.id ?? id("profile"),
      name: value.name ?? `申请人${index + 1}`,
      applicant: value.applicant ?? "",
      department: value.department ?? "",
      payeeName: value.payeeName ?? "",
      account: value.account ?? "",
      bank: value.bank ?? "",
      isDefault: Boolean(value.isDefault),
    };
  }
  function ensureSingleDefault<T extends { isDefault: boolean }>(items: T[]) {
    let hasDefault = false;
    items.forEach((item) => {
      if (item.isDefault && !hasDefault) {
        hasDefault = true;
        return;
      }
      item.isDefault = false;
    });
    if (!hasDefault && items[0]) items[0].isDefault = true;
  }

  return {
    companyNames,
    expenseReasons,
    arrangers,
    defaultCompany,
    defaultReason,
    defaultArranger,
    profiles,
    ocrProfiles,
    llmProfiles,
    newCompany,
    newReason,
    newArranger,
    dictionaryDragState,
    dictionaryDropTarget,
    defaultOcrProfile,
    defaultLlmProfile,
    currentProfileId,
    dictionaryValues,
    setDictionaryValues,
    reorderDictionary,
    startDictionaryDrag,
    isDictionaryDragging,
    isDictionaryDropTarget,
    moveDictionaryDrag,
    stopDictionaryDrag,
    addCompany,
    removeCompany,
    addReason,
    removeReason,
    addArranger,
    removeArranger,
    setDictionaryDefault,
    makeOcrDefault,
    makeLlmDefault,
    addOcrProfile,
    addLlmProfile,
    removeOcrProfile,
    removeLlmProfile,
    setDefault,
    addProfile,
    removeProfile,
    normalizeOcrProfile,
    normalizeLlmProfile,
    normalizeProfile,
    ensureSingleDefault,
  };
}
