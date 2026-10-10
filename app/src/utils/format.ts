import { REIMBURSEMENT_STATUSES } from "../constants/app";
import type {
  HistoryViewMode,
  ReimbursementStatus,
  Transform,
} from "../types/models";

export function today() {
  const date = new Date();
  return `${date.getFullYear()}-${`${date.getMonth() + 1}`.padStart(2, "0")}-${`${date.getDate()}`.padStart(2, "0")}`;
}

export function id(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function transform(index: number, total = 6): Transform {
  const columns = 3;
  const rows = total <= 6 ? 2 : Math.ceil(total / columns);
  const column = index % columns;
  const row = Math.floor(index / columns);
  return {
    x: (column * 100) / columns,
    y: (row * 100) / rows,
    width: 100 / columns,
    height: 100 / rows,
    rotation: 0,
    cropZoom: 1,
    cropX: 50,
    cropY: 50,
  };
}

export function parseAmountExpression(raw: string) {
  let source = raw.trim().replace(/[,，]/g, "");
  if (!source) return 0;
  if (source.startsWith("=")) source = source.slice(1).trim();
  if (!source || source.length > 160) return null;
  let cursor = 0;
  function skipSpaces() {
    while (/\s/.test(source[cursor] ?? "")) cursor += 1;
  }
  function parseNumber() {
    skipSpaces();
    const match = /^(?:\d+(?:\.\d*)?|\.\d+)/.exec(source.slice(cursor));
    if (!match) return null;
    cursor += match[0].length;
    const value = Number(match[0]);
    return Number.isFinite(value) ? value : null;
  }
  function parsePrimary(): number | null {
    skipSpaces();
    if (source[cursor] === "(") {
      cursor += 1;
      const value = parseExpression();
      skipSpaces();
      if (source[cursor] !== ")" || value === null) return null;
      cursor += 1;
      return value;
    }
    return parseNumber();
  }
  function parseUnary(): number | null {
    skipSpaces();
    if (source[cursor] === "+" || source[cursor] === "-") {
      const sign = source[cursor] === "-" ? -1 : 1;
      cursor += 1;
      const value = parseUnary();
      return value === null ? null : sign * value;
    }
    return parsePrimary();
  }
  function parseTerm(): number | null {
    let value = parseUnary();
    if (value === null) return null;
    while (true) {
      skipSpaces();
      const operator = source[cursor];
      if (operator !== "*" && operator !== "/") return value;
      cursor += 1;
      const right = parseUnary();
      if (right === null || (operator === "/" && right === 0)) return null;
      value = operator === "*" ? value * right : value / right;
      if (!Number.isFinite(value)) return null;
    }
  }
  function parseExpression(): number | null {
    let value = parseTerm();
    if (value === null) return null;
    while (true) {
      skipSpaces();
      const operator = source[cursor];
      if (operator !== "+" && operator !== "-") return value;
      cursor += 1;
      const right = parseTerm();
      if (right === null) return null;
      value = operator === "+" ? value + right : value - right;
      if (!Number.isFinite(value)) return null;
    }
  }
  const result = parseExpression();
  skipSpaces();
  return result !== null && cursor === source.length && Number.isFinite(result)
    ? Math.abs(result) <= 1_000_000_000_000
      ? result
      : null
    : null;
}

export function amountExpressionToCents(raw: string) {
  const value = parseAmountExpression(raw);
  return value === null ? null : Math.round(value * 100);
}

export function money(cents: number) {
  const value = Object.is(cents, -0) ? 0 : cents;
  return (value / 100).toLocaleString("zh-CN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export function normalizeReimbursementStatus(value: unknown): ReimbursementStatus {
  return REIMBURSEMENT_STATUSES.includes(value as ReimbursementStatus)
    ? (value as ReimbursementStatus)
    : "未报销";
}

export function normalizeHistoryViewMode(value: unknown): HistoryViewMode {
  return value === "status" || value === "list" ? value : "company";
}

export function reimbursementStatusType(status: ReimbursementStatus) {
  if (status === "已报销") return "success";
  if (status === "报销中") return "warning";
  return "info";
}

export function formatDateTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleString("zh-CN", {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      });
}

export function formatSaveTime(value: string | Date) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

export function ChineseAmount(cents: number) {
  const digits = "零壹贰叁肆伍陆柒捌玖";
  const units = ["", "拾", "佰", "仟"];
  const bigUnits = ["", "万", "亿", "兆"];
  const negative = cents < 0;
  const value = Math.abs(Math.round(cents));
  const withSign = (text: string) => (negative && value ? `负${text}` : text);
  const yuan = Math.floor(value / 100);
  const jiao = Math.floor((value % 100) / 10);
  const fen = value % 10;
  function groupToText(group: number) {
    let text = "";
    let zero = false;
    for (let i = 0; i < 4; i += 1) {
      const digit = Math.floor(group / 10 ** (3 - i)) % 10;
      if (!digit) {
        if (text) zero = true;
        continue;
      }
      if (zero) text += "零";
      text += `${digits[digit]}${units[3 - i]}`;
      zero = false;
    }
    return text;
  }
  if (!yuan && !jiao && !fen) return "零元整";
  let rest = yuan;
  const groups: number[] = [];
  while (rest) {
    groups.unshift(rest % 10000);
    rest = Math.floor(rest / 10000);
  }
  let text = "";
  let needZero = false;
  groups.forEach((group, index) => {
    const unit = bigUnits[groups.length - index - 1] ?? "";
    if (!group) {
      if (text) needZero = true;
      return;
    }
    if (text && (needZero || group < 1000)) text += "零";
    text += `${groupToText(group)}${unit}`;
    needZero = false;
  });
  text += "元";
  if (jiao) text += `${digits[jiao]}角`;
  if (!jiao && fen) text += "零";
  if (fen) text += `${digits[fen]}分`;
  if (!jiao && !fen) text += "整";
  return withSign(text);
}

export function wrappedLineCount(value: string, lineCapacity: number) {
  return Math.max(
    1,
    value.split(/\r?\n/).reduce((total, line) => {
      const width = Array.from(line).reduce(
        (sum, character) =>
          sum + (/^[\u0000-\u00ff]$/.test(character) ? 0.55 : 1),
        0,
      );
      return total + Math.max(1, Math.ceil(width / lineCapacity));
    }, 0),
  );
}
