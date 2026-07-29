import { z } from "zod";

export const HealthCheckSchema = z.object({
  http: z.string().url(),
});

export type HealthCheck = z.infer<typeof HealthCheckSchema>;

export const ServiceSpecSchema = z.object({
  port: z.number().int().positive().optional(),
  command: z.array(z.string().min(1)).min(1),
  health: HealthCheckSchema,
  enabled: z.boolean().optional(),
});

export type ServiceSpec = z.infer<typeof ServiceSpecSchema>;

export const OpenCodeEngineSchema = z.object({
  port: z.number().int().positive().default(4096),
  hostname: z.string().min(1).default("127.0.0.1"),
  enableExa: z.boolean().default(true),
  command: z.array(z.string().min(1)).min(1).optional(),
  health: HealthCheckSchema.optional(),
});

export type OpenCodeEngine = z.infer<typeof OpenCodeEngineSchema>;

export const CodingConfigSchema = z.object({
  engine: z.string().min(1).default("opencode"),
  /** shared = one OpenCode :4096; per_project = one daemon per project (lazy ports 4100+) */
  mode: z.enum(["shared", "per_project"]).default("per_project"),
  opencode: OpenCodeEngineSchema.optional(),
});

export type CodingConfig = z.infer<typeof CodingConfigSchema>;

export const SlopcontrolYamlSchema = z.object({
  version: z.literal(1).default(1),
  server: ServiceSpecSchema.extend({
    port: z.number().int().positive().default(3020),
    command: z
      .array(z.string().min(1))
      .min(1)
      .default(["pnpm", "--filter", "@slopcontrol/server", "dev"]),
    health: HealthCheckSchema.default({
      http: "http://127.0.0.1:3020/health",
    }),
  }).default({
    port: 3020,
    command: ["pnpm", "--filter", "@slopcontrol/server", "dev"],
    health: { http: "http://127.0.0.1:3020/health" },
  }),
  web: ServiceSpecSchema.extend({
    enabled: z.boolean().default(false),
    port: z.number().int().positive().default(3021),
    command: z
      .array(z.string().min(1))
      .min(1)
      .default(["pnpm", "--filter", "@slopcontrol/web", "dev"]),
    health: HealthCheckSchema.default({
      http: "http://127.0.0.1:3021",
    }),
  })
    .default({
      enabled: false,
      port: 3021,
      command: ["pnpm", "--filter", "@slopcontrol/web", "dev"],
      health: { http: "http://127.0.0.1:3021" },
    })
    .optional(),
  coding: CodingConfigSchema.default({ engine: "opencode", mode: "per_project" }),
});

export type SlopcontrolYaml = z.infer<typeof SlopcontrolYamlSchema>;

/** Default YAML written by `slopcontrol init` (with comments stripped at parse). */
export const DEFAULT_SLOPCONTROL_YAML = `version: 1

# How to run the SlopControl stack (server + coding engine).
# Per-target-project settings stay in <project>/.slopcontrol/config.json
# LLM endpoints stay in ~/.slopcontrol/endpoints.json

server:
  port: 3020
  command: ["pnpm", "--filter", "@slopcontrol/server", "dev"]
  health: { http: "http://127.0.0.1:3020/health" }

web:
  enabled: false
  port: 3021
  command: ["pnpm", "--filter", "@slopcontrol/web", "dev"]
  health: { http: "http://127.0.0.1:3021" }

coding:
  engine: opencode          # must match coding-tools registry id
  mode: per_project         # shared = one :4096; per_project = lazy OpenCode per project (ports 4100+)
  opencode:
    port: 4096
    hostname: "127.0.0.1"
    enableExa: true
    # optional command override:
    # command: ["opencode", "serve", "--port", "4096", "--hostname", "127.0.0.1"]
    health: { http: "http://127.0.0.1:4096/global/health" }
`;
