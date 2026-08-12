import { z } from "zod";

export const reasoningLevels = [
  "none",
  "low",
  "medium",
  "high",
  "xhigh",
  "ultracode",
  "max",
  "ultra",
] as const;

export const reasoningLevelSchema = z.enum(reasoningLevels);
export type ReasoningLevel = z.infer<typeof reasoningLevelSchema>;

export const serviceTierSchema = z.enum(["default", "fast"]);
export type ServiceTier = z.infer<typeof serviceTierSchema>;

export const projectKindSchema = z.enum(["personal", "standard"]);
export type ProjectKind = z.infer<typeof projectKindSchema>;

export const hostStatusSchema = z.enum([
  "connected",
  "disconnected",
  "missing",
]);
export type HostStatus = z.infer<typeof hostStatusSchema>;

export const favoriteNameSchema = z.string().trim().max(80);

export const favoriteInputSchema = z
  .object({
    name: favoriteNameSchema.default(""),
    projectId: z.string().trim().min(1),
    hostId: z.string().trim().min(1),
    providerId: z.string().trim().min(1),
    model: z.string().trim().min(1),
    reasoningLevel: reasoningLevelSchema,
    serviceTier: serviceTierSchema.nullable(),
  })
  .strict();

export type FavoriteInput = z.infer<typeof favoriteInputSchema>;

export const favoriteSchema = favoriteInputSchema
  .extend({
    id: z.string().trim().min(1),
    projectName: z.string(),
    projectKind: projectKindSchema,
    projectMissing: z.boolean(),
    hostName: z.string(),
    hostStatus: hostStatusSchema,
    providerName: z.string(),
    modelName: z.string(),
    createdAt: z.number().int(),
  })
  .strict();

export type Favorite = z.infer<typeof favoriteSchema>;

export const pickerProjectSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    kind: projectKindSchema,
    hostIds: z.array(z.string()),
  })
  .strict();

export type PickerProject = z.infer<typeof pickerProjectSchema>;

export const pickerHostSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    status: z.enum(["connected", "disconnected"]),
  })
  .strict();

export type PickerHost = z.infer<typeof pickerHostSchema>;

export const pickerProviderSchema = z
  .object({
    id: z.string(),
    displayName: z.string(),
    available: z.boolean(),
    supportsServiceTier: z.boolean(),
  })
  .strict();

export type PickerProvider = z.infer<typeof pickerProviderSchema>;

export const pickerModelSchema = z
  .object({
    id: z.string(),
    model: z.string(),
    displayName: z.string(),
    supportedReasoningEfforts: z.array(
      z
        .object({
          reasoningEffort: reasoningLevelSchema,
          description: z.string(),
        })
        .strict(),
    ),
    defaultReasoningEffort: reasoningLevelSchema,
    isDefault: z.boolean(),
  })
  .strict();

export type PickerModel = z.infer<typeof pickerModelSchema>;

export const catalogSchema = z
  .object({
    providers: z.array(pickerProviderSchema),
    models: z.array(pickerModelSchema),
    error: z.string().nullable(),
  })
  .strict();

export type Catalog = z.infer<typeof catalogSchema>;

export const favoriteSeedSchema = z
  .object({
    projectId: z.string(),
    projectKind: projectKindSchema,
    hostId: z.string(),
    providerId: z.string(),
    model: z.string(),
    reasoningLevel: reasoningLevelSchema,
    serviceTier: serviceTierSchema.optional(),
  })
  .strict();

export type FavoriteSeed = z.infer<typeof favoriteSeedSchema>;
