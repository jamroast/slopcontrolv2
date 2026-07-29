import { Dashboard } from "./dashboard";

export default function HomePage() {
  return (
    <main>
      <h1>SlopControl v2</h1>
      <p>
        Planning-driven orchestration test UI. Server:{" "}
        {process.env.NEXT_PUBLIC_SLOPCONTROL_SERVER_URL ?? "http://localhost:3020"}
      </p>
      <Dashboard />
    </main>
  );
}
