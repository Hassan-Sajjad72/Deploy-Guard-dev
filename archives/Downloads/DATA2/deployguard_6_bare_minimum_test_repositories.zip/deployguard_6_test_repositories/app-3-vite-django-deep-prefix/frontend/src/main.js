const base = import.meta.env.VITE_API_BASE_URL || "/__deployguard/backend";

fetch(`${base}/v1/engine/status`)
  .then((response) => response.json())
  .then((data) => {
    document.querySelector("#app").textContent = JSON.stringify(data);
  });
