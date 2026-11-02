import { createRoot } from "react-dom/client";
import { PersistentWorkPreview } from "../../src/components/PersistentWorkPreview";
import "../../src/styles.css";

createRoot(document.getElementById("root")!).render(<main className="min-h-screen bg-app p-6"><div className="w-[320px] max-w-full"><PersistentWorkPreview /></div></main>);
if (new URLSearchParams(location.search).has("fixture-expand")) {
  const timer = setInterval(() => {
    const button = document.querySelector<HTMLButtonElement>("[data-persistent-work-preview] button");
    if (button) { clearInterval(timer); button.click(); }
  }, 50);
  setTimeout(() => clearInterval(timer), 5000);
}
