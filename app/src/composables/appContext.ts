import { inject, provide, type InjectionKey, type UnwrapNestedRefs } from "vue";
import type { useSheepFinanceApp } from "./useSheepFinanceApp";

export type SheepFinanceAppContext = UnwrapNestedRefs<
  ReturnType<typeof useSheepFinanceApp>
>;

const appContextKey: InjectionKey<SheepFinanceAppContext> =
  Symbol("sheepfinance-app");

// 工作台的表格、附图与弹窗跨层复用同一份状态，避免组件拆分后复制草稿。
export function provideAppContext(context: SheepFinanceAppContext) {
  provide(appContextKey, context);
}

export function useAppContext() {
  const context = inject(appContextKey);
  if (!context) throw new Error("应用上下文尚未提供");
  return context;
}
