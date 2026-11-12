import { treaty } from "@elysiajs/eden";
import type { App } from "@selects/server";

/** Typed client for the Selects API. Types are inferred from the server's routes. */
export const api = treaty<App>(window.location.origin).api;
