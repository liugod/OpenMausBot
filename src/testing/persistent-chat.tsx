import { createRoot } from "react-dom/client";
import { StoreProvider, useStore } from "../state/store";
import { DesktopCapabilitiesProvider } from "../components/DesktopCapabilities";
import { ChatView } from "../components/ChatView";
import "../styles.css";
function Fixture() {
  const { state } = useStore();
  const bot = state.bots.find(item => item.name === "Isolated Chat Bot");
  return <div className="flex h-dvh flex-col bg-app text-ink">{bot ? <ChatView bot={bot} /> : <p>Loading fixture…</p>}</div>;
}
createRoot(document.getElementById("root")!).render(<StoreProvider><DesktopCapabilitiesProvider><Fixture /></DesktopCapabilitiesProvider></StoreProvider>);
