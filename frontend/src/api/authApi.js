import { apiRequest, getApiBaseUrl } from "./client.js";

export function getCurrentUser() {
  return apiRequest("/api/auth/me");
}

export function logoutUser() {
  return apiRequest("/api/auth/logout", {
    method: "POST",
  });
}

export function getGithubAuthUrl() {
  return `${getApiBaseUrl()}/api/auth/github`;
}
