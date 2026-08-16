import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildDevelopCodingRetryPrompt,
  resolveDevelopCodingRetryKind,
} from "./coding-retry-prompt.js";

describe("develop coding retry prompt", () => {
  it("routes long-lived latest diagnosis over stale host-utility APPENDIX", () => {
    const kind = resolveDevelopCodingRetryKind({
      phaseId: "06-demo",
      title: "Broken Automated Check (long-lived server)",
      tags: ["automated-checks", "long-lived", "phase-doc"],
      nextActions:
        "Edit PHASE.md ## Automated Checks: remove long-lived servers",
      appendixFallback: `## Failure diagnosis
Missing host utility (timeout)
timeout: command not found
replace with background process + sleep/kill`,
    });
    assert.equal(kind, "long-lived");
    const prompt = buildDevelopCodingRetryPrompt({
      phaseId: "06-demo",
      title: "Broken Automated Check (long-lived server)",
      tags: ["long-lived"],
      appendixFallback: "timeout: command not found background process + sleep/kill",
    });
    assert.match(prompt, /long-lived|finite structural/i);
    assert.doesNotMatch(prompt, /background process \+ sleep\/kill/i);
  });

  it("host-utility prompt forbids background sleep/kill", () => {
    const prompt = buildDevelopCodingRetryPrompt({
      phaseId: "06-demo",
      title: "Missing host utility in Automated Check (`timeout`)",
      tags: ["host-utility", "macos-portability"],
    });
    assert.match(prompt, /host utility|timeout/i);
    assert.match(prompt, /finite structural/i);
    assert.doesNotMatch(prompt, /background process \+ sleep\/kill/i);
    assert.doesNotMatch(prompt, /Node\/perl wait/i);
  });

  it("falls back to appendix only when no latest diagnosis", () => {
    const kind = resolveDevelopCodingRetryKind({
      phaseId: "06-demo",
      appendixFallback: "timeout: command not found — Missing host utility",
    });
    assert.equal(kind, "host-utility");
  });

  it("CHECK_TIMEOUT tags route to long-lived", () => {
    assert.equal(
      resolveDevelopCodingRetryKind({
        phaseId: "x",
        title: "Broken Automated Check (exceeded wall clock)",
        tags: ["check-timeout", "long-lived"],
      }),
      "long-lived",
    );
  });
});

describe("prior failure history in retry prompts", () => {
  it("renders the history block when prior diagnoses exist", () => {
    const prompt = buildDevelopCodingRetryPrompt({
      phaseId: "06-demo",
      title: "Broken Automated Check shell",
      tags: ["process-shell"],
      priorDiagnoses: [
        "[fp-1] process: Docker 401 — rootCause: env_file override — resolution: fix compose",
        "[fp-2] infra: ECONNREFUSED — rootCause: db down — resolution: compose up",
      ],
    });
    assert.match(prompt, /Prior failure history \(most recent first\)/);
    assert.match(prompt, /- \[fp-1\] process: Docker 401/);
    assert.match(prompt, /- \[fp-2\] infra: ECONNREFUSED/);
    // History appears before the diagnosis body
    assert.ok(
      prompt.indexOf("Prior failure history") <
        prompt.indexOf("Fix the APPENDIX Failure diagnosis"),
    );
  });

  it("omits the history block when no prior diagnoses", () => {
    const prompt = buildDevelopCodingRetryPrompt({
      phaseId: "06-demo",
      title: "Broken Automated Check shell",
      tags: ["process-shell"],
      priorDiagnoses: [],
    });
    assert.doesNotMatch(prompt, /Prior failure history/);
  });

  it("omits the history block when priorDiagnoses is undefined", () => {
    const prompt = buildDevelopCodingRetryPrompt({
      phaseId: "06-demo",
      title: "Broken Automated Check shell",
      tags: ["process-shell"],
    });
    assert.doesNotMatch(prompt, /Prior failure history/);
  });
});
