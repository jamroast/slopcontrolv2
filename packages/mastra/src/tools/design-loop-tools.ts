import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import {
  generateDesignImage,
  importDesignImageById,
  reviewDesignLoopLook,
  searchDesignImages,
} from "@slopcontrol/coding-tools";
import {
  readDesignLoopMeta,
} from "@slopcontrol/artifacts";
import type { LlmRegistry } from "@slopcontrol/llm";

export function createDesignLoopMediaTools(
  projectDir: string,
  registry: LlmRegistry,
) {
  const generate_image = createTool({
    id: "generate_image",
    description:
      "Generate a raster image (logo/icon/hero) via designImage (Flux). Requires loopId. Prefer for brand marks; use search_images for stock photos.",
    inputSchema: z.object({
      loopId: z.string().min(1),
      prompt: z.string().min(1),
      filename: z.string().optional(),
      width: z.number().int().positive().optional(),
      height: z.number().int().positive().optional(),
    }),
    execute: async ({ loopId, prompt, filename, width, height }) => {
      try {
        const meta = readDesignLoopMeta(projectDir, loopId);
        if (!meta) return { ok: false, error: `Design loop not found: ${loopId}` };
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
          hint: `Embed in mock as <img src="${result.relativePath}"> (or note path for operator).`,
        };
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
          hint: `Embed as <img src="${result.relativePath}"> and cite attribution in NOTES.`,
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
    search_images,
    import_image,
    review_look,
  };
}
