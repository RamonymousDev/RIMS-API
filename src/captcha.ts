const CAPTCHA_PREFIX = "rims:cap:";
const CAPTCHA_TTL = 300; // 5 menit
const CAPTCHA_MAX_ATTEMPTS = 3;

export interface CaptchaData {
  answer: number;
  attempts: number;
  createdAt: number;
}

export interface CaptchaChallenge {
  captchaId: string;
  question: string;
  options: number[];
}

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

function randomId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function generateCaptcha(): CaptchaChallenge & { answer: number } {
  const a = Math.floor(Math.random() * 50) + 1;
  const b = Math.floor(Math.random() * 50) + 1;
  const answer = a + b;

  const wrongAnswers = new Set<number>();
  while (wrongAnswers.size < 3) {
    const offset = Math.floor(Math.random() * 21) - 10;
    const wrong = answer + offset;
    if (wrong !== answer && wrong > 0 && wrong <= 100) {
      wrongAnswers.add(wrong);
    }
  }

  const options = shuffle([answer, ...Array.from(wrongAnswers)]);
  const captchaId = randomId();

  return {
    captchaId,
    question: `Berapa hasil dari ${a} + ${b}?`,
    options,
    answer,
  };
}

export async function saveCaptcha(captchaId: string, answer: number): Promise<void> {
  const data: CaptchaData = { answer, attempts: 0, createdAt: Date.now() };
  await Bun.redis.set(`${CAPTCHA_PREFIX}${captchaId}`, JSON.stringify(data), "EX", CAPTCHA_TTL);
}

export async function validateCaptcha(
  captchaId: string,
  answer: number,
): Promise<{ valid: boolean; attemptsLeft: number; newCaptcha?: CaptchaChallenge & { answer: number } }> {
  const raw = await Bun.redis.get(`${CAPTCHA_PREFIX}${captchaId}`);
  if (!raw) {
    return { valid: false, attemptsLeft: 0, newCaptcha: generateCaptcha() };
  }

  let data: CaptchaData;
  try {
    data = JSON.parse(raw);
  } catch {
    await Bun.redis.del(`${CAPTCHA_PREFIX}${captchaId}`);
    return { valid: false, attemptsLeft: 0, newCaptcha: generateCaptcha() };
  }

  if (answer !== data.answer) {
    data.attempts += 1;

    if (data.attempts >= CAPTCHA_MAX_ATTEMPTS) {
      await Bun.redis.del(`${CAPTCHA_PREFIX}${captchaId}`);
      return { valid: false, attemptsLeft: 0, newCaptcha: generateCaptcha() };
    }

    await Bun.redis.set(`${CAPTCHA_PREFIX}${captchaId}`, JSON.stringify(data), "EX", CAPTCHA_TTL);
    return { valid: false, attemptsLeft: CAPTCHA_MAX_ATTEMPTS - data.attempts, newCaptcha: generateCaptcha() };
  }

  await Bun.redis.del(`${CAPTCHA_PREFIX}${captchaId}`);
  return { valid: true, attemptsLeft: CAPTCHA_MAX_ATTEMPTS };
}

export async function deleteCaptcha(captchaId: string): Promise<void> {
  await Bun.redis.del(`${CAPTCHA_PREFIX}${captchaId}`);
}
