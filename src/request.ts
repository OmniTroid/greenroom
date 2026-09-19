/** GET a URL as text. Rejects on non-2xx or network error. */
export function request(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.responseType = "text";
    xhr.addEventListener("error", () => reject(new Error(`Request for ${url} failed`)));
    xhr.addEventListener("load", () => {
      if (xhr.status < 200 || xhr.status >= 300) {
        reject(new Error(`Request for ${url} failed with status ${xhr.status}`));
      } else {
        resolve(xhr.response);
      }
    });
    xhr.open("GET", url, true);
    xhr.send();
  });
}

/**
 * Probes whether an image URL loads (no-CORS via <img>), for resolving 2D
 * sprite candidates across extensions. Cached per URL.
 */
const imageProbeCache = new Map<string, Promise<boolean>>();
export function imageExists(url: string): Promise<boolean> {
  const cached = imageProbeCache.get(url);
  if (cached) return cached;
  const promise = new Promise<boolean>((resolve) => {
    const img = new Image();
    img.onload = () => resolve(true);
    img.onerror = () => resolve(false);
    img.src = url;
  });
  imageProbeCache.set(url, promise);
  return promise;
}
