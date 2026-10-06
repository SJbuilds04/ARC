import type { ArcAction, RiskLevel } from "../../shared/types";

/**
 * Risk classification is decided here, by ARC — never by the LLM.
 *
 *  informational  read-only / reversible in-ARC operations → never ask
 *  LOW            opens something                         → ask unless ARC_AUTO_EXECUTE_LOW_RISK
 *  MEDIUM         changes state on the PC                 → always ask
 *  HIGH           destructive                             → always ask, confirm must be held
 */
const RISK: Record<string, { risk: RiskLevel; informational?: boolean }> = {
  OPEN_APPLICATION: { risk: "LOW" },
  OPEN_WEBSITE: { risk: "LOW" },
  SEARCH_WEB: { risk: "LOW" },
  OPEN_FILE: { risk: "LOW" },
  QUERY_APPLICATION: { risk: "LOW", informational: true },
  SEARCH_FILE: { risk: "LOW", informational: true },
  SYSTEM_INFORMATION: { risk: "LOW", informational: true },
  CONTROL_MEDIA: { risk: "LOW", informational: true },
  CLOSE_APPLICATION: { risk: "MEDIUM" },
  CREATE_FILE: { risk: "MEDIUM" },
  TYPE_TEXT: { risk: "MEDIUM" },
  DELETE_FILE: { risk: "HIGH" },
};

export const HOLD_TO_CONFIRM_MS = 1500;

export interface RiskDecision {
  risk: RiskLevel;
  requiresConfirmation: boolean;
  holdMs: number;
}

export function classify(action: ArcAction, autoExecuteLowRisk: boolean): RiskDecision {
  const entry = RISK[action.action];
  // Anything not in the table is an ARC/playground operation: in-app and reversible.
  if (!entry) return { risk: "LOW", requiresConfirmation: false, holdMs: 0 };
  const { risk, informational } = entry;
  const requiresConfirmation = informational ? false : risk === "LOW" ? !autoExecuteLowRisk : true;
  return { risk, requiresConfirmation, holdMs: risk === "HIGH" ? HOLD_TO_CONFIRM_MS : 0 };
}
