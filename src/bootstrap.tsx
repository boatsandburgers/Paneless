import { createRoot } from "react-dom/client";
import App from "./main";

const root = createRoot(document.getElementById("root")!);
root.render(<App />);
if (import.meta.hot) import.meta.hot.dispose(() => root.unmount());
