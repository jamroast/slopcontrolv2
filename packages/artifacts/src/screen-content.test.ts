import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  buildScreenContentInventory,
  collectRouteFiles,
  extractEntityFieldsFromSource,
  extractScreenContentFromSource,
  routeFromPageFile,
} from "./screen-content.js";

describe("screen-content extractors", () => {
  it("extracts headings, table columns, form fields, and buttons from JSX", () => {
    const body = `
export default function InvoicesPage() {
  return (
    <div>
      <h1>Invoices</h1>
      <h2>Open balances</h2>
      <p>Track what clients owe you this month.</p>
      <table>
        <thead>
          <tr>
            <th>Number</th>
            <th>Client</th>
            <th>Status</th>
            <th>Total</th>
            <th>Due date</th>
          </tr>
        </thead>
      </table>
      <form>
        <label>Client name</label>
        <input placeholder="Acme Roasters" />
        <label>Amount</label>
        <Button>Create invoice</Button>
      </form>
    </div>
  );
}
`;
    const screen = extractScreenContentFromSource(
      "src/app/dashboard/invoices/page.tsx",
      body,
      "/dashboard/invoices",
    );
    assert.deepEqual(screen.headings, ["Invoices", "Open balances"]);
    assert.deepEqual(screen.tableColumns, [
      "Number",
      "Client",
      "Status",
      "Total",
      "Due date",
    ]);
    assert.ok(screen.formFields.includes("Client name"));
    assert.ok(screen.formFields.includes("Amount"));
    assert.ok(screen.formFields.includes("Acme Roasters"));
    assert.ok(screen.buttons.includes("Create invoice"));
    assert.ok(
      screen.copy.some((c) => /Track what clients owe/i.test(c)),
      `expected supporting copy, got ${JSON.stringify(screen.copy)}`,
    );
  });

  it("extracts entity fields from interface, zod, and prisma", () => {
    const tsBody = `
export interface Invoice {
  id: string;
  number: string;
  client: string;
  status: "draft" | "sent" | "paid";
  total: number;
  dueDate: string;
}

export type Client = {
  id: string;
  name: string;
  email: string;
};

export const InvoiceSchema = z.object({
  number: z.string(),
  clientId: z.string(),
  total: z.number(),
  dueDate: z.string(),
});
`;
    const fromTs = extractEntityFieldsFromSource("src/types/invoice.ts", tsBody);
    const invoice = fromTs.find((e) => e.name === "Invoice");
    assert.ok(invoice);
    assert.ok(invoice!.fields.includes("number"));
    assert.ok(invoice!.fields.includes("client"));
    assert.ok(invoice!.fields.includes("dueDate"));
    const client = fromTs.find((e) => e.name === "Client");
    assert.ok(client?.fields.includes("email"));
    const zod = fromTs.find((e) => e.name === "InvoiceSchema");
    assert.ok(zod?.fields.includes("clientId"));

    const prisma = `
model Invoice {
  id        String   @id
  number    String
  client    String
  status    String
  total     Decimal
  dueDate   DateTime
  createdAt DateTime @default(now())
}
`;
    const fromPrisma = extractEntityFieldsFromSource(
      "prisma/schema.prisma",
      prisma,
    );
    const inv = fromPrisma.find((e) => e.name === "Invoice");
    assert.ok(inv);
    assert.ok(inv!.fields.includes("number"));
    assert.ok(inv!.fields.includes("dueDate"));
    assert.ok(inv!.fields.includes("total"));
  });

  it("routeFromPageFile maps groups and dynamic segments", () => {
    const root = "/proj";
    assert.equal(
      routeFromPageFile(root, "src/app/(dashboard)/invoices/page.tsx"),
      "/invoices",
    );
    assert.equal(
      routeFromPageFile(root, "src/app/clients/[id]/page.tsx"),
      "/clients/:param",
    );
    assert.equal(routeFromPageFile(root, "src/app/page.tsx"), "/");
    assert.equal(routeFromPageFile(root, "src/app/api/health/route.ts"), null);
  });
});

describe("screen-content builder", () => {
  it("one-hop import pulls table columns into the parent route", () => {
    const root = mkdtempSync(join(tmpdir(), "screen-content-hop-"));
    const pageDir = join(root, "src", "app", "dashboard", "invoices");
    mkdirSync(pageDir, { recursive: true });
    writeFileSync(
      join(pageDir, "page.tsx"),
      `import { InvoicesTable } from "./InvoicesTable";
export default function Page() {
  return (
    <div>
      <h1>Invoices</h1>
      <InvoicesTable />
      <Button>New invoice</Button>
    </div>
  );
}
`,
      "utf-8",
    );
    writeFileSync(
      join(pageDir, "InvoicesTable.tsx"),
      `export function InvoicesTable() {
  return (
    <table>
      <thead>
        <tr>
          <th>Number</th>
          <th>Client</th>
          <th>Status</th>
          <th>Total</th>
        </tr>
      </thead>
    </table>
  );
}
`,
      "utf-8",
    );

    const { screens } = buildScreenContentInventory(root);
    const inv = screens.find((s) => s.route === "/dashboard/invoices");
    assert.ok(inv, `expected /dashboard/invoices screen, got ${screens.map((s) => s.route)}`);
    assert.ok(inv!.headings.includes("Invoices"));
    assert.deepEqual(inv!.tableColumns, ["Number", "Client", "Status", "Total"]);
    assert.ok(inv!.buttons.includes("New invoice"));
  });

  it("collectRouteFiles lists routes from page.tsx files", () => {
    const root = mkdtempSync(join(tmpdir(), "screen-routes-"));
    mkdirSync(join(root, "src", "app", "(app)", "clients", "[id]"), {
      recursive: true,
    });
    writeFileSync(
      join(root, "src", "app", "page.tsx"),
      "export default function Home(){return <h1>Home</h1>}",
      "utf-8",
    );
    writeFileSync(
      join(root, "src", "app", "(app)", "clients", "[id]", "page.tsx"),
      "export default function C(){return <h1>Client</h1>}",
      "utf-8",
    );
    const routes = collectRouteFiles(root).map((r) => r.route);
    assert.ok(routes.includes("/"));
    assert.ok(routes.includes("/clients/:param"));
  });

  it("buildScreenContentInventory extracts entities from types + prisma", () => {
    const root = mkdtempSync(join(tmpdir(), "screen-entities-"));
    mkdirSync(join(root, "src", "types"), { recursive: true });
    mkdirSync(join(root, "prisma"), { recursive: true });
    mkdirSync(join(root, "src", "app"), { recursive: true });
    writeFileSync(
      join(root, "src", "app", "page.tsx"),
      "export default function Home(){return <h1>Portal</h1>}",
      "utf-8",
    );
    writeFileSync(
      join(root, "src", "types", "models.ts"),
      `export interface Invoice {
  id: string;
  number: string;
  client: string;
  total: number;
}
`,
      "utf-8",
    );
    writeFileSync(
      join(root, "prisma", "schema.prisma"),
      `model Client {
  id    String @id
  name  String
  email String
}
`,
      "utf-8",
    );

    const { entities, screens } = buildScreenContentInventory(root);
    assert.ok(screens.some((s) => s.route === "/" && s.headings.includes("Portal")));
    const invoice = entities.find((e) => e.name === "Invoice");
    const client = entities.find((e) => e.name === "Client");
    assert.ok(invoice?.fields.includes("number"));
    assert.ok(client?.fields.includes("email"));
  });
});
