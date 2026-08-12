export function isNewThreadRequest(value: unknown): value is {
  projectId: string;
  providerId: string;
  model: string;
  reasoningLevel: string;
  permissionMode: string;
  serviceTier?: string;
  executionInputSources: object;
  environment: object;
  input: unknown[];
} {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  const isNonEmptyString = (field: unknown) =>
    typeof field === "string" && field.length > 0;
  return (
    isNonEmptyString(candidate.projectId) &&
    isNonEmptyString(candidate.providerId) &&
    isNonEmptyString(candidate.model) &&
    isNonEmptyString(candidate.reasoningLevel) &&
    isNonEmptyString(candidate.permissionMode) &&
    (candidate.serviceTier === undefined ||
      isNonEmptyString(candidate.serviceTier)) &&
    typeof candidate.executionInputSources === "object" &&
    candidate.executionInputSources !== null &&
    typeof candidate.environment === "object" &&
    candidate.environment !== null &&
    Array.isArray(candidate.input)
  );
}
