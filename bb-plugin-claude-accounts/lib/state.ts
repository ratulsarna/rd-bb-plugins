import type { Login } from "../contract";
export const isActive = (login: Login | null) =>
  login !== null &&
  ["starting", "awaiting-code", "verifying"].includes(login.phase);
