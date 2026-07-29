import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  detectCodingProbeAbuse,
  detectCodingProbeAbuseFromEvents,
  extractBashCommandsFromEvents,
} from "./probe-abuse.js";

describe("detectCodingProbeAbuse", () => {
  it("flags bearer curl probes to cloud hosts", () => {
    const msg = detectCodingProbeAbuse(
      'curl -s -H "Authorization: Bearer abc.def" https://api.ollama.cloud/v1/chat',
    );
    assert.ok(msg);
    assert.match(msg!, /Bearer|secret probe/i);
  });

  it("allows bearer curl to local Docker/Ollama hosts", () => {
    assert.equal(
      detectCodingProbeAbuse(
        'curl -s -H "Authorization: Bearer $OLLAMA_API_KEY" http://127.0.0.1:11435/v1/chat/completions',
      ),
      null,
    );
    assert.equal(
      detectCodingProbeAbuse(
        'curl -s -H "Authorization: Bearer x" http://localhost:11434/api/tags',
      ),
      null,
    );
    assert.equal(
      detectCodingProbeAbuse(
        'curl -s -H "Authorization: Bearer x" http://ollama:11434/v1/chat/completions',
      ),
      null,
    );
    assert.equal(
      detectCodingProbeAbuse(
        'curl -s -H "Authorization: Bearer x" http://host.docker.internal:11434/v1/chat',
      ),
      null,
    );
  });

  it("does not flag assistant prose that mentions Bearer curl", () => {
    const prose =
      'Do not curl with Authorization: Bearer against cloud APIs; edit docker-compose.yml instead.';
    assert.equal(detectCodingProbeAbuse(prose), null);
  });

  it("flags sleep+curl loops", () => {
    assert.ok(detectCodingProbeAbuse("sleep 30 && curl https://example.com"));
  });

  it("flags real curl to Ollama Cloud chat/models", () => {
    const msg = detectCodingProbeAbuse(
      "curl -s https://api.ollama.cloud/v1/chat/completions -d '{}'",
    );
    assert.ok(msg);
    assert.match(msg!, /Ollama Cloud/i);
  });

  it("allows normal test output", () => {
    assert.equal(detectCodingProbeAbuse("npm test\n✓ all good"), null);
  });

  it("does not false-positive on PHASE.md URL + APPENDIX curl prose", () => {
    const phaseAndAppendix = `
# Phase 15: Restore Paid-Tier Ollama Cloud Configuration
URL: https://api.ollama.cloud/v1/chat/completions
Model: minimax-m3:cloud
Turn produced no git changes. Shrink scope; fix transport; edit PHASE.md files only — do not curl live APIs.
Do not curl live APIs. Abort and rely on local Automated Checks.
`;
    assert.equal(detectCodingProbeAbuse(phaseAndAppendix), null);
  });

  it("does not flag docs that mention curl and cloud URL separately without invocation", () => {
    const prose =
      "Never use curl. The error was at https://api.ollama.cloud/v1/chat/completions.";
    assert.equal(detectCodingProbeAbuse(prose), null);
  });
});

describe("extractBashCommandsFromEvents", () => {
  it("pulls command fields from OpenCode event JSON", () => {
    const blob = JSON.stringify({
      type: "message.part.updated",
      part: {
        tool: "bash",
        state: { input: { command: "cat .env.docker; ls -la" } },
      },
    });
    const cmds = extractBashCommandsFromEvents(blob);
    assert.match(cmds, /cat \.env\.docker/);
  });

  it("detects probe only from bash command, not system echo", () => {
    const systemEcho = JSON.stringify({
      type: "message.updated",
      info: {
        system:
          "PHASE.md\nURL: https://api.ollama.cloud/v1/chat/completions\ndo not curl live APIs",
      },
    });
    assert.equal(detectCodingProbeAbuseFromEvents(systemEcho), null);

    const bashProbe = JSON.stringify({
      type: "message.part.updated",
      part: {
        tool: "bash",
        state: {
          input: {
            command:
              'curl -H "Authorization: Bearer x" https://api.ollama.cloud/v1/chat',
          },
        },
      },
    });
    assert.ok(detectCodingProbeAbuseFromEvents(bashProbe));
  });

  it("does not fall through OpenCode event JSON when no bash commands", () => {
    const blob = JSON.stringify({
      type: "message.updated",
      info: {
        text: 'I will curl -H "Authorization: Bearer secret" https://api.ollama.cloud/v1/chat',
      },
    });
    assert.equal(detectCodingProbeAbuseFromEvents(blob), null);
  });

  it("allows local bearer bash from events", () => {
    const bashLocal = JSON.stringify({
      type: "message.part.updated",
      part: {
        tool: "bash",
        state: {
          input: {
            command:
              'curl -H "Authorization: Bearer $OLLAMA_API_KEY" http://127.0.0.1:11435/v1/chat/completions',
          },
        },
      },
    });
    assert.equal(detectCodingProbeAbuseFromEvents(bashLocal), null);
  });
});
