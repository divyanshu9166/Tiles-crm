import { z } from 'zod'

/**
 * Tiles, granite & marble attribute value sets.
 * Exported so the product form can render the same selectable options
 * it validates against.
 */
export const FINISH_VALUES = [
  'glossy', 'matte', 'satin', 'rustic', 'anti-skid',
  'polished', 'honed', 'leathered', 'flamed', 'river-washed',
  'bush-hammered', 'sandblasted', 'antique',
] as const
export const APPLICATION_AREA_VALUES = [
  'floor', 'wall', 'bathroom', 'kitchen_platform', 'wall_cladding',
  'staircase', 'window_sill', 'outdoor',
] as const
export const MATERIAL_CATEGORY_VALUES = [
  'TILE', 'GRANITE', 'MARBLE', 'QUARTZITE', 'SANDSTONE',
  'ENGINEERED_QUARTZ', 'ADHESIVE_GROUT', 'TRIM_PROFILE', 'OTHER',
] as const

/**
 * Unit-of-measure options surfaced for the tiles vertical: `SQFT` and `BOX`
 * in addition to the default `PCS` (Requirement 6.3, 6.4). The schema itself
 * keeps `unitOfMeasure` permissive (plain string) so existing furniture /
 * raw-material units (KG, L, M, SET, ROLL, …) remain valid; the curated set
 * below drives the tiles UI only.
 */
export const TILES_UNIT_VALUES = ['PCS', 'SQFT', 'SQM', 'BOX', 'SLAB', 'RFT'] as const

/** Treat empty strings / null as "not provided" so optional tiles fields stay optional. */
const emptyToUndefined = (v: unknown) => (v === '' || v === null ? undefined : v)

export const createProductSchema = z.object({
  sku: z.string().trim().min(1, 'SKU is required'),
  name: z.string().trim().min(1, 'Product name is required'),
  category: z.string().trim().min(1, 'Category is required'),
  price: z.number().int('Price must be a whole rupee amount').min(0, 'Price cannot be negative'),
  costPrice: z.number().int('Cost must be a whole rupee amount').min(0).default(0),
  stock: z.number().min(0).default(0),
  reorderLevel: z.number().int().min(0).default(5),
  material: z.string().optional(),
  brand: z.string().optional(),
  color: z.string().optional(),
  description: z.string().optional(),
  warehouse: z.string().optional(),
  image: z.string().optional(),
  // Accepts PCS (default), plus SQFT / BOX for tiles and existing furniture units.
  unitOfMeasure: z.string().trim().min(1).transform(v => v.toUpperCase()).default('PCS'),
  unitSize: z.number().positive().default(1),
  godownId: z.number().int().positive().optional(), // Which godown receives the initial stock
  stockGroupId: z.number().int().positive().nullable().optional(),

  // ── Tiles, granite & marble attributes ──
  materialCategory: z.preprocess(emptyToUndefined, z.enum(MATERIAL_CATEGORY_VALUES).optional()),
  isSlabTracked: z.boolean().default(false),
  origin: z.preprocess(emptyToUndefined, z.string().optional()),
  thicknessMm: z.preprocess(emptyToUndefined, z.number().positive().optional()),
  qualityGrade: z.preprocess(emptyToUndefined, z.string().optional()),
  bookMatchPair: z.boolean().default(false),
  tileSize: z.preprocess(emptyToUndefined, z.string().optional()),
  finish: z.preprocess(
    emptyToUndefined,
    z.enum(FINISH_VALUES, { message: 'Enter a supported tile or stone finish' }).optional(),
  ),
  coveragePerBox: z.preprocess(emptyToUndefined, z.number().positive().optional()),
  tilesPerBox: z.preprocess(emptyToUndefined, z.number().int().positive().optional()),
  surfaceType: z.preprocess(emptyToUndefined, z.string().optional()),
  applicationArea: z.preprocess(
      emptyToUndefined,
      z
        .enum(APPLICATION_AREA_VALUES, {
        message: 'Enter a supported tile or stone application area',
      })
      .optional(),
  ),
})

export const updateStockSchema = z.object({
  id: z.number().int().positive(),
  stock: z.number().min(0).optional(), // Backward-compatible absolute location balance
  quantity: z.number().min(0).optional(),
  operation: z.enum(['ADD', 'REMOVE', 'SET']).optional(),
  expectedBalance: z.number().min(0).optional(),
  batchId: z.number().int().positive().optional(),
  godownId: z.number().int().positive().optional(),
  reason: z.string().trim().max(200).optional(),
  notes: z.string().trim().max(2000).optional(),
}).refine(v => v.operation ? v.quantity !== undefined && (v.operation === 'SET' || v.quantity > 0) : v.stock !== undefined,
  { message: 'Enter a valid quantity (positive for adding or removing stock)' })

export const updateProductSchema = createProductSchema.omit({ category: true, warehouse: true, godownId: true, stock: true }).partial().extend({
  // Zod 4 still applies nested defaults through .partial(). Metadata patches
  // must never reset an omitted cost, unit, tracking flag or reorder threshold.
  costPrice: createProductSchema.shape.costPrice.unwrap().optional(),
  reorderLevel: createProductSchema.shape.reorderLevel.unwrap().optional(),
  unitOfMeasure: createProductSchema.shape.unitOfMeasure.unwrap().optional(),
  unitSize: createProductSchema.shape.unitSize.unwrap().optional(),
  isSlabTracked: createProductSchema.shape.isSlabTracked.unwrap().optional(),
  bookMatchPair: createProductSchema.shape.bookMatchPair.unwrap().optional(),
  tileSize: z.string().trim().nullable().optional(),
  finish: z.enum(FINISH_VALUES).nullable().optional(),
  coveragePerBox: z.number().positive().nullable().optional(),
  tilesPerBox: z.number().int().positive().nullable().optional(),
  surfaceType: z.string().trim().nullable().optional(),
  applicationArea: z.enum(APPLICATION_AREA_VALUES).nullable().optional(),
  origin: z.string().trim().nullable().optional(),
  thicknessMm: z.number().positive().nullable().optional(),
  qualityGrade: z.string().trim().nullable().optional(),
}).strict()

export type CreateProductInput = z.infer<typeof createProductSchema>
