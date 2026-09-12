export async function api<T = unknown>(
  url: string,
  method = "GET",
  body?: unknown,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api${url}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        "X-Orbit-Client": "local",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    throw new Error(
      "Orbit server is not reachable. Check that it is still running.",
    );
  }
  const data: unknown = await response.json().catch(() => undefined);
  if (!response.ok)
    throw new Error(
      data &&
        typeof data === "object" &&
        "error" in data &&
        typeof data.error === "string"
        ? data.error
        : `Request failed (${response.status}).`,
    );
  return data as T;
}
export const agentUrl = (project: string, agent: string) =>
  `/projects/${project}/agents/${agent}`;
