/**
 * Machine-readable catalog of sharp-backed image ops for design loops.
 * The LLM maps operator language onto these ids via edit_image — do not
 * proliferate one-off Mastra tools for each new ask.
 */

export type DesignImageOpId =
  | "make_transparent"
  | "circular_mask"
  | "resize"
  | "trim"
  | "pad"
  | "derive_icon_pack"
  | "rotate"
  | "flip"
  | "flop"
  | "greyscale"
  | "blur"
  | "sharpen"
  | "modulate"
  | "tint"
  | "extract"
  | "flatten";

export type DesignImageCapability = {
  id: DesignImageOpId;
  title: string;
  description: string;
  sharpPrimitives: string[];
  /** Short param hints for the LLM (not full JSON Schema). */
  paramsHint: string;
  examples: string[];
  neverFor: string[];
};

export const DESIGN_IMAGE_CAPABILITIES: readonly DesignImageCapability[] = [
  {
    id: "make_transparent",
    title: "Chroma-key / alpha plate",
    description:
      "Key out plate/background color (auto-samples corners) to true RGBA. Soft edge; circular soft-mask fallback if corners stay opaque.",
    sharpPrimitives: ["ensureAlpha", "raw", "png"],
    paramsHint: "threshold?: number; softEdge?: number; filename?: string",
    examples: [
      "remove black background",
      "alpha channel",
      "strip the plate",
    ],
    neverFor: ["invent a new logo", "generate a different mark"],
  },
  {
    id: "circular_mask",
    title: "Circular cut-out",
    description:
      "Soft circular alpha mask; keeps interior pixels. Use for circular logos on square plates.",
    sharpPrimitives: ["ensureAlpha", "raw", "png"],
    paramsHint: "softPx?: number; filename?: string",
    examples: ["cut out the circular logo", "circular alpha mask"],
    neverFor: ["non-circular crop shapes", "invent a mark"],
  },
  {
    id: "resize",
    title: "Resize",
    description: "Contain-resize on transparent background.",
    sharpPrimitives: ["resize", "png"],
    paramsHint: "width: number; height?: number; filename?: string",
    examples: ["resize to 128", "make it 64px"],
    neverFor: ["invent pixels", "upscale with AI"],
  },
  {
    id: "trim",
    title: "Trim",
    description: "Trim empty/near-empty borders.",
    sharpPrimitives: ["trim", "png"],
    paramsHint: "filename?: string",
    examples: ["trim whitespace", "crop empty borders"],
    neverFor: ["content-aware magic erase"],
  },
  {
    id: "pad",
    title: "Pad / extend",
    description: "Center on a transparent square of given size.",
    sharpPrimitives: ["resize", "extend", "png"],
    paramsHint: "size: number; filename?: string",
    examples: ["pad to 512", "square canvas"],
    neverFor: ["add decorative borders"],
  },
  {
    id: "derive_icon_pack",
    title: "Icon / favicon pack",
    description:
      "Resize an existing mark into favicon sizes (16–512). Never invents.",
    sharpPrimitives: ["resize", "png"],
    paramsHint: "sizes?: number[]; prefix?: string",
    examples: ["icon pack", "favicons", "browser icons"],
    neverFor: ["generate a new icon design"],
  },
  {
    id: "rotate",
    title: "Rotate",
    description: "Rotate degrees (background transparent).",
    sharpPrimitives: ["rotate", "png"],
    paramsHint: "angle: number; filename?: string",
    examples: ["rotate 90", "turn 15 degrees"],
    neverFor: ["3D perspective"],
  },
  {
    id: "flip",
    title: "Flip vertical",
    description: "Mirror vertically.",
    sharpPrimitives: ["flip", "png"],
    paramsHint: "filename?: string",
    examples: ["flip vertically"],
    neverFor: [],
  },
  {
    id: "flop",
    title: "Flop horizontal",
    description: "Mirror horizontally.",
    sharpPrimitives: ["flop", "png"],
    paramsHint: "filename?: string",
    examples: ["mirror horizontally", "flop"],
    neverFor: [],
  },
  {
    id: "greyscale",
    title: "Greyscale",
    description: "Convert to greyscale.",
    sharpPrimitives: ["greyscale", "png"],
    paramsHint: "filename?: string",
    examples: ["make greyscale", "desaturate fully"],
    neverFor: ["selective color"],
  },
  {
    id: "blur",
    title: "Blur",
    description: "Gaussian blur (sigma).",
    sharpPrimitives: ["blur", "png"],
    paramsHint: "sigma?: number; filename?: string",
    examples: ["blur slightly", "soft blur"],
    neverFor: ["background removal"],
  },
  {
    id: "sharpen",
    title: "Sharpen",
    description: "Sharpen the image.",
    sharpPrimitives: ["sharpen", "png"],
    paramsHint: "filename?: string",
    examples: ["sharpen the logo"],
    neverFor: [],
  },
  {
    id: "modulate",
    title: "Modulate",
    description: "Adjust brightness / saturation / hue.",
    sharpPrimitives: ["modulate", "png"],
    paramsHint:
      "brightness?: number; saturation?: number; hue?: number; filename?: string",
    examples: ["brighten", "boost saturation", "shift hue"],
    neverFor: ["recolor to a named brand palette from prose alone"],
  },
  {
    id: "tint",
    title: "Tint",
    description: "Tint with an RGB color.",
    sharpPrimitives: ["tint", "png"],
    paramsHint: "r: number; g: number; b: number; filename?: string",
    examples: ["tint orange", "tint with brand color"],
    neverFor: ["full rebrand invent"],
  },
  {
    id: "extract",
    title: "Extract / crop",
    description: "Crop a rectangle (left, top, width, height).",
    sharpPrimitives: ["extract", "png"],
    paramsHint:
      "left: number; top: number; width: number; height: number; filename?: string",
    examples: ["crop to region", "extract center"],
    neverFor: ["subject detection"],
  },
  {
    id: "flatten",
    title: "Flatten",
    description: "Flatten onto a solid background color (drops alpha).",
    sharpPrimitives: ["flatten", "png"],
    paramsHint: "r?: number; g?: number; b?: number; filename?: string",
    examples: ["flatten on white", "remove transparency onto black"],
    neverFor: ["keep alpha"],
  },
] as const;

const BY_ID = new Map(
  DESIGN_IMAGE_CAPABILITIES.map((c) => [c.id, c] as const),
);

export function listDesignImageOpIds(): DesignImageOpId[] {
  return DESIGN_IMAGE_CAPABILITIES.map((c) => c.id);
}

export function getDesignImageCapability(
  id: string,
): DesignImageCapability | undefined {
  return BY_ID.get(id as DesignImageOpId);
}

export function assertDesignImageOp(id: string): DesignImageOpId {
  const cap = getDesignImageCapability(id);
  if (!cap) {
    throw new Error(
      `Unknown image op "${id}". Supported: ${listDesignImageOpIds().join(", ")}`,
    );
  }
  return cap.id;
}

/** Inject into design-agent / edit_image tool description. */
export function formatDesignImageCatalogForLlm(): string {
  const lines = [
    "DESIGN IMAGE CAPABILITIES (sharp-backed; call edit_image with op id):",
    "Map the operator request onto one or more of these. If none fit and inventLogo is false, say so in chat and suggest the closest ops — do not invent via Flux.",
    "",
  ];
  for (const c of DESIGN_IMAGE_CAPABILITIES) {
    lines.push(
      `- ${c.id}: ${c.description} Params: ${c.paramsHint}. Examples: ${c.examples.join("; ") || "—"}. Never: ${c.neverFor.join("; ") || "—"}.`,
    );
  }
  return lines.join("\n");
}
