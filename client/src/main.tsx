import { createRoot } from "react-dom/client";
import "./core/theme";
import "./styles/arc.css";
import "./styles/visor.css";
import "./styles/arc2.css";
// Services start here, once, before any UI renders.
import "./core/services";
import { App } from "./ui/App";

createRoot(document.getElementById("root")!).render(<App />);
