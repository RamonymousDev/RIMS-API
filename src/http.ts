export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Kolom UUID yang menerima input bebas akan melempar error DB (500) — cek dulu, balas 404. */
export function assertUuid(ref: string, notFoundMessage: string): void {
  if (!UUID_RE.test(ref)) throw new ApiError(404, notFoundMessage);
}
