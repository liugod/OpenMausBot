import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { PersistentWorkChat } from "../components/PersistentWorkChat";
import "../styles.css";

function Fixture() {
  const [botId, setBotId] = useState("");
  useEffect(() => { void fetch("/api/bots?messages=0").then(response => response.json()).then((data: { bots: { id: string; chiefOfStaff?: boolean }[] }) => {
    setBotId(data.bots.find(bot => bot.chiefOfStaff)?.id ?? "");
  }); }, []);
  return botId ? <PersistentWorkChat botId={botId} panel /> : <p>Loading</p>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
