import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  buildLiveSiteInventory,
  extractNavLinksFromSource,
  formatLiveSiteInventoryPromptBlock,
  patchMockNavFromInventory,
  readLiveSiteInventory,
  summarizeLiveSiteInventory,
  writeLiveSiteInventory,
} from "./live-site-inventory.js";

describe("live-site-inventory", () => {
  it("extracts navLinks array from header source", () => {
    const body = `
const navLinks = [
  { href: "/services", label: "Services" },
  { href: "/work", label: "Work" },
  { href: "/about", label: "About" },
  { href: "/blog", label: "Insights" },
  { href: "/contact", label: "Contact" },
];
`;
    const { nav } = extractNavLinksFromSource("src/components/layout/header.tsx", body);
    assert.deepEqual(
      nav.map((n) => n.label),
      ["Services", "Work", "About", "Insights", "Contact"],
    );
    assert.equal(nav[0]?.href, "/services");
    assert.equal(nav[0]?.source, "src/components/layout/header.tsx");
  });

  it("buildLiveSiteInventory finds header navLinks in a fixture project", () => {
    const root = mkdtempSync(join(tmpdir(), "live-site-inv-"));
    const headerDir = join(root, "src", "components", "layout");
    mkdirSync(headerDir, { recursive: true });
    writeFileSync(
      join(headerDir, "header.tsx"),
      `const navLinks = [
  { href: "/services", label: "Services" },
  { href: "/work", label: "Work" },
  { href: "/about", label: "About" },
  { href: "/blog", label: "Insights" },
  { href: "/contact", label: "Contact" },
];
export function Header() { return null; }
`,
      "utf-8",
    );
    mkdirSync(join(root, "src", "app", "services"), { recursive: true });
    writeFileSync(join(root, "src", "app", "services", "page.tsx"), "export default function P(){}", "utf-8");

    const inv = buildLiveSiteInventory(root);
    assert.deepEqual(
      inv.nav.map((n) => n.label),
      ["Services", "Work", "About", "Insights", "Contact"],
    );
    assert.ok(inv.routes.includes("/services"));
    assert.match(inv.nav[0]?.source ?? "", /header\.tsx$/);
  });

  it("patchMockNavFromInventory updates topbar only", () => {
    const prev = `<!DOCTYPE html><html><body>
<header>
  <ul class="topbar-nav">
    <li><a href="#">Dashboard</a></li>
    <li><a href="#">Roasts</a></li>
  </ul>
</header>
<div class="dashboard-shell"><aside>sidebar</aside></div>
<h1>Craft Roasting</h1>
</body></html>`;
    const out = patchMockNavFromInventory(prev, [
      { label: "Services", href: "/services", source: "header.tsx" },
      { label: "Work", href: "/work", source: "header.tsx" },
      { label: "About", href: "/about", source: "header.tsx" },
    ]);
    assert.match(out, /Services/);
    assert.match(out, /href="\/services"/);
    assert.match(out, /Work/);
    assert.doesNotMatch(out, /Dashboard/);
    assert.match(out, /dashboard-shell/);
    assert.match(out, /Craft Roasting/);
  });

  it("formatLiveSiteInventoryPromptBlock includes nav + token excerpt", () => {
    const block = formatLiveSiteInventoryPromptBlock({
      projectRoot: "/proj",
      nav: [
        { label: "Services", href: "/services", source: "src/components/layout/header.tsx" },
        { label: "Work", href: "/work", source: "src/components/layout/header.tsx" },
      ],
      ctaLinks: [],
      routes: ["/", "/services"],
      tokenFiles: ["src/app/globals.css"],
      tokenExcerpt: ":root { --brand: #E8430A; }",
      publicAssets: [],
      logoPaths: ["public/images/logo.svg"],
      landingCues: "",
      shellHints: ["src/components/layout/header.tsx"],
      screens: [],
      entities: [],
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    assert.match(block, /LIVE SITE/);
    assert.match(block, /Services/);
    assert.match(block, /--brand/);
    assert.match(block, /authoritative/);
  });

  it("buildLiveSiteInventory extracts screens + entities and is read-only on source", () => {
    const root = mkdtempSync(join(tmpdir(), "live-site-screens-"));
    const headerDir = join(root, "src", "components", "layout");
    const invoicesDir = join(root, "src", "app", "dashboard", "invoices");
    const typesDir = join(root, "src", "types");
    mkdirSync(headerDir, { recursive: true });
    mkdirSync(invoicesDir, { recursive: true });
    mkdirSync(typesDir, { recursive: true });
    writeFileSync(
      join(headerDir, "header.tsx"),
      `const navLinks = [
  { href: "/dashboard/invoices", label: "Invoices" },
];
export function Header() { return null; }
`,
      "utf-8",
    );
    writeFileSync(
      join(invoicesDir, "page.tsx"),
      `export default function Page() {
  return (
    <div>
      <h1>Invoices</h1>
      <table><thead><tr><th>Number</th><th>Client</th><th>Total</th></tr></thead></table>
      <label>Client name</label>
      <Button>Create invoice</Button>
    </div>
  );
}
`,
      "utf-8",
    );
    writeFileSync(
      join(typesDir, "models.ts"),
      `export interface Invoice {
  id: string;
  number: string;
  client: string;
  total: number;
}
`,
      "utf-8",
    );

    const before = readdirSync(root, { recursive: true }).map(String).sort();
    const inv = buildLiveSiteInventory(root);
    const after = readdirSync(root, { recursive: true }).map(String).sort();
    assert.deepEqual(after, before, "buildLiveSiteInventory must not write source tree");

    const screen = inv.screens.find((s) => s.route === "/dashboard/invoices");
    assert.ok(screen);
    assert.ok(screen!.headings.includes("Invoices"));
    assert.deepEqual(screen!.tableColumns, ["Number", "Client", "Total"]);
    assert.ok(screen!.formFields.includes("Client name"));
    assert.ok(screen!.buttons.includes("Create invoice"));
    const entity = inv.entities.find((e) => e.name === "Invoice");
    assert.ok(entity?.fields.includes("number"));
  });

  it("prompt block includes screen content + domain entities; omits landing when / screen exists", () => {
    const block = formatLiveSiteInventoryPromptBlock({
      projectRoot: "/proj",
      nav: [],
      ctaLinks: [],
      routes: ["/", "/dashboard/invoices"],
      tokenFiles: [],
      tokenExcerpt: "",
      publicAssets: [],
      logoPaths: [],
      landingCues: "ShouldNotAppearWhenRootScreenPresent",
      shellHints: [],
      screens: [
        {
          route: "/",
          source: "src/app/page.tsx",
          headings: ["Portal"],
          buttons: ["Sign in"],
          tableColumns: [],
          formFields: [],
          copy: ["Welcome back"],
        },
        {
          route: "/dashboard/invoices",
          source: "src/app/dashboard/invoices/page.tsx",
          headings: ["Invoices"],
          buttons: ["Create invoice"],
          tableColumns: ["Number", "Client", "Total"],
          formFields: ["Client name"],
          copy: [],
        },
      ],
      entities: [
        {
          name: "Invoice",
          source: "src/types/models.ts",
          fields: ["number", "client", "status", "total", "dueDate"],
        },
      ],
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    assert.match(block, /Screen content/);
    assert.match(block, /\/dashboard\/invoices/);
    assert.match(block, /columns: Number, Client, Total/);
    assert.match(block, /Domain entities/);
    assert.match(block, /Invoice: number, client, status, total, dueDate/);
    assert.doesNotMatch(block, /ShouldNotAppearWhenRootScreenPresent/);
    assert.doesNotMatch(block, /Landing copy cues/);
  });

  it("summarizeLiveSiteInventory stays lean (counts, not full copy)", () => {
    const summary = summarizeLiveSiteInventory({
      projectRoot: "/proj",
      nav: [{ label: "Invoices", href: "/dashboard/invoices", source: "header.tsx" }],
      ctaLinks: [],
      routes: ["/dashboard/invoices"],
      tokenFiles: [],
      tokenExcerpt: ":root{}",
      publicAssets: [],
      logoPaths: [],
      landingCues: "secret landing",
      shellHints: [],
      screens: [
        {
          route: "/dashboard/invoices",
          source: "page.tsx",
          headings: ["Invoices"],
          buttons: ["Create"],
          tableColumns: ["Number", "Client"],
          formFields: ["Client name"],
          copy: ["Do not leak this into summary"],
        },
      ],
      entities: [{ name: "Invoice", source: "models.ts", fields: ["number"] }],
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    assert.equal(summary.entityCount, 1);
    assert.equal(summary.screens[0]?.route, "/dashboard/invoices");
    assert.equal(summary.screens[0]?.headingCount, 1);
    assert.equal(summary.screens[0]?.fieldCount, 3);
    assert.equal(summary.screens[0]?.buttonCount, 1);
    assert.equal(
      JSON.stringify(summary).includes("Do not leak this into summary"),
      false,
    );
    assert.equal(JSON.stringify(summary).includes("secret landing"), false);
  });

  it("write/read round-trip persists screens; old JSON defaults screens/entities to []", () => {
    const root = mkdtempSync(join(tmpdir(), "live-site-roundtrip-"));
    mkdirSync(join(root, "src", "app"), { recursive: true });
    writeFileSync(
      join(root, "src", "app", "page.tsx"),
      "export default function Home(){return <h1>Home</h1>}",
      "utf-8",
    );
    const inv = buildLiveSiteInventory(root);
    writeLiveSiteInventory(root, "dl_test", inv);
    const read = readLiveSiteInventory(root, "dl_test");
    assert.ok(read);
    assert.ok(Array.isArray(read!.screens));
    assert.ok(Array.isArray(read!.entities));
    assert.ok(read!.screens.some((s) => s.route === "/"));

    // Simulate older SITE_INVENTORY.json without screens/entities.
    const path = join(root, ".slopcontrol", "design-loops", "dl_old", "SITE_INVENTORY.json");
    mkdirSync(join(root, ".slopcontrol", "design-loops", "dl_old"), {
      recursive: true,
    });
    writeFileSync(
      path,
      JSON.stringify({
        projectRoot: root,
        nav: [],
        ctaLinks: [],
        routes: ["/"],
        tokenFiles: [],
        tokenExcerpt: "",
        publicAssets: [],
        logoPaths: [],
        landingCues: "",
        shellHints: [],
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
      "utf-8",
    );
    const old = readLiveSiteInventory(root, "dl_old");
    assert.ok(old);
    assert.deepEqual(old!.screens, []);
    assert.deepEqual(old!.entities, []);
    // Ensure we actually wrote something for the new loop.
    const raw = readFileSync(
      join(root, ".slopcontrol", "design-loops", "dl_test", "SITE_INVENTORY.json"),
      "utf-8",
    );
    assert.match(raw, /"screens"/);
  });
});
