import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter } from "react-router-dom";

import { App } from "./app/App";
import { queryClient } from "./app/queryClient";
import { initializeTheme } from "./app/theme";
import "./index.css";

console.info(`Papertrail frontend starting (version=${import.meta.env.VITE_APP_VERSION ?? "dev"})`);

initializeTheme();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>
);
