import type { Draft } from "../types/models";

export function getFinanceReviewer(draft: Pick<Draft, "financeReviewer">) {
  return draft.financeReviewer === "秘书处" ? "秘书处" : "财务";
}

export function getApprovalLine(
  draft: Pick<Draft, "financeReviewer" | "showManagerApproval">,
) {
  const labels = ["部门负责人：", `${getFinanceReviewer(draft)}：`];
  if (draft.showManagerApproval !== false) labels.push("总经理审核：");
  return labels.join("                         ");
}
