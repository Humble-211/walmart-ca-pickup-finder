import { describe, it, expect, vi } from "vitest";
import { sendMessage } from "../src/lib/telegram.js";

const okFetch = () => vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ ok: true, result: {} }) }));

describe("sendMessage", () => {
  it("posts the text to the bot's sendMessage endpoint", async () => {
    const fetch = okFetch();
    const res = await sendMessage({ token: "123:ABC", chatId: "555", text: "hello" }, { fetch });
    expect(res).toEqual({ ok: true });
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe("https://api.telegram.org/bot123:ABC/sendMessage");
    expect(init.method).toBe("POST");
    expect(init.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(init.body)).toEqual({ chat_id: "555", text: "hello", disable_web_page_preview: false });
  });

  it("reports telegram's own description when the API refuses", async () => {
    const fetch = vi.fn(async () => ({ ok: false, status: 400, json: async () => ({ ok: false, description: "chat not found" }) }));
    expect(await sendMessage({ token: "t", chatId: "c", text: "x" }, { fetch })).toEqual({ ok: false, error: "chat not found" });
  });

  it("reports a body that says ok: false even on HTTP 200", async () => {
    const fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ ok: false, description: "bot was blocked by the user" }) }));
    expect(await sendMessage({ token: "t", chatId: "c", text: "x" }, { fetch })).toEqual({ ok: false, error: "bot was blocked by the user" });
  });

  it("turns a network failure into a result instead of throwing", async () => {
    const fetch = vi.fn(async () => { throw new Error("offline"); });
    expect(await sendMessage({ token: "t", chatId: "c", text: "x" }, { fetch })).toEqual({ ok: false, error: "offline" });
  });

  it("refuses to send without a token or chat id", async () => {
    const fetch = okFetch();
    expect(await sendMessage({ token: "", chatId: "c", text: "x" }, { fetch })).toMatchObject({ ok: false });
    expect(await sendMessage({ token: "t", chatId: "", text: "x" }, { fetch })).toMatchObject({ ok: false });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("falls back to a status line when telegram sends no description", async () => {
    const fetch = vi.fn(async () => ({ ok: false, status: 502, json: async () => { throw new Error("not json"); } }));
    expect(await sendMessage({ token: "t", chatId: "c", text: "x" }, { fetch })).toEqual({ ok: false, error: "Telegram returned HTTP 502." });
  });
});

// A real user pasted the number in front of the colon in their bot token as the
// chat id. Telegram answered "Forbidden: the bot can't send messages to the bot",
// which is true and tells nobody what to do. The token's prefix IS the bot's own
// id, so this is checkable before the request.
describe("sendMessage credential checks", () => {
  const okFetch = () => vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) }));

  it("names the mistake when the chat id is the bot's own id", async () => {
    const fetch = okFetch();
    const res = await sendMessage({ token: "123456789:AAHxyz", chatId: "123456789", text: "x" }, { fetch });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/bot's own id/i);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("tolerates whitespace around the pasted values when spotting it", async () => {
    const fetch = okFetch();
    expect((await sendMessage({ token: " 123456789:AAHxyz ", chatId: " 123456789 ", text: "x" }, { fetch })).ok).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("lets a real chat id through, including a negative group id", async () => {
    for (const chatId of ["987654321", "-1001234567890"]) {
      const fetch = okFetch();
      expect(await sendMessage({ token: "123456789:AAHxyz", chatId, text: "x" }, { fetch })).toEqual({ ok: true });
      expect(fetch).toHaveBeenCalledTimes(1);
    }
  });

  it("does not trip on a token with no colon", async () => {
    const fetch = okFetch();
    expect(await sendMessage({ token: "nocolon", chatId: "nocolon", text: "x" }, { fetch })).toEqual({ ok: true });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
