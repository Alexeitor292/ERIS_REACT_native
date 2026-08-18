export type IncidentClassification = {
  incident_id: number;
  source: "GISA_ASSESSMENT";
  assessment_id: number | null;
  assessment_state: string | null;
  submission_id: number | null;
  assigned_at: string | null;
  classification_status: "UNCLASSIFIED" | "CLASSIFIED_PENDING_REVIEW" | "CLASSIFIED";
  reason: string;
  confirmed: boolean;
  codes: Array<{ code: string; label: string }>;
};

export type IncidentClassificationQueryResponse = {
  items: IncidentClassification[];
};

export function classificationLabel(classification: IncidentClassification | undefined): string {
  if (!classification) return "Loading classification…";
  if (classification.codes.length > 0) return classification.codes.map((item) => item.label).join(" · ");
  if (classification.reason === "ASSESSMENT_NOT_STARTED") return "Unclassified · assessment not started";
  if (classification.reason === "ASSESSMENT_IN_PROGRESS") return "Unclassified · assessment in progress";
  return "Unclassified · no type recorded";
}

export function classificationStateLabel(classification: IncidentClassification | undefined): string | null {
  if (!classification) return null;
  if (classification.classification_status === "CLASSIFIED_PENDING_REVIEW") return "Pending assessment review";
  if (classification.classification_status === "CLASSIFIED") return "Confirmed from approved assessment";
  return null;
}
