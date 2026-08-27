import { apiRequest } from "./client.js";

export const adminSignIn = (credentials) => apiRequest("/api/admin-auth/login", { method: "POST", body: credentials });
export const adminMe = () => apiRequest("/api/admin-auth/me");
export const adminSignOut = () => apiRequest("/api/admin-auth/logout", { method: "POST" });
