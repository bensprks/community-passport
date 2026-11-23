/**
 * The smallest stand-in for a member's browser: it keeps cookies and follows redirects, and stops when a redirect
 * leaves the Passport, the way a real browser would arrive back at the club.
 */
export class Browser {
  readonly #origin: string;
  readonly #cookies = new Map<string, string>();

  constructor(origin: string) {
    this.#origin = origin;
  }

  hasCookie(name: string): boolean {
    return this.#cookies.has(name);
  }

  async #send(path: string, init: RequestInit = {}): Promise<Response> {
    const cookie = [...this.#cookies].map(([name, value]) => `${name}=${value}`).join("; ");
    const response = await fetch(new URL(path, this.#origin), {
      ...init,
      redirect: "manual",
      headers: { ...init.headers, cookie },
    });
    for (const header of response.headers.getSetCookie()) {
      const [pair = "", ...attributes] = header.split(";");
      const name = pair.slice(0, pair.indexOf("=")).trim();
      const expired = attributes.some((attribute) => /^\s*(max-age=0|expires=thu, 01 jan 1970)/i.test(attribute));
      if (expired) this.#cookies.delete(name);
      else this.#cookies.set(name, pair.slice(pair.indexOf("=") + 1).trim());
    }
    return response;
  }

  /** Follows redirects. Returns the page it lands on, or the URL outside the Passport it was sent to. */
  async #follow(response: Response): Promise<{ status: number; body: string; leftFor?: URL }> {
    for (let hops = 0; hops < 10; hops++) {
      const location = response.headers.get("location");
      if (response.status < 300 || response.status >= 400 || !location) {
        return { status: response.status, body: await response.text() };
      }
      const next = new URL(location, this.#origin);
      if (next.origin !== this.#origin) return { status: response.status, body: "", leftFor: next };
      response = await this.#send(next.pathname + next.search);
    }
    throw new Error("too many redirects");
  }

  async get(path: string) {
    return this.#follow(await this.#send(path));
  }

  async postForm(path: string, fields: Record<string, string> = {}) {
    return this.#follow(
      await this.#send(path, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(fields),
      }),
    );
  }

  async getJson<T>(path: string): Promise<T> {
    return (await this.#send(path, { headers: { accept: "application/json" } })).json() as Promise<T>;
  }

  async postJson<T>(path: string, body: unknown): Promise<{ status: number; body: T }> {
    const response = await this.#send(path, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: (await response.json()) as T };
  }
}
