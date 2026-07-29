import type { LlmEndpoint } from "@slopcontrol/types";

/** True when the endpoint may receive image attachments in chat. */
export function endpointSupportsVision(endpoint: LlmEndpoint): boolean {
  return endpoint.capabilities?.vision === true;
}

/** True when the endpoint can generate raster images. */
export function endpointSupportsImageGen(endpoint: LlmEndpoint): boolean {
  return (
    endpoint.capabilities?.imageGen === true ||
    endpoint.apiType === "openai-images"
  );
}

/**
 * Refuse multimodal chat when the model is not vision-capable
 * (e.g. never attach images to glm-5.2).
 */
export function assertVisionCapable(endpoint: LlmEndpoint): void {
  if (!endpointSupportsVision(endpoint)) {
    throw new Error(
      `Endpoint "${endpoint.id}" (model ${endpoint.modelId}) does not support vision. ` +
        `Bind designVision to a vision-capable model (capabilities.vision: true) such as kimi-k2.7-code. ` +
        `Never attach images to text-only models like glm-5.2.`,
    );
  }
}
