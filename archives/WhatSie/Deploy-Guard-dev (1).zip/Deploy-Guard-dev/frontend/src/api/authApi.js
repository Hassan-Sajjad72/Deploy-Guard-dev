import { apiRequest, getApiBaseUrl } from "./client.js";

export function signupUser(data) {
  return apiRequest("/api/auth/signup", {
    method: "POST",
    body: data,
  });
}

export function loginUser(data) {
  return apiRequest("/api/auth/login", {
    method: "POST",
    body: data,
  });
}

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

export function redirectToGithub() {
  window.location.assign(getGithubAuthUrl());
}
