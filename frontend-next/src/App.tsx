import { BrowserRouter, Routes, Route, Navigate, useParams } from "react-router-dom";
import { AppShell } from "./app/AppShell";
import { ResolveClient } from "./app/ResolveClient";
import { Placeholder } from "./screens/Placeholder";
import { SCREENS } from "./app/screens";

// Picks the screen component for the current :view (falls back to the placeholder).
function ViewRouter() {
  const { view } = useParams();
  const Screen = (view && SCREENS[view]) || Placeholder;
  return <Screen />;
}

// Served under /next, so React Router uses that basename. URLs are addressable:
//   /next/c/:clientId/:view   (and /next/c/:clientId → brief)
export default function App() {
  return (
    <BrowserRouter basename="/next">
      <Routes>
        <Route path="/" element={<ResolveClient />} />
        <Route path="/c/:clientId" element={<AppShell />}>
          <Route index element={<Navigate to="brief" replace />} />
          <Route path=":view" element={<ViewRouter />} />
        </Route>
        <Route path="*" element={<ResolveClient />} />
      </Routes>
    </BrowserRouter>
  );
}
