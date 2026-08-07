import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import {
  circularMaskDesignAsset,
  deriveIconPackFromAsset,
  applyDesignImageOp,
  applyDesignImagePipeline,
  formatDesignImageCatalogForLlm,
  listDesignImageOpIds,
  generateDesignImage,
  importDesignImageById,
  makeTransparentDesignAsset,
  padDesignAsset,
  promptLooksLikeImageEdit,
  resizeDesignAsset,
  reviewDesignLoopLook,
  searchDesignImages,
  trimDesignAsset,
} from "@slopcontrol/coding-tools";
import {
  getDesignLoopSelections,
  listDesignLoopAssets,
  pinDesignLoopLogoAsset,
  readDesignLoopMeta,
} from "@slopcontrol/artifacts";
import type { LlmRegistry } from "@slopcontrol/llm";

function pinnedLogoFilename(projectDir: string, loopId: string): string | undefined {
  const meta = readDesignLoopMeta(projectDir, loopId);
  const sel = getDesignLoopSelections(meta).find((s) => s.slot === "logo");
  return sel?.asset;
}

function resolveLoopAssetName(
  projectDir: string,
  loopId: string,
  filename: string,
): string | null {
  const meta = readDesignLoopMeta(projectDir, loopId);
  if (!meta) return null;
  const needle = basenameSafe(filename.trim());
  const assets = listDesignLoopAssets(projectDir, meta.projectId, loopId);
  const hit = assets.find((a) => a.name.toLowerCase() === needle.toLowerCase());
  return hit?.name ?? null;
}

function basenameSafe(relativePath: string): string {
  const parts = relativePath.replace(/\\/g, "/").split("/");
  return parts[parts.length - 1] || relativePath;
}

export function createDesignLoopMediaTools(
  projectDir: string,
  registry: LlmRegistry,
) {
  const generate_image = createTool({
    id: "generate_image",
    description:
      "Invent a NEW raster via Flux. Do NOT use for alpha/transparent/icon-pack/resize on an existing asset — use edit_image (catalog ops) instead. When CONTINUE INTENT says NEW LOGO / inventLogo, pass inventNew=true (required if a logo is still pinned). After success, call pin_logo on the new filename.",
    inputSchema: z.object({
      loopId: z.string().min(1),
      prompt: z.string().min(1),
      filename: z.string().optional(),
      width: z.number().int().positive().optional(),
      height: z.number().int().positive().optional(),
      /** Set true when inventing a brand-new mark (required if a logo is pinned). */
      inventNew: z.boolean().optional(),
    }),
    execute: async ({
      loopId,
      prompt,
      filename,
      width,
      height,
      inventNew,
    }) => {
      try {
        const meta = readDesignLoopMeta(projectDir, loopId);
        if (!meta) return { ok: false, error: `Design loop not found: ${loopId}` };
        if (promptLooksLikeImageEdit(prompt) && !inventNew) {
          return {
            ok: false,
            error:
              "This looks like an image EDIT. Use edit_image with a catalog op (make_transparent, circular_mask, derive_icon_pack, resize, …) on the existing/pinned asset — do not generate_image.",
          };
        }
        const pinned = pinnedLogoFilename(projectDir, loopId);
        if (pinned && !inventNew) {
          return {
            ok: false,
            error: `Logo is pinned (${pinned}). Embed that path or call edit_image on it. Unpin first or pass inventNew=true only to invent an unrelated new mark.`,
          };
        }
        const binding = registry.tryResolveDesignImage();
        if (!binding) {
          return {
            ok: false,
            error:
              "designImage unbound — bind roles.designImage to openai-images (e.g. x/flux2-klein)",
          };
        }
        const result = await generateDesignImage({
          projectRoot: projectDir,
          prompt,
          endpoint: binding.endpoint,
          modelId: binding.modelId,
          loopId,
          filename,
          width,
          height,
        });
        return {
          ok: true,
          path: result.path,
          relativePath: result.relativePath,
          bytes: result.bytes,
          format: result.format,
          hint:
            `Embed in mock as <img src="${result.relativePath}"> (project-relative; preview rewrites to HTTP). Keep relativePath for disk/implement.`,
        };
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
  });

  const pin_logo = createTool({
    id: "pin_logo",
    description:
      "Pin an existing loop asset as the authoritative logo. Call when the operator names a file (e.g. jamlight-logo-modern-v4-alpha.png) or says to pin/use/go with that mark. Then embed that asset in the mock menubar/landing — do not invent a competing mark.",
    inputSchema: z.object({
      loopId: z.string().min(1),
      filename: z.string().min(1),
      label: z.string().optional(),
    }),
    execute: async ({ loopId, filename, label }) => {
      try {
        const meta = readDesignLoopMeta(projectDir, loopId);
        if (!meta) return { ok: false, error: `Design loop not found: ${loopId}` };
        const resolved = resolveLoopAssetName(projectDir, loopId, filename);
        if (!resolved) {
          const available = listDesignLoopAssets(
            projectDir,
            meta.projectId,
            loopId,
          )
            .map((a) => a.name)
            .slice(0, 40);
          return {
            ok: false,
            error: `Asset not found in loop: ${filename}`,
            available,
          };
        }
        const next = pinDesignLoopLogoAsset({
          projectRoot: projectDir,
          loopId,
          asset: resolved,
          label: label || resolved,
        });
        if (!next) {
          return { ok: false, error: "Failed to pin logo (meta missing)" };
        }
        const relativePath = `.slopcontrol/design-loops/${loopId}/assets/${resolved}`;
        return {
          ok: true,
          pinnedLogo: resolved,
          relativePath,
          hint: `Pinned logo → ${resolved}. Embed <img src="${relativePath}"> in menubar/landing. Prefer derive_icon_pack on this file for favicons.`,
        };
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
  });

  const edit_image = createTool({
    id: "edit_image",
    description: `Deterministic sharp edit of an EXISTING loop asset. Prefer this over one-off tools. Ops: ${listDesignImageOpIds().join(", ")}. ${formatDesignImageCatalogForLlm().slice(0, 1_200)}…`,
    inputSchema: z.object({
      loopId: z.string().min(1),
      sourceFilename: z.string().optional(),
      op: z.string().min(1).optional(),
      params: z.record(z.string(), z.any()).optional(),
      /** Multi-step recipe; when set, runs in order (each uses prior output). */
      ops: z
        .array(
          z.object({
            op: z.string().min(1),
            params: z.record(z.string(), z.any()).optional(),
          }),
        )
        .optional(),
    }),
    execute: async ({ loopId, sourceFilename, op, params, ops }) => {
      try {
        const meta = readDesignLoopMeta(projectDir, loopId);
        if (!meta) return { ok: false, error: `Design loop not found: ${loopId}` };
        const source =
          sourceFilename?.trim() || pinnedLogoFilename(projectDir, loopId);
        if (!source) {
          return {
            ok: false,
            error:
              "sourceFilename required (or pin a logo first via selections API)",
          };
        }
        if (ops?.length) {
          const pipeline = await applyDesignImagePipeline({
            projectRoot: projectDir,
            loopId,
            sourceFilename: source,
            ops,
          });
          const last = pipeline.results[pipeline.results.length - 1];
          const outName = basenameSafe(pipeline.primaryFilename);
          if (!last?.files?.length) {
            pinDesignLoopLogoAsset({
              projectRoot: projectDir,
              loopId,
              asset: outName,
              label: `Edited mark (${outName})`,
            });
          }
          return {
            ok: true,
            ...pipeline,
            pinnedLogo: last?.files?.length ? undefined : outName,
            hint: pipeline.summaries.join(" "),
          };
        }
        if (!op?.trim()) {
          return {
            ok: false,
            error: `op or ops required. Supported: ${listDesignImageOpIds().join(", ")}`,
          };
        }
        const result = await applyDesignImageOp({
          projectRoot: projectDir,
          loopId,
          sourceFilename: source,
          op,
          params,
        });
        const outName = basenameSafe(result.relativePath || source);
        if (!result.files?.length && result.relativePath) {
          pinDesignLoopLogoAsset({
            projectRoot: projectDir,
            loopId,
            asset: outName,
            label: `Edited mark (${outName})`,
          });
        }
        return {
          ok: true,
          ...result,
          pinnedLogo: result.files?.length ? undefined : outName,
          hint: result.summary,
        };
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
  });

  const make_transparent = createTool({
    id: "make_transparent",
    description:
      "Alias of edit_image op=make_transparent. Prefer edit_image for new work.",
    inputSchema: z.object({
      loopId: z.string().min(1),
      sourceFilename: z.string().optional(),
      filename: z.string().optional(),
      threshold: z.number().int().min(0).max(441).optional(),
    }),
    execute: async ({ loopId, sourceFilename, filename, threshold }) => {
      try {
        const meta = readDesignLoopMeta(projectDir, loopId);
        if (!meta) return { ok: false, error: `Design loop not found: ${loopId}` };
        const source =
          sourceFilename?.trim() || pinnedLogoFilename(projectDir, loopId);
        if (!source) {
          return {
            ok: false,
            error:
              "sourceFilename required (or pin a logo first via selections API)",
          };
        }
        const result = await makeTransparentDesignAsset({
          projectRoot: projectDir,
          loopId,
          sourceFilename: source,
          filename,
          threshold,
        });
        const outName = basenameSafe(result.relativePath);
        pinDesignLoopLogoAsset({
          projectRoot: projectDir,
          loopId,
          asset: outName,
          label: `Alpha mark (${outName})`,
        });
        return {
          ok: true,
          ...result,
          pinnedLogo: outName,
          hint: `Pinned logo → ${outName}. Embed <img src="${result.relativePath}"> — true RGBA from ${result.sourceFilename}. Do not call generate_image.`,
        };
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
  });

  const circular_mask = createTool({
    id: "circular_mask",
    description:
      "Deterministic edit: soft circular alpha cut-out of an EXISTING loop asset (keep interior pixels). Use when the operator asks to cut out a circular logo. Does not invent a new mark.",
    inputSchema: z.object({
      loopId: z.string().min(1),
      sourceFilename: z.string().optional(),
      filename: z.string().optional(),
    }),
    execute: async ({ loopId, sourceFilename, filename }) => {
      try {
        const meta = readDesignLoopMeta(projectDir, loopId);
        if (!meta) return { ok: false, error: `Design loop not found: ${loopId}` };
        const source =
          sourceFilename?.trim() || pinnedLogoFilename(projectDir, loopId);
        if (!source) {
          return {
            ok: false,
            error:
              "sourceFilename required (or pin a logo first via selections API)",
          };
        }
        const result = await circularMaskDesignAsset({
          projectRoot: projectDir,
          loopId,
          sourceFilename: source,
          filename,
        });
        const outName = basenameSafe(result.relativePath);
        pinDesignLoopLogoAsset({
          projectRoot: projectDir,
          loopId,
          asset: outName,
          label: `Circular cut-out (${outName})`,
        });
        return {
          ok: true,
          ...result,
          pinnedLogo: outName,
          hint: `Pinned logo → ${outName}. Embed <img src="${result.relativePath}"> — circular RGBA from ${result.sourceFilename}.`,
        };
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
  });

  const derive_icon_pack = createTool({
    id: "derive_icon_pack",
    description:
      "Deterministic resize of an EXISTING asset into favicon/icon sizes (16–512). Never uses Flux. Default source = pinned logo.",
    inputSchema: z.object({
      loopId: z.string().min(1),
      sourceFilename: z.string().optional(),
      sizes: z.array(z.number().int().positive()).optional(),
      prefix: z.string().optional(),
    }),
    execute: async ({ loopId, sourceFilename, sizes, prefix }) => {
      try {
        const meta = readDesignLoopMeta(projectDir, loopId);
        if (!meta) return { ok: false, error: `Design loop not found: ${loopId}` };
        const pinned = pinnedLogoFilename(projectDir, loopId);
        const result = await deriveIconPackFromAsset({
          projectRoot: projectDir,
          loopId,
          sourceFilename: sourceFilename?.trim() || undefined,
          preferredFilename: pinned,
          sizes,
          prefix,
        });
        return {
          ok: true,
          ...result,
          hint: `Source ${result.sourceFilename}${
            result.redirectedFrom
              ? ` (redirected from fake/opaque ${result.redirectedFrom})`
              : ""
          }. Keep primary logo pinned; use pack files for favicons. Do not generate_image.`,
        };
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
  });

  const resize_image = createTool({
    id: "resize_image",
    description: "Deterministic resize of an existing loop asset.",
    inputSchema: z.object({
      loopId: z.string().min(1),
      sourceFilename: z.string().min(1),
      width: z.number().int().positive(),
      height: z.number().int().positive().optional(),
      filename: z.string().optional(),
    }),
    execute: async ({ loopId, sourceFilename, width, height, filename }) => {
      try {
        const meta = readDesignLoopMeta(projectDir, loopId);
        if (!meta) return { ok: false, error: `Design loop not found: ${loopId}` };
        const result = await resizeDesignAsset({
          projectRoot: projectDir,
          loopId,
          sourceFilename,
          width,
          height,
          filename,
        });
        return { ok: true, ...result };
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
  });

  const trim_image = createTool({
    id: "trim_image",
    description: "Trim empty/transparent margins from an existing loop asset.",
    inputSchema: z.object({
      loopId: z.string().min(1),
      sourceFilename: z.string().min(1),
      filename: z.string().optional(),
    }),
    execute: async ({ loopId, sourceFilename, filename }) => {
      try {
        const meta = readDesignLoopMeta(projectDir, loopId);
        if (!meta) return { ok: false, error: `Design loop not found: ${loopId}` };
        const result = await trimDesignAsset({
          projectRoot: projectDir,
          loopId,
          sourceFilename,
          filename,
        });
        return { ok: true, ...result };
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
  });

  const pad_image = createTool({
    id: "pad_image",
    description:
      "Center an existing asset on a transparent square canvas (e.g. pad to 512).",
    inputSchema: z.object({
      loopId: z.string().min(1),
      sourceFilename: z.string().min(1),
      size: z.number().int().positive(),
      filename: z.string().optional(),
    }),
    execute: async ({ loopId, sourceFilename, size, filename }) => {
      try {
        const meta = readDesignLoopMeta(projectDir, loopId);
        if (!meta) return { ok: false, error: `Design loop not found: ${loopId}` };
        const result = await padDesignAsset({
          projectRoot: projectDir,
          loopId,
          sourceFilename,
          size,
          filename,
        });
        return { ok: true, ...result };
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
  });

  const search_images = createTool({
    id: "search_images",
    description:
      "Search Openverse (open-licensed Wikimedia/Flickr CC/museums) for reference or stock images. Returns id/title/license — then import_image with an id.",
    inputSchema: z.object({
      loopId: z.string().min(1),
      query: z.string().min(1),
      source: z.string().optional(),
      pageSize: z.number().int().positive().max(20).optional(),
    }),
    execute: async ({ loopId, query, source, pageSize }) => {
      try {
        const meta = readDesignLoopMeta(projectDir, loopId);
        if (!meta) return { ok: false, error: `Design loop not found: ${loopId}` };
        const hits = await searchDesignImages({
          query,
          source,
          pageSize: pageSize ?? 8,
        });
        return {
          ok: true,
          loopId,
          count: hits.length,
          hits: hits.map((h) => ({
            id: h.id,
            title: h.title,
            license: h.license,
            creator: h.creator,
            source: h.source,
            thumbnail: h.thumbnail,
            attribution: h.attribution,
          })),
          hint: "Pick an id and call import_image to materialize into loop assets.",
        };
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
  });

  const import_image = createTool({
    id: "import_image",
    description:
      "Import an Openverse image id into the design-loop assets folder (with attribution sidecar).",
    inputSchema: z.object({
      loopId: z.string().min(1),
      openverseId: z.string().min(1),
      filename: z.string().optional(),
    }),
    execute: async ({ loopId, openverseId, filename }) => {
      try {
        const meta = readDesignLoopMeta(projectDir, loopId);
        if (!meta) return { ok: false, error: `Design loop not found: ${loopId}` };
        const result = await importDesignImageById({
          projectRoot: projectDir,
          loopId,
          openverseId,
          filename,
        });
        return {
          ok: true,
          relativePath: result.relativePath,
          attribution: result.hit.attribution,
          license: result.hit.license,
          hint:
            `Embed as <img src="${result.relativePath}"> (preview rewrites to HTTP) and cite attribution in NOTES.`,
        };
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
  });

  const review_look = createTool({
    id: "review_look",
    description:
      "Screenshot the current mock.html and critique look-and-feel via designVision. Call after meaningful layout/palette changes.",
    inputSchema: z.object({
      loopId: z.string().min(1),
      version: z.number().int().positive().optional(),
    }),
    execute: async ({ loopId, version }) => {
      try {
        const meta = readDesignLoopMeta(projectDir, loopId);
        if (!meta) return { ok: false, error: `Design loop not found: ${loopId}` };
        const vision = registry.tryResolveDesignVision();
        if (!vision) {
          return {
            ok: false,
            error:
              "designVision unbound — bind roles.designVision to a vision-capable model",
          };
        }
        const v = version ?? meta.currentVersion;
        if (!v || v < 1) {
          return { ok: false, error: "No mock version to review yet" };
        }
        const result = await reviewDesignLoopLook({
          projectRoot: projectDir,
          loopId,
          version: v,
          brief: meta.brief,
          visionEndpoint: vision.endpoint,
          visionModelId: vision.modelId,
        });
        return {
          ok: true,
          version: v,
          critique: result.critique,
          previewPath: result.previewPath,
          reviewPath: result.reviewPath,
        };
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
  });

  return {
    generate_image,
    pin_logo,
    edit_image,
    make_transparent,
    circular_mask,
    derive_icon_pack,
    resize_image,
    trim_image,
    pad_image,
    search_images,
    import_image,
    review_look,
  };
}
